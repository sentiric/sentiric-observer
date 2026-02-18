use std::time::{Duration, Instant};
use pcap::{Capture, Device};
use tokio::sync::broadcast::Sender;
use tracing::{info, warn};
use serde_json::json;
use crate::model::{OtelLogRecord, OtelResource};

pub fn spawn_sniffer_task(tx: Sender<String>, host_name: String) {
    info!("📡 Akıllı Metrik Toplayıcı ve Sniffer motoru başlatılıyor...");

    tokio::task::spawn_blocking(move || {
        let device = match Device::lookup().ok().flatten() {
            Some(d) => d,
            None => { warn!("Sniffer: Ağ arayüzü bulunamadı."); return; }
        };
        
        info!("Sniffer: '{}' arayüzü dinleniyor.", device.name);
        
        let mut cap = Capture::from_device(device).unwrap().promisc(true).snaplen(512).timeout(1000).open().unwrap();
        let filter = "udp and (port 5060 or portrange 13000-13100 or portrange 30000-30100 or portrange 50000-50100)";
        cap.filter(filter, true).unwrap();

        let mut last_metric_update = Instant::now();
        let mut pps_counter = 0;
        let mut total_bytes = 0;

        while let Ok(packet) = cap.next_packet() {
            let payload_str = String::from_utf8_lossy(packet.data);
            
            if payload_str.contains("SIP/2.0") {
                send_sip_event(&tx, &host_name, payload_str.trim().to_string(), packet.header.len);
            } else {
                pps_counter += 1;
                total_bytes += packet.header.len as u64;
            }

            // Her saniyede bir, toplanan RTP metriklerini tek bir mesajda gönder
            if last_metric_update.elapsed() >= Duration::from_secs(1) {
                if pps_counter > 0 {
                    send_rtp_metric(&tx, &host_name, pps_counter, total_bytes);
                }
                pps_counter = 0;
                total_bytes = 0;
                last_metric_update = Instant::now();
            }
        }
    });
}

fn send_sip_event(tx: &Sender<String>, host: &str, body: String, len: u32) {
    let record = OtelLogRecord {
        timestamp: chrono::Utc::now().to_rfc3339(),
        severity_text: "INFO".into(),
        body,
        resource: OtelResource { service_name: "network-sniffer".into(), host_name: host.to_string() },
        attributes: json!({ "event": "SIP_TRAFFIC", "packet_len": len }),
    };
    if let Ok(json_str) = serde_json::to_string(&record) { let _ = tx.send(json_str); }
}

fn send_rtp_metric(tx: &Sender<String>, host: &str, pps: u32, bytes: u64) {
    let record = OtelLogRecord {
        timestamp: chrono::Utc::now().to_rfc3339(),
        severity_text: "DEBUG".into(),
        body: format!("📈 Media Flow Metrics: {} pps, {} KB/s", pps, bytes / 1024),
        resource: OtelResource { service_name: "network-sniffer".into(), host_name: host.to_string() },
        attributes: json!({ "event": "RTP_METRIC", "pps": pps, "total_bytes": bytes }),
    };
    if let Ok(json_str) = serde_json::to_string(&record) { let _ = tx.send(json_str); }
}
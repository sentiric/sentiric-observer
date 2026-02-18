use pcap::{Capture, Device};
use tokio::sync::broadcast::Sender;
use tracing::{info, warn};
use serde_json::json;
use crate::model::{OtelLogRecord, OtelResource};

pub struct RtpSniffer {
    tx: Sender<String>,
    host_name: String,
}

impl RtpSniffer {
    pub fn new(tx: Sender<String>, host_name: String) -> Self {
        Self { tx, host_name }
    }

    pub async fn run(&self) {
        let host = self.host_name.clone();
        let tx = self.tx.clone();

        tokio::task::spawn_blocking(move || {
            let device = match Device::lookup() {
                Ok(Some(d)) => d,
                _ => {
                    warn!("📡 Sniffer: Uygun ağ arayüzü bulunamadı.");
                    return;
                }
            };

            info!("📡 Sniffer aktif: {} arayüzünde süzme başlıyor...", device.name);

            let mut cap = Capture::from_device(device)
                .unwrap()
                .promisc(true)
                .snaplen(128) 
                .timeout(10)
                .open()
                .unwrap();

            // Kritik portları filtrele
            let filter = "udp portrange 13000-13100 or portrange 30000-30100 or portrange 50000-50100 or port 5060";
            if let Err(e) = cap.filter(filter, true) {
                warn!("📡 Sniffer BPF Filtre hatası: {}", e);
                return;
            }

            let mut packet_count: u64 = 0;

            while let Ok(packet) = cap.next_packet() {
                packet_count += 1;

                // Payload analizi
                let raw_data = packet.data;
                let body_str = String::from_utf8_lossy(raw_data);
                
                let is_sip = body_str.contains("SIP/2.0") || body_str.contains("INVITE") || body_str.contains("CANCEL");
                
                // SIP ise her zaman gönder, RTP ise her 20 pakette bir örnekle (Performance Sampling)
                if is_sip || packet_count % 20 == 0 {
                    let record = OtelLogRecord {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        severity_text: if is_sip { "INFO".into() } else { "DEBUG".into() },
                        body: if is_sip { body_str.trim().to_string() } else { "📡 RTP Flow Active".into() },
                        resource: OtelResource {
                            service_name: "network-sniffer".into(),
                            host_name: host.clone(),
                        },
                        attributes: json!({
                            "event": if is_sip { "SIP_TRAFFIC" } else { "RTP_FLOW" },
                            "packet_len": packet.header.len,
                            "is_sample": !is_sip,
                            "total_packets_seen": packet_count
                        }),
                    };

                    if let Ok(json_str) = serde_json::to_string(&record) {
                        let _ = tx.send(json_str);
                    }
                }
            }
        });
    }
}
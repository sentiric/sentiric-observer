use crate::model::{EventType, OtelLogRecord};
use crate::engine::aggregator::Aggregator;
use pcap::{Capture, Device};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::Sender;
use tracing::{error, info, warn};

pub struct NetworkSniffer {
    tx: Sender<OtelLogRecord>,
    node_name: String,
    running: Arc<AtomicBool>,
}

impl NetworkSniffer {
    pub fn new(tx: Sender<OtelLogRecord>, node_name: String) -> Self {
        Self {
            tx,
            node_name,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self) {
        if self.running.load(Ordering::SeqCst) {
            warn!("Sniffer zaten çalışıyor.");
            return;
        }

        self.running.store(true, Ordering::SeqCst);
        let running_flag = self.running.clone();
        let tx = self.tx.clone();
        let node = self.node_name.clone();

        tokio::task::spawn_blocking(move || {
            info!("📡 Network Sniffer Başlatılıyor...");
            
            let device = match Device::lookup().ok().flatten() {
                Some(d) => d,
                None => {
                    error!("Sniffer: Uygun ağ arayüzü bulunamadı.");
                    return;
                }
            };

            info!("Sniffer: '{}' arayüzü dinleniyor.", device.name);

            let cap = match Capture::from_device(device)  {
                Ok(c) => c.promisc(true).snaplen(1500).timeout(1000).open(),
                Err(e) => {
                    error!("Sniffer başlatılamadı: {}", e);
                    return;
                }
            };

            let mut cap = match cap {
                Ok(c) => c,
                Err(_) => return,
            };

            if let Err(e) = cap.filter("udp port 5060 or udp portrange 10000-60000", true) {
                error!("BPF Filtre hatası: {}", e);
                return;
            }

            let mut last_metric_time = Instant::now();
            let mut pps = 0;
            let mut bytes = 0;

            while running_flag.load(Ordering::SeqCst) {
                if let Ok(packet) = cap.next_packet() {
                    let len = packet.header.len;
                    let payload = packet.data;
                    let payload_str = String::from_utf8_lossy(payload);

                    if payload_str.contains("SIP/2.0") {
                        let record = OtelLogRecord {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            level: "INFO".into(),
                            service: "network-sniffer".into(),
                            node: node.clone(),
                            trace_id: None,
                            event_type: EventType::SipPacket,
                            body: extract_sip_method(&payload_str),
                            attributes: serde_json::json!({
                                "packet_len": len,
                                "raw_sip": payload_str.trim()
                            }),
                        };
                        // [AGGREGATOR ENTEGRASYONU]
                        let processed = Aggregator::process(record);
                        let _ = tx.send(processed);
                    } else {
                        pps += 1;
                        bytes += len as u64;
                    }

                    if last_metric_time.elapsed() >= Duration::from_secs(1) {
                        if pps > 0 {
                            let record = OtelLogRecord {
                                timestamp: chrono::Utc::now().to_rfc3339(),
                                level: "DEBUG".into(),
                                service: "network-sniffer".into(),
                                node: node.clone(),
                                trace_id: None,
                                event_type: EventType::RtpMetric,
                                body: format!("RTP Flow: {} pps", pps),
                                attributes: serde_json::json!({
                                    "pps": pps,
                                    "bandwidth_kbps": (bytes * 8) / 1024
                                }),
                            };
                            // Metrikler genelde aggregator gerektirmez ama standart için geçirelim
                            let processed = Aggregator::process(record);
                            let _ = tx.send(processed);
                        }
                        pps = 0;
                        bytes = 0;
                        last_metric_time = Instant::now();
                    }
                }
            }
            warn!("🛑 Sniffer Durduruldu.");
        });
    }

    #[allow(dead_code)]
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

fn extract_sip_method(payload: &std::borrow::Cow<str>) -> String {
    if let Some(line) = payload.lines().next() {
        return line.to_string();
    }
    "SIP PACKET".to_string()
}
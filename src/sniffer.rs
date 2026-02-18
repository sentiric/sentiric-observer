use pcap::{Capture, Device};
use std::sync::Arc;
use tokio::sync::broadcast::Sender;
use tracing::{info, error};
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
            let device = Device::lookup().unwrap().expect("No device found");
            info!("📡 Sniffer aktif: {} üzerinde dinleniyor...", device.name);

            let mut cap = Capture::from_device(device)
                .unwrap()
                .promisc(true)
                .snaplen(64) // Sadece headerlar için küçük tutuyoruz (Performans!)
                .timeout(1000)
                .open()
                .unwrap();

            // Sadece RTP port aralıklarını filtrele (GCP ve Core)
            let filter = "udp portrange 30000-30100 or portrange 50000-50100";
            cap.filter(filter, true).unwrap();

            while let Ok(packet) = cap.next_packet() {
                // Her paket için log üretmek yerine her 50 pakette bir "Flow OK" bas
                // (Burada gerçek zamanlı PPS hesabı da yapılabilir)
                let record = OtelLogRecord {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    severity_text: "DEBUG".into(),
                    body: "📡 RTP Traffic Detected".into(),
                    resource: OtelResource {
                        service_name: "network-sniffer".into(),
                        host_name: host.clone(),
                    },
                    attributes: Some(json!({
                        "event": "RTP_FLOW",
                        "packet_len": packet.header.len,
                        "flow_status": "ACTIVE"
                    })),
                };

                if let Ok(json_str) = serde_json::to_string(&record) {
                    let _ = tx.send(json_str);
                }
            }
        });
    }
}
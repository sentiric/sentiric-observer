use pcap::{Capture, Device};
// [FIX] unused Arc kaldırıldı.
use tokio::sync::broadcast::Sender;
use tracing::info; // [FIX] unused error kaldırıldı.
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
                .snaplen(64)
                .timeout(1000)
                .open()
                .unwrap();

            let filter = "udp portrange 30000-30100 or portrange 50000-50100";
            cap.filter(filter, true).unwrap();

            while let Ok(packet) = cap.next_packet() {
                let record = OtelLogRecord {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    severity_text: "DEBUG".into(),
                    body: "📡 RTP Traffic Detected".into(),
                    resource: OtelResource {
                        service_name: "network-sniffer".into(),
                        host_name: host.clone(),
                    },
                    // [FIX]: attributes artık Value bekliyor, Some(Value) değil.
                    attributes: json!({
                        "event": "RTP_FLOW",
                        "packet_len": packet.header.len,
                        "flow_status": "ACTIVE"
                    }),
                };

                if let Ok(json_str) = serde_json::to_string(&record) {
                    let _ = tx.send(json_str);
                }
            }
        });
    }
}
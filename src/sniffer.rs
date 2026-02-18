use pcap::{Capture, Device};
use tokio::sync::broadcast::Sender;
use tracing::{info, warn};
use serde_json::json;
use crate::model::{OtelLogRecord, OtelResource};

/// Bu fonksiyon, çağrıldığında kendi kendini yöneten, 'static' ömre sahip
/// bir arka plan görevi (task) başlatır.
pub fn spawn_sniffer_task(tx: Sender<String>, host_name: String) {
    info!("📡 Akıllı Sniffer motoru arka planda başlatılıyor...");

    // spawn_blocking, pcap gibi senkron ve potansiyel olarak engelleyici I/O
    // işlemleri için en doğru yöntemdir.
    tokio::task::spawn_blocking(move || {
        // 'move' anahtar kelimesi, tx ve host_name'in sahipliğini bu thread'e kalıcı olarak taşır.
        // Bu, 'E0521' lifetime hatasını kökünden çözer.

        let device = match Device::lookup() {
            Ok(Some(d)) => d,
            _ => {
                warn!("Sniffer Başarısız: Dinlenecek ağ arayüzü bulunamadı. Sniffer devre dışı.");
                return;
            }
        };

        info!("Sniffer Aktif: '{}' arayüzü dinleniyor.", device.name);

        let mut cap = match Capture::from_device(device)
            .unwrap()
            .promisc(true)
            .snaplen(512) // SIP mesajının tamamını yakalamak için yeterli
            .timeout(10) // Milisaniye cinsinden, hızlı tepki için
            .open()
        {
            Ok(c) => c,
            Err(e) => {
                warn!("Sniffer Başarısız: Arayüz açılamadı: {}. Yetki (root/cap_net_raw) eksik olabilir.", e);
                return;
            }
        };

        // BPF (Berkeley Packet Filter) ile sadece ilgili trafiği yakala
        let filter = "udp and (port 5060 or portrange 13000-13100 or portrange 30000-30100 or portrange 50000-50100)";
        if let Err(e) = cap.filter(filter, true) {
            warn!("Sniffer BPF Filtre Hatası: {}. Filtre geçersiz.", e);
        }

        let mut packet_counter: u64 = 0;
        while let Ok(packet) = cap.next_packet() {
            packet_counter += 1;
            
            // Paketin içeriğini güvenli bir şekilde metne çevir
            let payload_str = String::from_utf8_lossy(packet.data);
            let is_sip = payload_str.contains("SIP/2.0");

            if is_sip {
                // SIP paketleri kritiktir, her zaman gönderilir
                send_event(&tx, &host_name, "SIP_TRAFFIC", payload_str.trim().to_string(), packet.header.len);
            } else if packet_counter % 25 == 0 { 
                // Diğer paketler (muhtemelen RTP) performansı korumak için örneklenir
                send_event(&tx, &host_name, "RTP_FLOW", "🟢 Media Payload Sample".into(), packet.header.len);
            }
        }
    });
}

fn send_event(tx: &Sender<String>, host: &str, event_type: &str, body: String, len: u32) {
    let record = OtelLogRecord {
        timestamp: chrono::Utc::now().to_rfc3339(),
        severity_text: if event_type == "SIP_TRAFFIC" { "INFO".into() } else { "DEBUG".into() },
        body,
        resource: OtelResource {
            service_name: "network-sniffer".into(),
            host_name: host.to_string(),
        },
        attributes: json!({ "event": event_type, "packet_len": len }),
    };
    if let Ok(json_str) = serde_json::to_string(&record) {
        let _ = tx.send(json_str);
    }
}
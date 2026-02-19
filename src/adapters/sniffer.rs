use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device};
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;
use tracing::{error, info, warn};

/// Ağ trafiğini dinleyen ve SUTS formatına çeviren adaptör.
pub struct NetworkSniffer {
    interface: String,
    filter: String,
    tx: Sender<LogRecord>,
    node_name: String,
}

impl NetworkSniffer {
    /// Yeni bir Sniffer örneği oluşturur.
    /// interface: "eth0", "lo" veya "any" (Linux only)
    /// filter: BPF formatında (örn: "port 5060")
    pub fn new(interface: &str, filter: &str, tx: Sender<LogRecord>, node_name: String) -> Self {
        Self {
            interface: interface.to_string(),
            filter: filter.to_string(),
            tx,
            node_name,
        }
    }

    /// Ham paketi analiz et ve LogRecord'a çevir (Telekom Odaklı Analiz)
    fn process_packet(&self, packet: pcap::Packet) -> Option<LogRecord> {
        // 1. Payload'ı UTF-8 String'e çevirmeyi dene (SIP Text Based protokolüdür)
        let data_str = match std::str::from_utf8(packet.data) {
            Ok(s) => s,
            Err(_) => return None, // Binary veri (RTP, SRTP) şimdilik atlanıyor (Faz 2'de eklenecek)
        };

        // 2. Basit SIP İmzası Kontrolü (Method veya SIP Versiyonu)
        // Bu kontrol CPU tasarrufu sağlar, gereksiz HTTP paketlerini eler.
        if !data_str.contains("SIP/2.0") {
            return None;
        }

        // 3. Basit Parsing (Regex kullanmadan, hızlı split ile)
        let method = data_str.split_whitespace().next().unwrap_or("UNKNOWN");
        
        // Call-ID yakalama (Satır satır gezerek)
        let call_id = data_str.lines()
            .find(|l| l.to_lowercase().starts_with("call-id:"))
            .map(|l| l.split(':').nth(1).unwrap_or("").trim())
            .unwrap_or("unknown");

        // 4. Attributes Zenginleştirme
        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), serde_json::Value::from(packet.header.len));
        attributes.insert("net.interface".to_string(), serde_json::Value::String(self.interface.clone()));
        attributes.insert("sip.method".to_string(), serde_json::Value::String(method.to_string()));
        attributes.insert("sip.call_id".to_string(), serde_json::Value::String(call_id.to_string()));

        // 5. SUTS v4.0 Log Kaydı Oluştur
        Some(LogRecord {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: "INFO".to_string(), // Paket yakalamak bir "Bilgi"dir, hata değil.
            tenant_id: "default".to_string(),
            resource: ResourceContext {
                service_name: "network-sniffer".to_string(),
                service_version: "1.0.0".to_string(),
                service_env: "production".to_string(),
                host_name: Some(self.node_name.clone()),
            },
            trace_id: None, // Gelecekte Call-ID -> Trace-ID mapping yapılacak
            span_id: None,
            event: "SIP_PACKET".to_string(),
            message: format!("SIP {} Packet captured on {}", method, self.interface),
            attributes,
        })
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!("🕸️ Network Sniffer Başlatılıyor: Interface='{}', Filter='{}'", self.interface, self.filter);

        // 1. Cihazı Bul (Auto-Discovery)
        let device_name = if self.interface == "any" {
            // Linux'ta 'any' pseudo-device tüm arayüzleri dinler
            "any".to_string()
        } else {
            // Belirtilen arayüzü bul
            let dev = Device::list()?.into_iter()
                .find(|d| d.name == self.interface)
                .ok_or_else(|| anyhow::anyhow!("Arayüz bulunamadı: {}", self.interface))?;
            dev.name
        };

        info!("🕸️ Aktif Dinleme Modu: {} (Promiscuous)", device_name);

        // 2. Capture Ayarları (Kernel Seviyesi)
        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error")?
            .promisc(true)      // Sadece bize gelen değil, tüm paketleri al
            .snaplen(65535)     // Paketin tamamını al (MTU limit)
            .timeout(1000)      // 1 sn timeout (Loop'u kilitlenmekten korur)
            .open()
            .context("Pcap Open Error (Root yetkisi var mı?)")?;

        // 3. BPF Filtresini Uygula (Kernel tarafında filtreleme - Performans için kritik)
        cap.filter(&self.filter, true).context("BPF Filter Error")?;

        // 4. Veri Döngüsü (Blocking Operation)
        // Pcap kütüphanesi 'blocking' çalışır. Bu yüzden ana async runtime'ı (Tokio)
        // kilitlememek için bu işlemi `spawn_blocking` ile ayrı bir OS thread'ine atıyoruz.
        
        let tx_clone = self.tx.clone();
        let sniffer_logic = NetworkSniffer {
            interface: self.interface.clone(),
            filter: self.filter.clone(),
            tx: self.tx.clone(),
            node_name: self.node_name.clone(),
        };

        // Bu thread sonsuza kadar döner
        tokio::task::spawn_blocking(move || {
            loop {
                match cap.next_packet() {
                    Ok(packet) => {
                        // Paketi işle
                        if let Some(log) = sniffer_logic.process_packet(packet) {
                            // Async kanala blocking send ile gönder
                            if let Err(e) = tx_clone.blocking_send(log) {
                                error!("Sniffer kanal hatası (Pipeline kapalı): {}", e);
                                break; // Kanal kapandıysa thread'i öldür
                            }
                        }
                    },
                    Err(pcap::Error::TimeoutExpired) => {
                        // Normal durum, döngüye devam et
                        continue;
                    },
                    Err(e) => {
                        // Kritik olmayan hatalarda (Buffer full vb.) log bas ve devam et
                        warn!("Pcap Packet Error: {}", e);
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        });

        Ok(())
    }
}
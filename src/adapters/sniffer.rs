use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device};
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;
use tracing::{error, info, warn};

pub struct NetworkSniffer {
    interface: String,
    filter: String,
    tx: Sender<LogRecord>,
    node_name: String,
}

impl NetworkSniffer {
    pub fn new(interface: &str, filter: &str, tx: Sender<LogRecord>, node_name: String) -> Self {
        Self {
            interface: interface.to_string(),
            filter: filter.to_string(),
            tx,
            node_name,
        }
    }

    /// Ham paketi analiz et ve LogRecord'a çevir (Basitleştirilmiş SIP Analizi)
    fn process_packet(&self, packet: pcap::Packet) -> Option<LogRecord> {
        // Paket verisini string'e çevirmeyi dene (SIP metin tabanlıdır)
        let data = match std::str::from_utf8(packet.data) {
            Ok(s) => s,
            Err(_) => return None, // Binary veri (RTP vb.) şimdilik atlanıyor
        };

        // Sadece SIP metodlarını içeren paketleri al
        if !data.contains("SIP/2.0") {
            return None;
        }

        // Basit bir parsing (Method ve Call-ID bulma)
        let method = data.split_whitespace().next().unwrap_or("UNKNOWN");
        let call_id = data.lines()
            .find(|l| l.to_lowercase().starts_with("call-id:"))
            .map(|l| l.split(':').nth(1).unwrap_or("").trim())
            .unwrap_or("unknown");

        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), serde_json::Value::from(packet.header.len));
        attributes.insert("sip.method".to_string(), serde_json::Value::from(method));
        attributes.insert("sip.call_id".to_string(), serde_json::Value::from(call_id));

        Some(LogRecord {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: "INFO".to_string(),
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
            message: format!("SIP {} Packet captured", method),
            attributes,
        })
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!("🕸️ Network Sniffer Başlatılıyor: {} [{}]", self.interface, self.filter);

        // 1. Cihazı Bul
        let device = if self.interface == "any" {
            Device::lookup().context("Default device lookup failed")?
                .ok_or_else(|| anyhow::anyhow!("No active network device found"))?
        } else {
            Device::from(self.interface.as_str())
        };

        info!("🕸️ Dinlenen Arayüz: {:?}", device.name);

        // 2. Capture Başlat (Bloklayan işlem, thread içinde çalışmalı)
        // Pcap kütüphanesi senkron çalışır, bu yüzden blocking thread açıyoruz.
        let mut cap = Capture::from_device(device)?
            .promisc(true)
            .snaplen(65535)
            .timeout(1000) // 1 sn timeout
            .open()?;

        cap.filter(&self.filter, true)?;

        let tx = self.tx.clone();
        let sniffer = NetworkSniffer {
            interface: self.interface.clone(),
            filter: self.filter.clone(),
            tx,
            node_name: self.node_name.clone(),
        };

        // Blocking loop'u tokio::spawn_blocking ile değil,
        // ayrı bir thread ile yönetmek pcap için daha sağlıklıdır (packet drop önleme).
        tokio::task::spawn_blocking(move || {
            loop {
                match cap.next_packet() {
                    Ok(packet) => {
                        if let Some(log) = sniffer.process_packet(packet) {
                            // Async kanala blocking thread içinden göndermek için:
                            if let Err(e) = sniffer.tx.blocking_send(log) {
                                error!("Sniffer kanal hatası: {}", e);
                                break;
                            }
                        }
                    },
                    Err(pcap::Error::TimeoutExpired) => {
                        // Timeout normaldir, devam et
                        continue;
                    },
                    Err(e) => {
                        warn!("Pcap hatası: {}", e);
                        // Kritik hata değilse devam et
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        });

        Ok(())
    }
}
use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device};
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;
use tracing::{error, info};

pub struct NetworkSniffer {
    interface: String,
    filter: String,
    tx: Sender<LogRecord>,
    node_name: String,
}

impl NetworkSniffer {
    pub fn new(interface: &str, filter: &str, tx: Sender<LogRecord>, node_name: String) -> Self {
        // HATA DÜZELTME: BPF Filtresi "any" olamaz. Eğer "any" ise boş string (hepsi) yap.
        let safe_filter = if filter.trim() == "any" || filter.trim().is_empty() {
            "".to_string()
        } else {
            filter.to_string()
        };

        Self {
            interface: interface.to_string(),
            filter: safe_filter, // Düzeltilmiş filtreyi kullan
            tx,
            node_name,
        }
    }

    fn process_packet(&self, packet: pcap::Packet) -> Option<LogRecord> {
        let data_str = match std::str::from_utf8(packet.data) {
            Ok(s) => s,
            Err(_) => return None, 
        };

        if !data_str.contains("SIP/2.0") {
            return None;
        }

        let method = data_str.split_whitespace().next().unwrap_or("UNKNOWN");
        let call_id = data_str.lines()
            .find(|l| l.to_lowercase().starts_with("call-id:"))
            .map(|l| l.split(':').nth(1).unwrap_or("").trim())
            .unwrap_or("unknown");

        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), serde_json::Value::from(packet.header.len));
        attributes.insert("net.interface".to_string(), serde_json::Value::String(self.interface.clone()));
        attributes.insert("sip.method".to_string(), serde_json::Value::String(method.to_string()));
        attributes.insert("sip.call_id".to_string(), serde_json::Value::String(call_id.to_string()));

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
            trace_id: None,
            span_id: None,
            event: "SIP_PACKET".to_string(),
            message: format!("SIP {} captured on {}", method, self.interface),
            attributes,
        })
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!("🕸️ Sniffer Config: Interface='{}', Filter='{}'", self.interface, self.filter);

        let device_name = if self.interface == "any" {
            "any".to_string()
        } else {
            let dev = Device::list()?.into_iter()
                .find(|d| d.name == self.interface)
                .ok_or_else(|| anyhow::anyhow!("Arayüz bulunamadı: {}", self.interface))?;
            dev.name
        };

        // Capture Ayarları
        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error")?
            .promisc(true)
            .snaplen(65535)
            .timeout(500)
            .open()
            .context("Pcap Open Error (Root gerekli)")?;

        // Filtre Uygulama (Hata verirse logla ama çökme, filtre olmadan devam et)
        if !self.filter.is_empty() {
            if let Err(e) = cap.filter(&self.filter, true) {
                error!("❌ BPF Filter Error ('{}'): {}. Filtre devre dışı bırakıldı, tüm trafik dinleniyor.", self.filter, e);
            } else {
                info!("✅ BPF Filter Applied: '{}'", self.filter);
            }
        } else {
            info!("ℹ️ No BPF Filter applied (Promiscuous Mode)");
        }

        let tx_clone = self.tx.clone();
        let sniffer_logic = NetworkSniffer {
            interface: self.interface.clone(),
            filter: self.filter.clone(),
            tx: self.tx.clone(),
            node_name: self.node_name.clone(),
        };

        tokio::task::spawn_blocking(move || {
            let mut dropped_packets = 0;
            loop {
                match cap.next_packet() {
                    Ok(packet) => {
                        if let Some(log) = sniffer_logic.process_packet(packet) {
                            match tx_clone.try_send(log) {
                                Ok(_) => {
                                    if dropped_packets > 0 {
                                        info!("🕸️ Sniffer Recovered ({} dropped).", dropped_packets);
                                        dropped_packets = 0;
                                    }
                                },
                                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                    dropped_packets += 1;
                                },
                                Err(_) => break,
                            }
                        }
                    },
                    Err(pcap::Error::TimeoutExpired) => continue,
                    Err(_) => continue,
                }
            }
        });

        Ok(())
    }
}
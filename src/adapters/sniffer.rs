use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device};
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;
use tracing::{error, info, warn, debug};

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

    fn process_packet(&self, packet: pcap::Packet) -> Option<LogRecord> {
        // Hızlı UTF-8 kontrolü
        let data_str = match std::str::from_utf8(packet.data) {
            Ok(s) => s,
            Err(_) => return None, 
        };

        // Sadece SIP/2.0 içeren paketleri al (Heuristic Filter)
        if !data_str.contains("SIP/2.0") {
            return None;
        }

        let method = data_str.split_whitespace().next().unwrap_or("UNKNOWN");
        
        // Hızlı Call-ID Extraction
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
        info!("🕸️ Sniffer: Interface='{}', Filter='{}'", self.interface, self.filter);

        let device_name = if self.interface == "any" {
            "any".to_string()
        } else {
            let dev = Device::list()?.into_iter()
                .find(|d| d.name == self.interface)
                .ok_or_else(|| anyhow::anyhow!("Arayüz bulunamadı: {}", self.interface))?;
            dev.name
        };

        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error")?
            .promisc(true)
            .snaplen(65535)
            .timeout(500) // Timeout'u düşürdük, daha responsive olsun
            .open()
            .context("Pcap Open Error (Root gerekli)")?;

        cap.filter(&self.filter, true).context("BPF Filter Error")?;

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
                            // KRİTİK DEĞİŞİKLİK: try_send kullanıyoruz.
                            // Eğer kanal doluysa (consumer yavaşsa), paketi düşürüp devam ediyoruz.
                            // Bu sayede sniffer thread'i asla bloklanmıyor.
                            match tx_clone.try_send(log) {
                                Ok(_) => {
                                    if dropped_packets > 0 {
                                        warn!("🕸️ Sniffer Recovered: {} packets were dropped due to congestion.", dropped_packets);
                                        dropped_packets = 0;
                                    }
                                },
                                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                    dropped_packets += 1;
                                    if dropped_packets % 100 == 0 {
                                        warn!("⚠️ Backpressure! Dropped {} packets so far.", dropped_packets);
                                    }
                                },
                                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                    error!("❌ Sniffer Channel Closed. Stopping thread.");
                                    break;
                                }
                            }
                        }
                    },
                    Err(pcap::Error::TimeoutExpired) => continue,
                    Err(e) => {
                        debug!("Pcap Error: {}", e);
                    }
                }
            }
        });

        Ok(())
    }
}
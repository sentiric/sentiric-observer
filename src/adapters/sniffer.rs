use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device, Linktype};
use serde_json::Value;
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
        let safe_filter = if filter.trim() == "any" || filter.trim().is_empty() {
            "".to_string()
        } else {
            filter.to_string()
        };
        Self { interface: interface.to_string(), filter: safe_filter, tx, node_name }
    }
    
    fn parse_headers(packet: &pcap::Packet, link_type: Linktype) -> Option<Vec<u8>> {
        let data = packet.data;
        let offset = match link_type {
            Linktype::ETHERNET => {
                if data.len() < 14 { return None; }
                let ether_type = ((data[12] as u16) << 8) | data[13] as u16;
                if ether_type == 0x8100 { 18 } else { 14 }
            },
            Linktype::LINUX_SLL => 16,
            Linktype::NULL | Linktype::LOOP => 4,
            _ => 14,
        };

        if data.len() <= offset { return None; }
        let ip_header_start = offset;
        if data.len() <= ip_header_start { return None; }
        let version_ihl = data[ip_header_start];
        let version = version_ihl >> 4;
        if version != 4 { return None; }
        let ihl = version_ihl & 0x0F;
        let ip_header_len = (ihl as usize) * 4;
        if ip_header_len < 20 { return None; }
        if data.len() <= ip_header_start + 9 { return None; }
        let protocol = data[ip_header_start + 9];
        if protocol != 17 { return None; }
        let udp_header_start = ip_header_start + ip_header_len;
        let udp_header_len = 8;
        if data.len() < udp_header_start + udp_header_len { return None; }
        let payload_start = udp_header_start + udp_header_len;
        if data.len() <= payload_start { return None; }
        Some(data[payload_start..].to_vec())
    }

    fn process_payload(&self, payload: &[u8], original_len: u32) -> Option<LogRecord> {
        if let Ok(data_str) = std::str::from_utf8(payload) {
            if data_str.contains("SIP/2.0") {
                return self.create_sip_log(data_str, original_len);
            }
        }
        if payload.len() > 12 && (payload[0] & 0xC0) == 0x80 {
             let pt = payload[1] & 0x7F;
             if pt == 0 || pt == 8 || pt == 18 || (pt >= 96 && pt <= 127) {
                 return self.create_rtp_log(pt, original_len);
             }
        }
        None
    }

    fn create_sip_log(&self, data: &str, len: u32) -> Option<LogRecord> {
        let first_word = data.split_whitespace().next().unwrap_or("UNKNOWN");
        let method = if first_word == "SIP/2.0" {
            let status_code = data.split_whitespace().nth(1).unwrap_or("000");
            format!("RESPONSE/{}", status_code)
        } else {
            first_word.to_string()
        };
        let call_id = data.lines()
            .find(|l| l.to_lowercase().starts_with("call-id") || l.to_lowercase().starts_with("i:"))
            .map(|l| if let Some(pos) = l.find(':') { l[pos+1..].trim() } else { "unknown" })
            .unwrap_or("unknown");

        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), Value::from(len));
        attributes.insert("net.interface".to_string(), Value::String(self.interface.clone()));
        attributes.insert("sip.method".to_string(), Value::String(method.clone()));
        attributes.insert("sip.call_id".to_string(), Value::String(call_id.to_string()));
        
        // SIP için manuel etiketleme
        let mut log = self.build_log("SIP_PACKET", format!("SIP {} captured", method), attributes);
        log.smart_tags.push("SIP".to_string());
        log.smart_tags.push("NET".to_string());
        Some(log)
    }

    fn create_rtp_log(&self, pt: u8, len: u32) -> Option<LogRecord> {
        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), Value::from(len));
        attributes.insert("rtp.payload_type".to_string(), Value::from(pt));
        attributes.insert("net.interface".to_string(), Value::String(self.interface.clone()));
        
        // RTP için manuel etiketleme
        let mut log = self.build_log("RTP_PACKET", format!("RTP Stream (PT: {})", pt), attributes);
        log.smart_tags.push("RTP".to_string());
        log.smart_tags.push("NET".to_string());
        Some(log)
    }

    fn build_log(&self, event: &str, msg: String, attributes: HashMap<String, Value>) -> LogRecord {
        LogRecord {
            schema_v: "1.0.0".to_string(), ts: chrono::Utc::now().to_rfc3339(), severity: "INFO".to_string(),
            tenant_id: "default".to_string(),
            resource: ResourceContext {
                service_name: "network-sniffer".to_string(), service_version: "1.0.0".to_string(),
                service_env: "production".to_string(), host_name: Some(self.node_name.clone()),
            },
            trace_id: None, span_id: None, event: event.to_string(), message: msg, attributes,
            smart_tags: vec![], // <--- EKLENDİ (FIX 3) - Default boş, yukarıda dolduruyoruz
        }
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!("🕸️ Sniffer Config: Interface='{}', Filter='{}'", self.interface, self.filter);
        let device_name = if self.interface == "any" {
            "any".to_string()
        } else {
            let dev = Device::list()?.into_iter().find(|d| d.name == self.interface)
                .ok_or_else(|| anyhow::anyhow!("Arayüz bulunamadı: {}", self.interface))?;
            dev.name
        };
        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error")?.promisc(true).snaplen(65535).timeout(500)
            .open().context("Pcap Open Error (Root gerekli)")?;
        let link_type = cap.get_datalink();
        info!("🔗 DataLink Type: {:?} ({})", link_type, link_type.get_name().unwrap_or_else(|_| "?".to_string()));
        if !self.filter.is_empty() {
            if let Err(e) = cap.filter(&self.filter, true) {
                error!("❌ BPF Filter Error ('{}'): {}. Sniffer devre dışı kalıyor.", self.filter, e);
                return Err(anyhow::anyhow!("BPF Filter Error"));
            } else { info!("✅ BPF Filter Applied: '{}'", self.filter); }
        } else { info!("ℹ️ No BPF Filter applied (Promiscuous Mode)"); }

        let tx_clone = self.tx.clone();
        let sniffer_logic = NetworkSniffer {
            interface: self.interface.clone(), filter: self.filter.clone(),
            tx: self.tx.clone(), node_name: self.node_name.clone(),
        };

        tokio::task::spawn_blocking(move || {
            let mut dropped_packets = 0;
            loop {
                match cap.next_packet() {
                    Ok(packet) => {
                        if let Some(payload) = Self::parse_headers(&packet, link_type) {
                            if let Some(log) = sniffer_logic.process_payload(&payload, packet.header.len) {
                                match tx_clone.try_send(log) {
                                    Ok(_) => { if dropped_packets > 0 { info!("🕸️ Sniffer Recovered ({} dropped).", dropped_packets); dropped_packets = 0; } },
                                    Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => { dropped_packets += 1; },
                                    Err(_) => break,
                                }
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
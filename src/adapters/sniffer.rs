// src/adapters/sniffer.rs
use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device, Linktype};
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;
use tracing::{error, info, debug};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub struct NetworkSniffer {
    interface: String,
    filter: String,
    tx: Sender<LogRecord>,
    node_name: String,
    active_flag: Arc<AtomicBool>, // Kontrol Bayrağı
}

impl NetworkSniffer {
    pub fn new(interface: &str, filter: &str, tx: Sender<LogRecord>, node_name: String, active_flag: Arc<AtomicBool>) -> Self {
        let safe_filter = if filter.trim() == "any" || filter.trim().is_empty() {
            "".to_string()
        } else {
            filter.to_string()
        };
        Self { interface: interface.to_string(), filter: safe_filter, tx, node_name, active_flag }
    }
    
    // ... (parse_headers ve process_payload fonksiyonları AYNI KALACAK - Değişiklik yok) ...
    // KOD TEKRARI OLMASIN DİYE BURAYI KISALTIYORUM, MEVCUT KODU KORUYUN.
    // Sadece build_log ve aşağısını değiştirmiyoruz.

    fn parse_headers(packet: &pcap::Packet, link_type: Linktype) -> Option<Vec<u8>> {
        // ... (Mevcut kod ile aynı) ...
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
        if (version_ihl >> 4) != 4 { return None; } 
        let ip_header_len = ((version_ihl & 0x0F) as usize) * 4;
        if data.len() <= ip_header_start + 9 { return None; }
        if data[ip_header_start + 9] != 17 { return None; } // UDP Only
        let udp_start = ip_header_start + ip_header_len;
        if data.len() < udp_start + 8 { return None; }
        Some(data[udp_start + 8..].to_vec())
    }

    fn process_payload(&self, payload: &[u8], original_len: u32) -> Option<LogRecord> {
        if let Ok(data_str) = std::str::from_utf8(payload) {
            if data_str.contains("SIP/2.0") {
                return self.create_sip_log(data_str, original_len);
            }
        }
        // RTP Heuristic Check
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
        
        // Basit Call-ID çıkarımı
        let call_id = data.lines()
            .find(|l| l.to_lowercase().starts_with("call-id") || l.to_lowercase().starts_with("i:"))
            .map(|l| if let Some(pos) = l.find(':') { l[pos+1..].trim() } else { "unknown" })
            .unwrap_or("unknown");

        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), Value::from(len));
        attributes.insert("net.interface".to_string(), Value::String(self.interface.clone()));
        attributes.insert("sip.method".to_string(), Value::String(method.clone()));
        attributes.insert("sip.call_id".to_string(), Value::String(call_id.to_string()));
        
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
            smart_tags: vec![],
        }
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!("🕸️ Sniffer Manager: Başlatılıyor. Arayüz: {}, Filtre: {}", self.interface, self.filter);
        
        let device_name = if self.interface == "any" {
            "any".to_string() // Linux "any" device
        } else {
            let dev = Device::list()?.into_iter().find(|d| d.name == self.interface)
                .ok_or_else(|| anyhow::anyhow!("Arayüz bulunamadı: {}", self.interface))?;
            dev.name
        };

        // Pcap handle'ını oluştur
        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error")?
            .promisc(true)
            .snaplen(65535)
            .timeout(100) // 100ms timeout (Non-blocking döngü için kritik)
            .open()
            .context("Pcap Open Error (Root gerekli)")?;

        if !self.filter.is_empty() {
            cap.filter(&self.filter, true)?;
        }
        
        let link_type = cap.get_datalink();
        let active_flag = self.active_flag.clone();
        let tx_clone = self.tx.clone();
        let logic_clone = NetworkSniffer {
            interface: self.interface.clone(), filter: self.filter.clone(),
            tx: self.tx.clone(), node_name: self.node_name.clone(), active_flag: self.active_flag.clone()
        };

        // Sniffer Thread (Blocking Pcap Loop)
        tokio::task::spawn_blocking(move || {
            loop {
                // 1. Durum Kontrolü
                if !active_flag.load(Ordering::Relaxed) {
                    // Pasif ise CPU harcamamak için uyu
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }

                // 2. Paket Yakalama
                match cap.next_packet() {
                    Ok(packet) => {
                        if let Some(payload) = Self::parse_headers(&packet, link_type) {
                            if let Some(log) = logic_clone.process_payload(&payload, packet.header.len) {
                                let _ = tx_clone.blocking_send(log);
                            }
                        }
                    },
                    Err(pcap::Error::TimeoutExpired) => continue, // Timeout normaldir, döngüye devam
                    Err(e) => {
                        error!("Sniffer Error: {:?}", e);
                        std::thread::sleep(Duration::from_secs(1)); // Hata durumunda bekle
                    }
                }
            }
        });

        Ok(())
    }
}
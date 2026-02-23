// src/adapters/sniffer.rs
use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use pcap::{Capture, Device, Linktype};
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::mpsc::Sender;
use tracing::{error, info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Ağ trafiğini (SIP, RTP, DTMF) gerçek zamanlı analiz eden modül.
pub struct NetworkSniffer {
    interface: String,
    filter: String,
    tx: Sender<LogRecord>,
    node_name: String,
    active_flag: Arc<AtomicBool>, // UI üzerinden gelen Start/Stop emrini tutar
}

impl NetworkSniffer {
    pub fn new(interface: &str, filter: &str, tx: Sender<LogRecord>, node_name: String, active_flag: Arc<AtomicBool>) -> Self {
        // Güvenlik: Eğer filter 'any' veya boş ise, pcap kütüphanesi hata vermesin diye boş string yapıyoruz.
        let safe_filter = if filter.trim() == "any" || filter.trim().is_empty() {
            "".to_string()
        } else {
            filter.to_string()
        };
        
        Self { 
            interface: interface.to_string(), 
            filter: safe_filter, 
            tx, 
            node_name, 
            active_flag 
        }
    }

    /// Ham ağ paketinden IP ve UDP başlıklarını soyarak sadece UDP veri yükünü (Payload) çıkarır.
    fn parse_headers(packet: &pcap::Packet, link_type: Linktype) -> Option<Vec<u8>> {
        let data = packet.data;
        
        // 1. Data-Link Layer (Ethernet, Linux SLL, Loopback) Offset Hesaplama
        let offset = match link_type {
            Linktype::ETHERNET => {
                if data.len() < 14 { return None; }
                let ether_type = ((data[12] as u16) << 8) | data[13] as u16;
                if ether_type == 0x8100 { 18 } else { 14 } // VLAN Tagged ise 18 byte
            },
            Linktype::LINUX_SLL => 16,
            Linktype::NULL | Linktype::LOOP => 4,
            _ => 14, // Varsayılan Ethernet
        };

        if data.len() <= offset { return None; }
        let ip_header_start = offset;
        
        // 2. IP Layer Kontrolü
        if data.len() <= ip_header_start { return None; }
        let version_ihl = data[ip_header_start];
        let version = version_ihl >> 4;
        
        // Sadece IPv4 destekliyoruz (Platform standardı)
        if version != 4 { return None; } 
        
        let ihl = version_ihl & 0x0F;
        let ip_header_len = (ihl as usize) * 4;
        
        // Protocol Field: UDP (17) olmalı
        if data.len() <= ip_header_start + 9 { return None; }
        let protocol = data[ip_header_start + 9];
        if protocol != 17 { return None; } 
        
        // 3. UDP Layer (8 Byte sabit)
        let udp_header_start = ip_header_start + ip_header_len;
        let payload_start = udp_header_start + 8;
        
        if data.len() <= payload_start { return None; }
        
        // Saf veriyi döndür
        Some(data[payload_start..].to_vec())
    }

    /// Çıkarılan UDP verisinin türünü (SIP veya RTP) tahmin eder (Heuristics).
    fn process_payload(&self, payload: &[u8], original_len: u32) -> Option<LogRecord> {
        // 1. SIP Kontrolü: Metin tabanlı mıdır ve "SIP/2.0" içerir mi?
        if let Ok(data_str) = std::str::from_utf8(payload) {
            if data_str.contains("SIP/2.0") {
                return self.create_sip_log(data_str, original_len);
            }
        }
        
        // 2. RTP Kontrolü: İkili (Binary) formattadır.
        // RTP Header kuralı: İlk byte'ın ilk 2 biti '10' (Version 2) olmalıdır. (0x80 maskesi)
        if payload.len() > 12 && (payload[0] & 0xC0) == 0x80 {
             let pt = payload[1] & 0x7F; // Payload Type (7 bit)
             
             // İlgilendiğimiz Telekom Kodekleri: 0(PCMU), 8(PCMA), 18(G729), 101(DTMF), 96+(Dinamik/Opus)
             if pt == 0 || pt == 8 || pt == 18 || pt == 101 || (pt >= 96 && pt <= 127) {
                 return self.create_rtp_log(pt, original_len);
             }
        }
        None
    }

    /// SIP Paketi için SUTS v4.0 formatında LogRecord üretir.
    fn create_sip_log(&self, data: &str, len: u32) -> Option<LogRecord> {
        let first_word = data.split_whitespace().next().unwrap_or("UNKNOWN");
        
        // Request (INVITE) mi Response (200 OK) mi?
        let method = if first_word == "SIP/2.0" {
            let status_code = data.split_whitespace().nth(1).unwrap_or("000");
            format!("RESPONSE/{}", status_code)
        } else {
            first_word.to_string()
        };
        
        // Call-ID Header'ını Parse et
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
        log.trace_id = Some(call_id.to_string()); // Observer UI gruplaması için kritik
        log.smart_tags.push("SIP".to_string());
        log.smart_tags.push("NET".to_string());
        
        Some(log)
    }

    /// RTP/DTMF Paketi için SUTS v4.0 formatında LogRecord üretir.
    fn create_rtp_log(&self, pt: u8, len: u32) -> Option<LogRecord> {
        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), Value::from(len));
        attributes.insert("rtp.payload_type".to_string(), Value::from(pt));
        attributes.insert("net.interface".to_string(), Value::String(self.interface.clone()));
        
        // 101 payload_type DTMF (Tuşlama) için RFC 2833 standardıdır.
        let msg = if pt == 101 { "RTP EVENT (DTMF)" } else { "RTP MEDIA" };
        let mut log = self.build_log("RTP_PACKET", format!("{} (PT: {})", msg, pt), attributes);
        
        if pt == 101 {
            log.smart_tags.push("DTMF".to_string());
            log.severity = "WARN".to_string(); // Tuşlamalar ekranda sarı renkli dikkat çekici çıksın
        } else {
            log.smart_tags.push("RTP".to_string());
        }
        log.smart_tags.push("NET".to_string());
        
        Some(log)
    }

    /// Standartlaştırılmış Çekirdek Log Objesi Üretici
    fn build_log(&self, event: &str, msg: String, attributes: HashMap<String, Value>) -> LogRecord {
        LogRecord {
            schema_v: "1.0.0".to_string(), 
            ts: chrono::Utc::now().to_rfc3339(), 
            severity: "INFO".to_string(),
            tenant_id: "default".to_string(),
            resource: ResourceContext {
                service_name: "network-sniffer".to_string(), 
                service_version: "4.1.0".to_string(),
                service_env: "production".to_string(), 
                host_name: Some(self.node_name.clone()),
            },
            trace_id: None, 
            span_id: None, 
            event: event.to_string(), 
            message: msg, 
            attributes,
            smart_tags: vec![],
        }
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!("🕸️ Mission Control Sniffer: Initializing. Interface: {}, Filter: {}", self.interface, self.filter);
        
        // --- DÜZELTİLEN KISIM BURASIDIR (devs vs dev) ---
        let device_name = if self.interface == "any" { 
            "any".to_string() 
        } else {
            match Device::list() {
                Ok(devs) => devs.into_iter()
                                .find(|d| d.name == self.interface)
                                .map(|d| d.name)
                                .unwrap_or_else(|| "any".to_string()),
                Err(e) => {
                    warn!("Ağ kartları listelenirken hata oluştu, 'any' kullanılıyor. Hata: {}", e);
                    "any".to_string()
                }
            }
        };

        // Ağ kartını dinleme moduna (Promiscuous) al
        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error (Cihaz bulunamadı)")?
            .promisc(true)
            .snaplen(65535)
            .timeout(50) // 50ms (Non-blocking loop için)
            .open()
            .context("Pcap Open Error (Root veya NET_ADMIN / NET_RAW yetkisi eksik)")?;

        if !self.filter.is_empty() {
            if let Err(e) = cap.filter(&self.filter, true) {
                error!("BPF Filtre Hatası: {}. Sniffer çalışmayacak.", e);
                return Err(anyhow::anyhow!("BPF Filter Error"));
            }
        }
        
        let link_type = cap.get_datalink();
        let active_flag = self.active_flag.clone();
        let tx_clone = self.tx.clone();
        
        let parser_logic = NetworkSniffer {
            interface: self.interface.clone(), 
            filter: self.filter.clone(),
            tx: self.tx.clone(), 
            node_name: self.node_name.clone(), 
            active_flag: self.active_flag.clone()
        };

        // Sniffer Block etmemesi için ayrı bir Native Thread'de çalışır
        std::thread::spawn(move || {
            loop {
                // 1. UI Kontrol Bayrağı (Atomic - Thread Safe)
                // UI'dan "PAUSE" veya "DISABLE" geldiğinde CPU tüketimini %0'a indirir.
                if !active_flag.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }

                // 2. Paket Yakalama Döngüsü
                match cap.next_packet() {
                    Ok(packet) => {
                        if let Some(payload) = Self::parse_headers(&packet, link_type) {
                            if let Some(log) = parser_logic.process_payload(&payload, packet.header.len) {
                                // MPSC Kanalına gönder (UI'a iletilmek üzere)
                                let _ = tx_clone.blocking_send(log);
                            }
                        }
                    },
                    // Timeout normal bir akıştır, trafik olmadığında fırlatılır.
                    Err(pcap::Error::TimeoutExpired) => continue, 
                    Err(e) => {
                        // Ciddi hatalar (Ağ kartının kapanması vb.)
                        error!("Sniffer Critical Interface Error: {:?}", e);
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        });

        Ok(())
    }
}
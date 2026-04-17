// src/adapters/sniffer.rs
use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::{Context, Result};
use async_trait::async_trait;
use lru::LruCache;
use pcap::{Capture, Device, Linktype};
use serde_json::Value;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::Sender;
use tracing::{debug, error, info};

pub struct NetworkSniffer {
    interface: String,
    filter: String,
    tx: Sender<LogRecord>,
    node_name: String,
    active_flag: Arc<AtomicBool>,
    tenant_id: String, // [ARCH-COMPLIANCE] Dinamik tenant
}

impl NetworkSniffer {
    pub fn new(
        interface: &str,
        filter: &str,
        tx: Sender<LogRecord>,
        node_name: String,
        active_flag: Arc<AtomicBool>,
        tenant_id: String,
    ) -> Self {
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
            active_flag,
            tenant_id,
        }
    }

    fn parse_headers(packet: &pcap::Packet, link_type: Linktype) -> Option<Vec<u8>> {
        let data = packet.data;
        let offset = match link_type {
            Linktype::ETHERNET => {
                if data.len() < 14 {
                    return None;
                }
                let ether_type = ((data[12] as u16) << 8) | data[13] as u16;
                if ether_type == 0x8100 {
                    18
                } else {
                    14
                }
            }
            Linktype::LINUX_SLL => 16,
            Linktype::NULL | Linktype::LOOP => 4,
            _ => 14,
        };
        if data.len() <= offset {
            return None;
        }
        let ip_header_start = offset;
        if data.len() <= ip_header_start {
            return None;
        }
        let version_ihl = data[ip_header_start];
        if (version_ihl >> 4) != 4 {
            return None;
        }
        let ip_header_len = (version_ihl & 0x0F) as usize * 4;
        if data.len() <= ip_header_start + 9 {
            return None;
        }
        if data[ip_header_start + 9] != 17 {
            return None;
        }
        let udp_header_start = ip_header_start + ip_header_len;
        let payload_start = udp_header_start + 8;
        if data.len() <= payload_start {
            return None;
        }
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
            if pt == 0 || pt == 8 || pt == 18 || pt == 101 || (96..=127).contains(&pt) {
                return self.create_rtp_log(pt, original_len, payload);
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
        let call_id = data
            .lines()
            .find(|l| l.to_lowercase().starts_with("call-id") || l.to_lowercase().starts_with("i:"))
            .map(|l| {
                if let Some(pos) = l.find(':') {
                    l[pos + 1..].trim()
                } else {
                    "unknown"
                }
            })
            .unwrap_or("unknown");
        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), Value::from(len));
        attributes.insert(
            "net.interface".to_string(),
            Value::String(self.interface.clone()),
        );
        attributes.insert("sip.method".to_string(), Value::String(method.clone()));
        attributes.insert(
            "sip.call_id".to_string(),
            Value::String(call_id.to_string()),
        );
        let preview = if data.len() > 1000 {
            &data[..1000]
        } else {
            data
        };
        attributes.insert("payload".to_string(), Value::String(preview.to_string()));
        let mut log = self.build_log("SIP_PACKET", format!("SIP {} captured", method), attributes);
        log.trace_id = Some(call_id.to_string());
        log.smart_tags.push("SIP".to_string());
        log.smart_tags.push("NET".to_string());
        Some(log)
    }

    fn create_rtp_log(&self, pt: u8, len: u32, payload: &[u8]) -> Option<LogRecord> {
        let mut attributes = HashMap::new();
        attributes.insert("net.packet_len".to_string(), Value::from(len));
        attributes.insert("rtp.payload_type".to_string(), Value::from(pt));
        attributes.insert(
            "net.interface".to_string(),
            Value::String(self.interface.clone()),
        );

        if (pt == 8 || pt == 0) && payload.len() > 12 {
            let rtp_payload = &payload[12..];
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let b64_audio = STANDARD.encode(rtp_payload);
            attributes.insert("rtp.audio_b64".to_string(), Value::String(b64_audio));
        }

        let msg = if pt == 101 {
            "RTP EVENT (DTMF)"
        } else {
            "RTP MEDIA"
        };
        let mut log = self.build_log("RTP_PACKET", format!("{} (PT: {})", msg, pt), attributes);
        if pt == 101 {
            log.smart_tags.push("DTMF".to_string());
            log.severity = "WARN".to_string();
        } else {
            log.smart_tags.push("RTP".to_string());
        }
        log.smart_tags.push("NET".to_string());
        Some(log)
    }

    fn build_log(&self, event: &str, msg: String, attributes: HashMap<String, Value>) -> LogRecord {
        LogRecord {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: "INFO".to_string(),
            tenant_id: self.tenant_id.clone(), // [ARCH-COMPLIANCE]
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
            _idx: 0.0,
        }
    }
}

#[async_trait]
impl LogIngestor for NetworkSniffer {
    async fn start(&self) -> Result<()> {
        info!(event="SNIFFER_START", interface=%self.interface, "🕸️ Sniffer: Başlatılıyor.");

        let device_name = if self.interface == "any" {
            "any".to_string()
        } else {
            match Device::list() {
                Ok(devs) => devs
                    .into_iter()
                    .find(|d| d.name == self.interface)
                    .map(|d| d.name)
                    .unwrap_or("any".to_string()),
                Err(_) => "any".to_string(),
            }
        };

        let mut cap = Capture::from_device(device_name.as_str())
            .context("Pcap Device Error")?
            .promisc(true)
            .snaplen(65535)
            .timeout(50)
            .open()
            .context("Pcap Open Error")?;

        if !self.filter.is_empty() {
            if let Err(e) = cap.filter(&self.filter, true) {
                error!(event="BPF_FILTER_ERR", error=%e, "BPF Filtre Hatası");
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
            active_flag: self.active_flag.clone(),
            tenant_id: self.tenant_id.clone(),
        };

        std::thread::spawn(move || {
            let mut dropped_packets = 0;
            let mut last_drop_report = std::time::Instant::now();
            let mut seen_packets = LruCache::new(NonZeroUsize::new(1000).unwrap());

            loop {
                if !active_flag.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }

                match cap.next_packet() {
                    Ok(packet) => {
                        let ts_sec = packet.header.ts.tv_sec as u64;
                        let len = packet.header.len;
                        let payload_sig = if packet.data.len() > 20 {
                            ((packet.data[16] as u32) << 24)
                                | ((packet.data[17] as u32) << 16)
                                | ((packet.data[18] as u32) << 8)
                                | (packet.data[19] as u32)
                        } else {
                            0
                        };

                        let fingerprint = (ts_sec, len, payload_sig);

                        if seen_packets.put(fingerprint, ()).is_some() {
                            continue;
                        }

                        if let Some(payload) = Self::parse_headers(&packet, link_type) {
                            if let Some(log) =
                                parser_logic.process_payload(&payload, packet.header.len)
                            {
                                if let Err(tokio::sync::mpsc::error::TrySendError::Full(_)) =
                                    tx_clone.try_send(log)
                                {
                                    dropped_packets += 1;
                                }
                            }
                        }
                    }
                    Err(pcap::Error::TimeoutExpired) => {}
                    Err(e) => {
                        error!(event="PCAP_ERROR", error=?e, "Sniffer Hatası");
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }

                if dropped_packets > 0 && last_drop_report.elapsed() > Duration::from_secs(1) {
                    debug!(event="SNIFFER_BUFFER_FULL", dropped=%dropped_packets, "⚠️ Sniffer Buffer Dolu.");
                    dropped_packets = 0;
                    last_drop_report = std::time::Instant::now();
                }
            }
        });

        Ok(())
    }
}

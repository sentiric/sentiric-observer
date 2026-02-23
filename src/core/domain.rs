// sentiric-observer/src/core/domain.rs
use serde::{Deserialize, Serialize};
use validator::Validate;
use std::collections::HashMap;
use serde_json::Value;

// --- SUTS v5.0 HIGH-PERFORMANCE SCHEMA ---

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct LogRecord {
    #[validate(length(min = 1))]
    #[serde(default = "default_schema")]
    pub schema_v: String,

    #[serde(default = "default_timestamp")]
    pub ts: String, 
    
    #[serde(default = "default_severity")]
    pub severity: String,

    #[serde(default = "default_tenant")]
    pub tenant_id: String,

    #[serde(default)]
    pub resource: ResourceContext,

    #[serde(default)]
    pub trace_id: Option<String>,
    
    #[serde(default)]
    pub span_id: Option<String>,

    #[serde(default = "default_event")]
    pub event: String,

    #[serde(default)]
    pub message: String,

    // [OPTIMIZATION]: HashMap varsayılan olarak boş gelir, allocation'ı geciktirir.
    #[serde(default)]
    pub attributes: HashMap<String, Value>,

    // UI tarafında renklendirme ve filtreleme için kullanılır
    #[serde(default, skip_deserializing)]
    pub smart_tags: Vec<String>,
    
    // Frontend'de benzersizlik ve sıralama için (Backend tarafından üretilir)
    #[serde(default, skip_deserializing)]
    pub _idx: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceContext {
    #[serde(rename = "service.name", default = "default_unknown")]
    pub service_name: String,
    
    #[serde(rename = "service.version", default = "default_unknown")]
    pub service_version: String,
    
    #[serde(rename = "service.env", default = "default_prod")]
    pub service_env: String,
    
    #[serde(rename = "host.name")]
    pub host_name: Option<String>,
}

// --- Defaults (Allocation Maliyetini Düşürmek İçin Statik Referanslar) ---
fn default_schema() -> String { "1.0.0".to_string() }
fn default_severity() -> String { "INFO".to_string() }
fn default_tenant() -> String { "default".to_string() }
fn default_event() -> String { "LOG_EVENT".to_string() }
fn default_unknown() -> String { "unknown".to_string() }
fn default_prod() -> String { "production".to_string() }
fn default_timestamp() -> String { chrono::Utc::now().to_rfc3339() }

impl Default for ResourceContext {
    fn default() -> Self {
        Self {
            service_name: "unknown".to_string(),
            service_version: "0.0.0".to_string(),
            service_env: "production".to_string(),
            host_name: None,
        }
    }
}

impl LogRecord {
    pub fn new_system(level: &str, event: &str, msg: &str) -> Self {
        Self {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: level.to_string(),
            tenant_id: "system".to_string(),
            resource: ResourceContext {
                service_name: "sentiric-observer".to_string(),
                service_version: env!("CARGO_PKG_VERSION").to_string(),
                service_env: "production".to_string(),
                host_name: hostname::get().ok().map(|h| h.to_string_lossy().to_string()),
            },
            trace_id: None,
            span_id: None,
            event: event.to_string(),
            message: msg.to_string(),
            attributes: HashMap::new(),
            smart_tags: vec!["SYS".to_string()],
            _idx: 0.0, // Ingest anında atanacak
        }
    }

    /// Log içeriğini zenginleştirir ve eksik alanları doldurur.
    pub fn sanitize_and_enrich(&mut self) {
        // 1. Message alanı JSON ise onu da parse edip attributes'a göm
        if self.message.trim().starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&self.message) {
                for (k, v) in parsed {
                    if k == "msg" || k == "message" {
                        if let Some(s) = v.as_str() { self.message = s.to_string(); }
                    } else if k != "level" && k != "severity" && k != "ts" {
                        self.attributes.insert(k, v);
                    }
                }
            }
        }

        // 2. Trace ID Kurtarma (Call-ID varsa Trace ID yap)
        if self.trace_id.is_none() {
            let candidates = ["sip.call_id", "call_id", "Call-ID", "callid"];
            for key in candidates {
                if let Some(val) = self.attributes.get(key).and_then(|v| v.as_str()) {
                    if !val.is_empty() && val != "null" {
                        self.trace_id = Some(val.to_string());
                        break;
                    }
                }
            }
        }

        // 3. Smart Tagging (Otomatik Etiketleme)
        let svc = self.resource.service_name.to_lowercase();
        let msg_lower = self.message.to_lowercase();

        if svc.contains("postgres") || svc.contains("db") || svc.contains("redis") {
            self.smart_tags.push("DB".to_string());
        }

        if svc.contains("sbc") || svc.contains("kamailio") || self.attributes.contains_key("sip.method") {
            self.smart_tags.push("SIP".to_string());
        }

        if svc.contains("media") || svc.contains("rtp") || self.attributes.contains_key("rtp.payload_type") {
            self.smart_tags.push("RTP".to_string());
        }

        if svc.contains("proxy") || svc.contains("b2bua") {
             self.smart_tags.push("CORE".to_string());
        }

        if msg_lower.contains("timeout") || msg_lower.contains("refused") {
             self.smart_tags.push("NET".to_string());
        }
    }
}
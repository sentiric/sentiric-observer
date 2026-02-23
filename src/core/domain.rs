// sentiric-observer/src/core/domain.rs
use serde::{Deserialize, Serialize};
use validator::Validate;
use std::collections::HashMap;
use serde_json::Value;

// --- SUTS v4.0 SOVEREIGN SCHEMA ---

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct LogRecord {
    #[validate(length(min = 1, message = "Schema version required"))]
    #[serde(default = "default_schema")]
    pub schema_v: String,

    pub ts: String, 
    
    #[validate(custom = "validate_severity")]
    pub severity: String,

    #[serde(default)]
    pub tenant_id: String,

    pub resource: ResourceContext,

    #[serde(default)]
    pub trace_id: Option<String>,
    
    #[serde(default)]
    pub span_id: Option<String>,

    #[validate(length(min = 1))]
    pub event: String,
    pub message: String,

    // [CRITICAL FIX]: Go servisleri her zaman attributes göndermeyebilir.
    // Default değeri boş bir HashMap olmalıdır.
    #[serde(default)]
    pub attributes: HashMap<String, Value>,

    #[serde(default, skip_deserializing)]
    pub smart_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceContext {
    #[serde(rename = "service.name")]
    pub service_name: String,
    #[serde(rename = "service.version")]
    pub service_version: String,
    #[serde(rename = "service.env")]
    pub service_env: String,
    #[serde(rename = "host.name")]
    pub host_name: Option<String>,
}

fn default_schema() -> String { "1.0.0".to_string() }

fn validate_severity(severity: &str) -> Result<(), validator::ValidationError> {
    match severity {
        "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" => Ok(()),
        _ => Err(validator::ValidationError::new("invalid_severity_level")),
    }
}

impl LogRecord {
    // Gelecekte sistem kendi loglarını UI'a basmak için kullanacak (Donduruldu)
    #[allow(dead_code)] 
    pub fn system_log(level: &str, event: &str, msg: &str) -> Self {
        let mut attrs = HashMap::new();
        attrs.insert("source".to_string(), Value::String("internal".to_string()));

        Self {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: level.to_string(),
            tenant_id: "system".to_string(),
            resource: ResourceContext {
                service_name: "sentiric-observer".to_string(),
                service_version: env!("CARGO_PKG_VERSION").to_string(),
                service_env: std::env::var("ENV").unwrap_or("production".to_string()),
                host_name: hostname::get().ok().map(|h| h.to_string_lossy().to_string()),
            },
            trace_id: None,
            span_id: None,
            event: event.to_string(),
            message: msg.to_string(),
            attributes: attrs,
            smart_tags: vec!["SYS".to_string()],
        }
    }

    pub fn sanitize_and_enrich(&mut self) {
        if self.message.trim().starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&self.message) {
                for (k, v) in parsed {
                    if k == "msg" || k == "message" {
                        if let Some(s) = v.as_str() { self.message = s.to_string(); }
                    } else if k != "level" && k != "severity" {
                        self.attributes.insert(k.clone(), v);
                    }
                }
            }
        }

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

        let svc = self.resource.service_name.to_lowercase();
        let msg_lower = self.message.to_lowercase();

        if svc.contains("postgres") || svc.contains("db") || svc.contains("mongo") {
            self.smart_tags.push("DB".to_string());
            if msg_lower.contains("checkpoint") {
                self.severity = "INFO".to_string();
                self.event = "DB_CHECKPOINT".to_string();
            }
        }

        if svc.contains("sbc") || svc.contains("kamailio") || self.attributes.contains_key("sip.method") {
            self.smart_tags.push("SIP".to_string());
        }

        if svc.contains("media") || svc.contains("rtp") || self.attributes.contains_key("rtp.payload_type") {
            self.smart_tags.push("RTP".to_string());
        }

        if msg_lower.contains("timeout") || msg_lower.contains("refused") || msg_lower.contains("reset") {
             self.smart_tags.push("NET".to_string());
        }
    }
}
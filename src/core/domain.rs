use serde::{Deserialize, Serialize};
use validator::Validate;
use std::collections::HashMap;
use serde_json::Value;

// --- SUTS v4.0 ZORUNLU ŞEMA ---

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct LogRecord {
    // 1. Governance
    #[validate(length(min = 1, message = "Schema version required"))]
    #[serde(default = "default_schema")]
    pub schema_v: String,

    // 2. Metadata
    pub ts: String, // ISO 8601
    
    #[validate(custom = "validate_severity")]
    pub severity: String, // DEBUG, INFO, WARN, ERROR, FATAL

    #[serde(default)]
    pub tenant_id: String,

    // 3. Resource (Kimlik)
    pub resource: ResourceContext,

    // 4. Tracing (Bağlam)
    pub trace_id: Option<String>,
    pub span_id: Option<String>,

    // 5. Payload (Olay)
    #[validate(length(min = 1))]
    pub event: String,
    pub message: String,

    // 6. Attributes (Esnek Alan)
    pub attributes: HashMap<String, Value>,
}

// Resource Context - Dotted fields support via serde rename
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

// --- VALIDATION LOGIC ---

fn default_schema() -> String {
    "1.0.0".to_string()
}

fn validate_severity(severity: &str) -> Result<(), validator::ValidationError> {
    match severity {
        "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" => Ok(()),
        _ => Err(validator::ValidationError::new("invalid_severity_level")),
    }
}

// --- INTELLIGENCE LAYER (YENİ EKLENEN KISIM) ---

impl LogRecord {
    /// Sistem içi (Observer'ın kendi logları) için hızlı oluşturucu
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
        }
    }

    /// Logu temizler, zenginleştirir ve hataları düzeltir.
    /// Bu fonksiyon "Kirli Veri" ile savaşan ana mekanizmadır.
    pub fn sanitize_and_enrich(&mut self) {
        // 1. Recursive JSON Parsing (CDR Service Fix)
        // Eğer message bir JSON string ise, onu parse et ve attributes'a ekle.
        if self.message.trim().starts_with('{') {
            // Serde_json ile iç içe string'i çözmeye çalış
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&self.message) {
                // İçerideki alanları ana attributes'a taşı (Flattening)
                for (k, v) in parsed {
                    // Message alanını ezmemek için özel kontrol
                    if k == "msg" || k == "message" {
                        if let Some(s) = v.as_str() {
                            self.message = s.to_string();
                        }
                    } else if k == "level" || k == "severity" {
                        // Level override yapma, orijinal container logu daha güvenilirdir genelde
                    } else {
                        self.attributes.insert(k.clone(), v);
                    }
                }
                
                // Event'i güncelle (eğer içeride varsa)
                if let Some(evt) = self.attributes.get("event_type").and_then(|v| v.as_str()) {
                    self.event = evt.to_uppercase().replace('.', "_");
                }
            }
        }

        // 2. Trace ID Promotion
        // Eğer trace_id yoksa ama attributes içinde call_id varsa, onu trace_id yap.
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

        // 3. Heuristic Severity Adjustment (Postgres Noise Reduction)
        // Postgres checkpoint loglarını ERROR'dan INFO'ya çek.
        if self.resource.service_name.contains("postgres") && self.severity == "ERROR" {
            let msg_lower = self.message.to_lowercase();
            if msg_lower.contains("checkpoint starting") || msg_lower.contains("checkpoint complete") {
                self.severity = "INFO".to_string();
                self.event = "DB_CHECKPOINT".to_string();
            }
        }

        // 4. Raft/Discovery Noise Reduction
        // Sürekli tekrar eden checksum loglarını etiketle (UI'da gruplamak için)
        if self.resource.service_name.contains("discovery") && self.message.contains("verification checksum OK") {
            self.event = "RAFT_HEALTH_CHECK".to_string();
        }
    }
}
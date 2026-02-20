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

// ================== KRİTİK DÜZELTME ==================
// Serde'ye JSON'daki noktalı alan adlarını nasıl Rust struct alanlarına
// eşleştireceğini bildiren 'rename' direktifleri eklendi.
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
// =======================================================


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

// --- CONSTRUCTOR ---

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
}
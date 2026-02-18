// sentiric-observer/src/model.rs
use serde::{Deserialize, Serialize};

/// OpenTelemetry Log Data Model (v1.0) Uyumlu Yapı
/// Kaynak: https://opentelemetry.io/docs/specs/otel/logs/data-model/
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OtelLogRecord {
    /// Olay zamanı (ISO 8601 UTC)
    #[serde(rename = "Timestamp")]
    pub timestamp: String,

    /// Log seviyesi (INFO, WARN, ERROR)
    #[serde(rename = "SeverityText")]
    pub severity_text: String,

    /// Logun insan tarafından okunabilir gövdesi
    #[serde(rename = "Body")]
    pub body: String,

    /// Logu üreten kaynağın kimliği
    #[serde(rename = "Resource")]
    pub resource: OtelResource,

    /// Yapısal veriler (TraceID, UserID, IP vb.)
    #[serde(rename = "Attributes")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OtelResource {
    #[serde(rename = "service.name")]
    pub service_name: String,

    #[serde(rename = "host.name")]
    pub host_name: String,
}

impl OtelLogRecord {
    pub fn new_raw(service: String, host: String, msg: String) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            severity_text: "INFO".to_string(),
            body: msg,
            resource: OtelResource {
                service_name: service,
                host_name: host,
            },
            attributes: None,
        }
    }
}
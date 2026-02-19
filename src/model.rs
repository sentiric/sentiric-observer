use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Sentiric Telemetry Standard (STS v2.0) - Ana Veri Yapısı
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OtelLogRecord {
    #[serde(rename = "timestamp")]
    pub timestamp: String, // ISO 8601

    #[serde(rename = "level")]
    pub level: String, // INFO, WARN, ERROR, DEBUG

    #[serde(rename = "service")]
    pub service: String,

    #[serde(rename = "node")]
    pub node: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,

    #[serde(rename = "event")]
    pub event_type: EventType, // Enum for strict typing

    #[serde(rename = "message")]
    pub body: String,

    #[serde(rename = "attributes")]
    pub attributes: Value, // Esnek JSON alanı
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    Log,           // Standart Uygulama Logu
    SipPacket,     // SIP Sinyalleşme
    RtpMetric,     // Medya İstatistiği
    SystemMetric,  // CPU/RAM
    Anomaly,       // Observer tarafından tespit edilen sorun
}

impl OtelLogRecord {
    /// Ham bir mesajdan yeni kayıt oluşturur
    pub fn new_log(service: String, node: String, level: String, msg: String) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: level.to_uppercase(),
            service,
            node,
            trace_id: None,
            event_type: EventType::Log,
            body: msg,
            attributes: serde_json::json!({}),
        }
    }
}
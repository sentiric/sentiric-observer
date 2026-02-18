// sentiric-observer/src/model.rs

use serde::{Deserialize, Serialize};

/// OpenTelemetry Log Data Model (v1.0)
/// Referans: https://opentelemetry.io/docs/specs/otel/logs/data-model/
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OtelLogRecord {
    /// Olayın gerçekleştiği zaman (ISO 8601 / RFC 3339)
    #[serde(rename = "Timestamp")]
    pub timestamp: String,

    /// Log seviyesi (INFO, WARN, ERROR, DEBUG, TRACE)
    #[serde(rename = "SeverityText")]
    pub severity_text: String,

    /// Logun asıl metni veya içeriği
    #[serde(rename = "Body")]
    pub body: String,

    /// Logu üreten kaynağın kimlik bilgileri (Metadata)
    #[serde(rename = "Resource")]
    pub resource: OtelResource,

    /// Loga eklenen yapısal veriler (Key-Value pairs)
    #[serde(rename = "Attributes")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OtelResource {
    /// Servisin adı (örn: "media-service")
    #[serde(rename = "service.name")]
    pub service_name: String,

    /// Çalıştığı makinenin adı (örn: "gcp-gateway-01")
    #[serde(rename = "host.name")]
    pub host_name: String,

    /// Servis grubu (örn: "sentiric-telecom")
    #[serde(rename = "service.namespace")]
    pub namespace: String,
}

impl OtelLogRecord {
    /// Basit bir fabrika metodu
    pub fn new(
        host: &str,
        service: &str,
        level: &str,
        msg: String,
    ) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            severity_text: level.to_uppercase(),
            body: msg,
            resource: OtelResource {
                service_name: service.to_uppercase(),
                host_name: host.to_uppercase(),
                namespace: "sentiric-mesh".to_string(),
            },
            attributes: None,
        }
    }

    /// Attribute eklemek için yardımcı metod (Builder pattern)
    pub fn with_attributes(mut self, attrs: serde_json::Value) -> Self {
        self.attributes = Some(attrs);
        self
    }
}
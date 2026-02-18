use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OtelLogRecord {
    #[serde(rename = "Timestamp")]
    pub timestamp: String,
    #[serde(rename = "SeverityText")]
    pub severity_text: String,
    #[serde(rename = "Body")]
    pub body: String,
    #[serde(rename = "Resource")]
    pub resource: OtelResource,
    #[serde(rename = "Attributes")]
    pub attributes: serde_json::Value, // Zorunlu (Option değil)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OtelResource {
    #[serde(rename = "service.name")]
    pub service_name: String,
    #[serde(rename = "host.name")]
    pub host_name: String,
}

impl OtelLogRecord {
    // Docker Harvester'ın düz metin loglar için kullandığı metod
    pub fn new_raw(service: String, host: String, msg: String) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            severity_text: "INFO".to_string(),
            body: msg,
            resource: OtelResource {
                service_name: service,
                host_name: host,
            },
            attributes: json!({}), // Boş JSON objesi (Zorunlu alan olduğu için)
        }
    }
}
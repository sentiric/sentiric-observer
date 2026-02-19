use crate::model::OtelLogRecord;
use crate::utils::parser;

pub struct Aggregator;

impl Aggregator {
    /// Gelen her türlü kaydı (Log veya Network) analiz eder ve zenginleştirir.
    pub fn process(mut record: OtelLogRecord) -> OtelLogRecord {
        // 1. Trace ID / Call-ID Cımbızlama
        if record.trace_id.is_none() {
            // Mesaj gövdesinden Call-ID bulmaya çalış
            if let Some(call_id) = parser::extract_call_id(&record.body) {
                record.trace_id = Some(call_id);
            }
        }

        // 2. SIP Paketleri İçin Ekstra Derinlik
        if record.trace_id.is_none() {
            if let Some(raw_sip) = record.attributes.get("raw_sip").and_then(|v| v.as_str()) {
                if let Some(call_id) = parser::extract_call_id(raw_sip) {
                    record.trace_id = Some(call_id);
                }
            }
        }

        // 3. Akıllı Seviye Belirleme (Anomaly Detection başlangıcı)
        let body_upper = record.body.to_uppercase();
        if body_upper.contains("ERROR") || body_upper.contains("FAILED") || body_upper.contains("CRITICAL") {
            record.level = "ERROR".to_string();
        } else if body_upper.contains("WARN") || body_upper.contains("TIMEOUT") {
            record.level = "WARN".to_string();
        }

        record
    }
}
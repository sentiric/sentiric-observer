use crate::core::domain::LogRecord;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};

/// Bir çağrının veya işlemin anlık fotoğrafı
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSession {
    pub session_id: String,
    pub start_time: String,
    pub last_update: String,
    pub logs: Vec<LogRecord>,
    pub status: SessionStatus,
    pub anomalies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Active,
    Completed,
    Failed,
}

pub struct Aggregator {
    // Session ID -> Session Data
    sessions: HashMap<String, CallSession>,
}

impl Aggregator {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Gelen logu analiz et, ilgili session'ı bul ve güncelle
    pub fn process(&mut self, log: LogRecord) -> Option<CallSession> {
        // 1. Correlation ID Belirle (Trace ID veya Attributes içindeki Call-ID)
        let session_id = if let Some(tid) = &log.trace_id {
            tid.clone()
        } else if let Some(cid) = log.attributes.get("sip.call_id").and_then(|v| v.as_str()) {
            cid.to_string()
        } else {
            // ID yoksa session oluşturamayız (Orphan Log)
            return None;
        };

        // 2. Session Bul veya Oluştur
        let session = self.sessions.entry(session_id.clone()).or_insert_with(|| {
            CallSession {
                session_id: session_id.clone(),
                start_time: log.ts.clone(),
                last_update: log.ts.clone(),
                logs: Vec::new(),
                status: SessionStatus::Active,
                anomalies: Vec::new(),
            }
        });

        // 3. Güncelle
        session.last_update = log.ts.clone();
        
        // Basit Anomali Tespiti
        if log.severity == "ERROR" || log.severity == "FATAL" {
            session.status = SessionStatus::Failed;
            session.anomalies.push(format!("Error: {}", log.message));
        }

        // Logu ekle
        session.logs.push(log);

        // Session'ın kopyasını dön (UI'a basmak için)
        Some(session.clone())
    }

    /// Eski sessionları temizle (Garbage Collection)
    pub fn cleanup(&mut self) {
        // Basit TTL: Gerçek uygulamada buraya saat kontrolü ekleyeceğiz
        // Şimdilik 1000 çağrıdan fazlasını tutma
        if self.sessions.len() > 1000 {
            self.sessions.clear(); // Veya daha akıllı bir LRU (Least Recently Used) mantığı
        }
    }
}
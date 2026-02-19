use crate::core::domain::LogRecord;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use tracing::{info, warn};

/// Bir çağrının veya işlemin anlık fotoğrafı
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSession {
    pub session_id: String,
    pub start_time: String,
    pub last_update_ts: i64, // Timestamp (karşılaştırma için)
    pub last_update_str: String, // UI için ISO format
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
    sessions: HashMap<String, CallSession>,
    max_sessions: usize,
    ttl_seconds: i64,
}

impl Aggregator {
    /// Config değerlerini alarak başlat
    pub fn new(max_sessions: usize, ttl_seconds: i64) -> Self {
        Self {
            sessions: HashMap::new(),
            max_sessions,
            ttl_seconds,
        }
    }

    pub fn process(&mut self, log: LogRecord) -> Option<CallSession> {
        // 1. Correlation ID Belirle
        let session_id = if let Some(tid) = &log.trace_id {
            tid.clone()
        } else if let Some(cid) = log.attributes.get("sip.call_id").and_then(|v| v.as_str()) {
            cid.to_string()
        } else {
            return None; // Orphan log
        };

        // Timestamp parse et (ISO 8601 -> i64)
        let ts = match chrono::DateTime::parse_from_rfc3339(&log.ts) {
            Ok(dt) => dt.timestamp(),
            Err(_) => chrono::Utc::now().timestamp(),
        };

        // 2. Yeni Session Kontrolü (Limit Aşımı Var mı?)
        if !self.sessions.contains_key(&session_id) {
            if self.sessions.len() >= self.max_sessions {
                // Acil Durum Temizliği: En eski %10'u sil
                warn!("⚠️ Aggregator Doldu ({}/{})! Acil temizlik yapılıyor.", self.sessions.len(), self.max_sessions);
                self.force_cleanup();
                
                // Hala yer yoksa yeni çağrıyı reddet (Drop)
                if self.sessions.len() >= self.max_sessions {
                    return None;
                }
            }

            self.sessions.insert(session_id.clone(), CallSession {
                session_id: session_id.clone(),
                start_time: log.ts.clone(),
                last_update_ts: ts,
                last_update_str: log.ts.clone(),
                logs: Vec::new(),
                status: SessionStatus::Active,
                anomalies: Vec::new(),
            });
        }

        // 3. Mevcut Session'ı Güncelle
        if let Some(session) = self.sessions.get_mut(&session_id) {
            session.last_update_ts = ts;
            session.last_update_str = log.ts.clone();

            if log.severity == "ERROR" || log.severity == "FATAL" {
                session.status = SessionStatus::Failed;
                session.anomalies.push(format!("[{}] {}", log.severity, log.message));
            }

            // Logu ekle
            session.logs.push(log);
            return Some(session.clone());
        }

        None
    }

    /// Akıllı Temizlik: Sadece süresi dolanları siler
    pub fn cleanup(&mut self) {
        let now = chrono::Utc::now().timestamp();
        let ttl = self.ttl_seconds;
        let before_count = self.sessions.len();

        // retain: true dönerse tutar, false dönerse siler
        self.sessions.retain(|_, session| {
            (now - session.last_update_ts) < ttl
        });

        let removed = before_count - self.sessions.len();
        if removed > 0 {
            info!("🧹 Garbage Collector: {} bitmiş oturum temizlendi. Aktif: {}", removed, self.sessions.len());
        }
    }

    /// Zorunlu Temizlik (Memory Pressure Durumu)
    fn force_cleanup(&mut self) {
        // Basit yöntem: Rastgele silmemek için TTL'i yarıya indirip tekrar temizle
        let temp_ttl = self.ttl_seconds / 2;
        let now = chrono::Utc::now().timestamp();
        self.sessions.retain(|_, session| {
            (now - session.last_update_ts) < temp_ttl
        });
    }
}
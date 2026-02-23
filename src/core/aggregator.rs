// src/core/aggregator.rs
use crate::core::domain::LogRecord;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use tracing::info; // unused import 'warn' temizlendi

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSession {
    pub session_id: String,
    pub start_time: String,
    pub last_update_ts: i64,
    pub logs_count: usize, 
    pub logs: Vec<LogRecord>, 
    pub status: String, 
    pub anomalies: Vec<String>,
}

pub struct Aggregator {
    sessions: HashMap<String, CallSession>,
    max_sessions: usize,
    ttl_seconds: i64,
}

impl Aggregator {
    pub fn new(max_sessions: usize, ttl_seconds: i64) -> Self {
        Self {
            sessions: HashMap::new(),
            max_sessions,
            ttl_seconds,
        }
    }

    pub fn process(&mut self, log: &LogRecord) {
        let session_id = if let Some(tid) = &log.trace_id {
            tid.clone()
        } else {
            return; 
        };

        let now_ts = chrono::Utc::now().timestamp();

        // Borrow Checker FIX: Entry closure'ı içinde self.sessions'a tekrar erişmeyiz.
        let session = self.sessions.entry(session_id.clone()).or_insert_with(|| {
            CallSession {
                session_id,
                start_time: log.ts.clone(),
                last_update_ts: now_ts,
                logs_count: 0,
                logs: Vec::with_capacity(50), 
                status: "Active".to_string(),
                anomalies: Vec::new(),
            }
        });

        session.last_update_ts = now_ts;
        session.logs_count += 1;
        session.logs.push(log.clone()); 

        if log.severity == "ERROR" || log.severity == "FATAL" {
            session.status = "Failed".to_string();
            session.anomalies.push(format!("[{}] {}", log.severity, log.message));
        } else if log.event == "CALL_TERMINATED" || log.event == "BYE" {
            session.status = "Completed".to_string();
        }
    }

    pub fn cleanup(&mut self) {
        let now = chrono::Utc::now().timestamp();
        let ttl = self.ttl_seconds;
        let before = self.sessions.len();

        self.sessions.retain(|_, s| (now - s.last_update_ts) < ttl);
        
        if self.sessions.len() > self.max_sessions {
             let panic_ttl = ttl / 2;
             self.sessions.retain(|_, s| (now - s.last_update_ts) < panic_ttl);
        }

        let removed = before - self.sessions.len();
        if removed > 0 {
            info!("🧹 GC: {} sessions removed. Active: {}", removed, self.sessions.len());
        }
    }
}
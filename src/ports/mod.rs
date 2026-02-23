// src/ports/mod.rs
use crate::core::domain::LogRecord;
use async_trait::async_trait;
use anyhow::Result;

/// Giriş Adaptörleri (Ingestion) için kontrat
#[async_trait]
pub trait LogIngestor {
    async fn start(&self) -> Result<()>;
}

/// Çıkış Adaptörleri (Export/Storage) için kontrat
/// Phase 3: Şimdilik Emitter'lar pasif (Dormant State).
#[async_trait]
#[allow(dead_code)] 
pub trait LogEmitter: Send + Sync {
    async fn emit(&self, log: LogRecord) -> Result<()>;
    async fn emit_batch(&self, logs: Vec<LogRecord>) -> Result<()>;
    fn name(&self) -> &'static str;
}
// src/ports/mod.rs
use crate::core::domain::LogRecord;
use async_trait::async_trait;
use anyhow::Result;

#[async_trait]
pub trait LogIngestor {
    async fn start(&self) -> Result<()>;
}

#[async_trait]
pub trait LogEmitter: Send + Sync {
    #[allow(dead_code)]
    async fn emit(&self, log: LogRecord) -> Result<()>;
    async fn emit_batch(&self, logs: Vec<LogRecord>) -> Result<()>;
    fn name(&self) -> &'static str;
}
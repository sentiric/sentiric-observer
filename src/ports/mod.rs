use crate::core::domain::LogRecord;
use async_trait::async_trait;
use anyhow::Result;

#[async_trait]
pub trait LogIngestor {
    async fn start(&self) -> Result<()>;
}

/// Gelecekte DB veya File export için kullanılacak
#[async_trait]
#[allow(dead_code)] // Şimdilik sadece WebSocket var, bu trait implement edilmedi
pub trait LogEmitter {
    async fn emit(&self, log: LogRecord) -> Result<()>;
}
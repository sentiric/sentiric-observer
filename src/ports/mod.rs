use crate::core::domain::LogRecord;
use async_trait::async_trait;
use anyhow::Result;

/// Logları sisteme sokan kaynaklar (Docker, gRPC, Sniffer)
#[async_trait]
pub trait LogIngestor {
    /// Ingestor başlatıldığında çalışacak ana döngü
    async fn start(&self) -> Result<()>;
}

/// Logları dışarı aktaran hedefler (WebSocket, DB)
#[async_trait]
pub trait LogEmitter {
    /// İşlenmiş logu dışarı bas
    async fn emit(&self, log: LogRecord) -> Result<()>;
}
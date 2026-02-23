// src/adapters/exporter.rs
use crate::core::domain::LogRecord;
use crate::ports::LogEmitter;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration};
use tracing::{error, info, debug};

/// Logları batch (yığın) halinde hedeflere gönderen yönetici.
pub struct ExportManager {
    emitters: Vec<Arc<dyn LogEmitter>>,
    batch_size: usize,
    flush_interval_secs: u64,
}

impl ExportManager {
    pub fn new(batch_size: usize, flush_interval_secs: u64) -> Self {
        Self {
            emitters: Vec::new(),
            batch_size,
            flush_interval_secs,
        }
    }

    pub fn register_emitter(&mut self, emitter: Arc<dyn LogEmitter>) {
        info!("🔌 Output Adapter Registered: {}", emitter.name());
        self.emitters.push(emitter);
    }

    pub fn start(&self, mut rx: mpsc::Receiver<LogRecord>) {
        if self.emitters.is_empty() {
            info!("⚠️ Export Manager started with NO emitters (Passive Mode).");
            return;
        }

        let emitters = self.emitters.clone();
        let batch_size = self.batch_size;
        let flush_secs = self.flush_interval_secs; 
        let mut flush_ticker = interval(Duration::from_secs(flush_secs));
        
        let buffer = Arc::new(Mutex::new(Vec::with_capacity(batch_size)));

        tokio::spawn(async move {
            info!("📦 Export Worker Active. Batch: {}, Flush: {}s", batch_size, flush_secs);
            loop {
                tokio::select! {
                    Some(log) = rx.recv() => {
                        let mut buf = buffer.lock().await;
                        buf.push(log);
                        
                        if buf.len() >= batch_size {
                            let batch_to_send = buf.clone();
                            buf.clear();
                            Self::flush_to_emitters(&emitters, batch_to_send).await;
                        }
                    }
                    _ = flush_ticker.tick() => {
                        let mut buf = buffer.lock().await;
                        if !buf.is_empty() {
                            let batch_to_send = buf.clone();
                            buf.clear();
                            debug!("⏱️ Timer flush triggered. Sending {} records.", batch_to_send.len());
                            Self::flush_to_emitters(&emitters, batch_to_send).await;
                        }
                    }
                }
            }
        });
    }

    async fn flush_to_emitters(emitters: &[Arc<dyn LogEmitter>], batch: Vec<LogRecord>) {
        for emitter in emitters {
            let emitter_clone = emitter.clone();
            let batch_clone = batch.clone();
            
            tokio::spawn(async move {
                if let Err(e) = emitter_clone.emit_batch(batch_clone).await {
                    error!("❌ Export failed for [{}]: {}", emitter_clone.name(), e);
                }
            });
        }
    }
}
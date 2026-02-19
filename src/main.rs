mod core;
mod adapters;
mod ports;
mod utils;
mod config;

use tracing::{info, error};
use crate::core::domain::LogRecord;
use crate::config::AppConfig;
use crate::ports::LogIngestor; // Trait'i import et
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Config Yükle
    let cfg = AppConfig::load();

    // 2. Loglama Başlat
    tracing_subscriber::fmt::init();
    
    info!("👁️ SENTIRIC OBSERVER v4.0 (Sovereign Edition) Booting...");
    info!("🔧 Config: Host={}, Node={}", cfg.host, cfg.host); // hostname crate kullanılabilir

    // 3. Kanal Kurulumu
    let (tx, mut rx) = mpsc::channel::<LogRecord>(10000);

    // 4. Core Engine (Aggregator Mock)
    tokio::spawn(async move {
        info!("🧠 Core Engine Active. Waiting for telemetry...");
        while let Some(log) = rx.recv().await {
            // Şimdilik sadece formatlı basıyoruz
            println!(
                "[{}] {} | {} | {} | Trace: {:?}", 
                log.ts, 
                log.severity, 
                log.resource.service_name, 
                log.message,
                log.trace_id
            );
        }
    });

    // 5. Docker Ingestor Başlat
    let docker_tx = tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    // Hostname'i dinamik alalım
    let node_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-node".to_string());

    tokio::spawn(async move {
        match adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_name) {
            Ok(ingestor) => {
                if let Err(e) = ingestor.start().await {
                    error!("❌ Docker Ingestor durdu: {}", e);
                }
            },
            Err(e) => {
                error!("❌ Docker Ingestor başlatılamadı (Soket erişimini kontrol et): {}", e);
            }
        }
    });

    // Main thread'i hayatta tut
    info!("🚀 System Ready. Listening on channels...");
    tokio::signal::ctrl_c().await?;
    info!("🛑 Shutdown signal received.");
    
    Ok(())
}
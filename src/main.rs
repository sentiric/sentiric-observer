mod core;
mod adapters;
mod ports;
mod utils; // Henüz boş ama tanımlı kalsın
mod config; // Birazdan oluşturacağız

use tracing::{info, error};
use crate::core::domain::LogRecord;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Observability Başlat (Kendi loglarımız)
    tracing_subscriber::fmt::init();
    
    info!("👁️ SENTIRIC OBSERVER v4.0 (Sovereign Edition) Booting...");

    // 2. Kanal Kurulumu (Actor Model - Backpressure 10k)
    // tx (transmitter) -> Ingestorlar kullanacak
    // rx (receiver)   -> Aggregator/Core kullanacak
    let (tx, mut rx) = mpsc::channel::<LogRecord>(10000);

    // 3. Test Logu Bas (Sistemin çalıştığını görmek için)
    let startup_log = LogRecord::system_log("INFO", "SYSTEM_BOOT", "Observer kernel initialized");
    
    // Core Logic (Şimdilik sadece ekrana basıyoruz - Mock Aggregator)
    tokio::spawn(async move {
        info!("🧠 Core Engine Active. Waiting for telemetry...");
        // Kanalı dinle
        while let Some(log) = rx.recv().await {
            // İleride buraya Aggregator ve WebSocket girecek
            // Şimdilik debug amaçlı ekrana basıyoruz
            println!(
                "[{}] {} | {} | {}", 
                log.ts, log.severity, log.resource.service_name, log.message
            );
        }
    });

    // 4. Ingestion Adaptörlerini Başlat (Phase 2'de Docker eklenecek)
    // Şimdilik kanala manuel veri basıyoruz
    if let Err(e) = tx.send(startup_log).await {
        error!("Failed to inject startup log: {}", e);
    }

    // Main thread'i hayatta tut
    info!("🚀 System Ready. Listening on channels...");
    tokio::signal::ctrl_c().await?;
    info!("🛑 Shutdown signal received.");
    
    Ok(())
}
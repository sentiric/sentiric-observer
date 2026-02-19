mod core;
mod adapters;
mod ports;
mod utils;
mod config;
mod api; // API modülünü ekledik

use tracing::{info, error, warn};
use crate::core::domain::LogRecord;
use crate::config::AppConfig;
use crate::core::aggregator::Aggregator;
use tokio::sync::{mpsc, broadcast};
use std::sync::Arc;
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Config & Log
    let cfg = AppConfig::load();
    tracing_subscriber::fmt::init();
    
    info!("👁️ SENTIRIC OBSERVER v4.0 (Sovereign Edition) Booting...");

    // 2. KANALLAR (The Nervous System)
    // Ingest -> Aggregator (MPSC: Çoklu giriş, tek çıkış)
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(10000);
    
    // Aggregator -> UI (Broadcast: Tek çıkış, çoklu dinleyici)
    // Kapasite: 1000 log (UI yavaşsa eski logları atar, bellek şişmez)
    let (ui_tx, _) = broadcast::channel::<LogRecord>(1000);

    // 3. CORE ENGINE (Aggregator)
    let aggregator_ui_tx = ui_tx.clone(); // Aggregator kullanacak
    
    tokio::spawn(async move {
        info!("🧠 Core Engine Active.");
        let mut aggregator = Aggregator::new();
        
        while let Some(log) = ingest_rx.recv().await {
            // A. Logu işle ve Session güncelle
            let _session = aggregator.process(log.clone());
            
            // B. Logu UI'a fırlat (Canlı akış)
            // Not: İleride sadece 'session' güncellemesi de atabiliriz
            if let Err(e) = aggregator_ui_tx.send(log) {
                // Bu hata, hiç kimse UI'a bağlı değilse normaldir
                warn!("UI Broadcast hatası (Dinleyici yok mu?): {}", e);
            }
            
            aggregator.cleanup();
        }
    });

    // 4. INGESTION (Docker)
    let docker_tx = ingest_tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    let node_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());

    tokio::spawn(async move {
        match adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_name) {
            Ok(ingestor) => {
                use crate::ports::LogIngestor; // Trait import
                if let Err(e) = ingestor.start().await {
                    error!("❌ Docker Ingestor Runtime Error: {}", e);
                }
            },
            Err(e) => error!("❌ Docker Ingestor Connection Error: {}", e),
        }
    });

    // 5. WEB SERVER (Axum)
    let app_state = Arc::new(api::routes::AppState { tx: ui_tx });
    let app = api::routes::create_router(app_state);
    
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));
    info!("🌍 UI Dashboard: http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
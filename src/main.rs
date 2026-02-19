mod core;
mod adapters;
mod ports;
mod utils;
mod config;
mod api; // API modülünü dahil ediyoruz

use tracing::{info, error, warn};
use crate::core::domain::LogRecord;
use crate::config::AppConfig;
use crate::core::aggregator::Aggregator;
use tokio::sync::{mpsc, broadcast};
use std::sync::Arc;
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Config Yükle
    let cfg = AppConfig::load();

    // 2. Loglama Başlat
    tracing_subscriber::fmt::init();
    
    info!("👁️ SENTIRIC OBSERVER v4.0 (Sovereign Edition) Booting...");
    info!("🔧 Config: Host={}, HTTP={}, gRPC={}, Docker={}", 
        cfg.host, cfg.http_port, cfg.grpc_port, cfg.docker_socket);

    // 3. KANALLAR (The Nervous System)
    // Ingest -> Aggregator (MPSC: Çoklu giriş, tek çıkış)
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(10000);
    
    // Aggregator -> UI (Broadcast: Tek çıkış, çoklu dinleyici)
    // Kapasite: 1000 log (UI yavaşsa eski logları atar, bellek şişmez)
    let (ui_tx, _) = broadcast::channel::<LogRecord>(1000);

    // 4. CORE ENGINE (Aggregator)
    let aggregator_ui_tx = ui_tx.clone(); // Aggregator kullanacak
    
    tokio::spawn(async move {
        info!("🧠 Core Engine Active.");
        let mut aggregator = Aggregator::new();
        
        while let Some(log) = ingest_rx.recv().await {
            // A. Logu işle ve Session güncelle
            let _session = aggregator.process(log.clone());
            
            // B. Logu UI'a fırlat (Canlı akış)
            // Not: İleride sadece 'session' güncellemesi de atabiliriz
            if let Err(_) = aggregator_ui_tx.send(log) {
                // Dinleyici yoksa hata vermesi normal, loglamaya gerek yok
            }
            
            aggregator.cleanup();
        }
    });

    // 5. INGESTION (Docker)
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

    // 6. WEB SERVER (Axum)
    // AppState oluştur
    let app_state = Arc::new(api::routes::AppState { tx: ui_tx });
    // Router oluştur
    let app = api::routes::create_router(app_state);
    
    // Adres Bind et
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));
    info!("🌍 UI Dashboard Active: http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
mod core;
mod adapters;
mod ports;
mod utils;
mod config;
mod api;

use tracing::{info, error};
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
    // ingest_tx -> Veri Girişi (Docker, gRPC)
    // ui_tx     -> Veri Çıkışı (WebSocket)
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(10000);
    let (ui_tx, _) = broadcast::channel::<LogRecord>(1000);

    // 4. CORE ENGINE (Aggregator - The Brain)
    let aggregator_ui_tx = ui_tx.clone();
    
    tokio::spawn(async move {
        info!("🧠 Core Engine Active.");
        let mut aggregator = Aggregator::new();
        
        while let Some(log) = ingest_rx.recv().await {
            // A. Logu işle ve Session güncelle (Trace ID Correlation)
            let _session = aggregator.process(log.clone());
            
            // B. Logu UI'a fırlat (Canlı akış)
            if let Err(_) = aggregator_ui_tx.send(log) {
                // Dinleyici yoksa hata vermesi normaldir (Drop)
            }
            
            // C. Temizlik (Garbage Collection)
            aggregator.cleanup();
        }
    });

    // 5. INGESTION: Docker Adapter
    let docker_tx = ingest_tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    let node_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());

    tokio::spawn(async move {
        match adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_name) {
            Ok(ingestor) => {
                use crate::ports::LogIngestor; 
                if let Err(e) = ingestor.start().await {
                    error!("❌ Docker Ingestor Runtime Error: {}", e);
                }
            },
            Err(e) => error!("❌ Docker Ingestor Connection Error: {}", e),
        }
    });

    // 6. INGESTION: gRPC Server
    let grpc_tx = ingest_tx.clone();
    // DÜZELTME: [0, 0, 0, 0] ile tüm arayüzleri dinle
    let grpc_addr = SocketAddr::from(([0, 0, 0, 0], cfg.grpc_port));
    
    tokio::spawn(async move {
        info!("📡 gRPC Ingest Server Active: {}", grpc_addr);
        let state = api::grpc::GrpcServerState { tx: grpc_tx };
        
        let server = tonic::transport::Server::builder()
            .add_service(api::grpc::observer_proto::observer_service_server::ObserverServiceServer::new(state))
            .serve(grpc_addr);
            
        if let Err(e) = server.await {
            error!("❌ KRİTİK: gRPC Server başlatılamadı (Port dolu olabilir): {}", e);
        }
    });

    // 7. PRESENTATION: Web Server & WebSocket (Axum)
    let app_state = Arc::new(api::routes::AppState { tx: ui_tx });
    let app = api::routes::create_router(app_state);
    
    // DÜZELTME: [0, 0, 0, 0] ile tüm arayüzleri dinle
    let http_addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));
    info!("🌍 UI Dashboard Active: http://{}", http_addr);

    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
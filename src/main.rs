mod core;
mod adapters;
mod ports;
mod utils;
mod config;
mod api;

use tracing::{info, error, warn};
use crate::core::domain::LogRecord;
use crate::config::AppConfig;
use crate::core::aggregator::Aggregator;
use crate::ports::LogIngestor; 
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
    info!("🔧 Config: Host={}, HTTP={}, Sniffer={}", 
        cfg.host, cfg.http_port, cfg.sniffer_enabled);

    // 3. KANALLAR
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(10000);
    let (ui_tx, _) = broadcast::channel::<LogRecord>(1000);

    // 4. CORE ENGINE (Config ile Başlatılıyor)
    let aggregator_ui_tx = ui_tx.clone();
    let max_sessions = cfg.max_active_sessions;
    let ttl_seconds = cfg.session_ttl_seconds;

    tokio::spawn(async move {
        info!("🧠 Core Engine Active (Max: {}, TTL: {}s)", max_sessions, ttl_seconds);
        // Parametreler config'den geliyor
        let mut aggregator = Aggregator::new(max_sessions, ttl_seconds);
        
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));

        loop {
            tokio::select! {
                // Log Gelirse İşle
                Some(log) = ingest_rx.recv() => {
                    let _session = aggregator.process(log.clone());
                    if let Err(_) = aggregator_ui_tx.send(log) {}
                }
                // Periyodik Temizlik (10 saniyede bir)
                _ = cleanup_interval.tick() => {
                    aggregator.cleanup();
                }
            }
        }
    });

    // 5. INGESTION: Docker Adapter (Her zaman açık)
    let docker_tx = ingest_tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    let node_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    let node_name_clone = node_name.clone();

    tokio::spawn(async move {
        // Docker ingest logic...
        match adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_name_clone) {
            Ok(ingestor) => { if let Err(e) = ingestor.start().await { error!("Docker Error: {}", e); } },
            Err(e) => error!("Docker Connect Error: {}", e),
        }
    });

    // 6. INGESTION: gRPC Server (Her zaman açık)
    let grpc_tx = ingest_tx.clone();
    let grpc_addr = SocketAddr::from(([0, 0, 0, 0], cfg.grpc_port));
    
    tokio::spawn(async move {
        // gRPC logic...
        let state = api::grpc::GrpcServerState { tx: grpc_tx };
        let server = tonic::transport::Server::builder()
            .add_service(api::grpc::observer_proto::observer_service_server::ObserverServiceServer::new(state))
            .serve(grpc_addr);
        if let Err(e) = server.await { error!("gRPC Error: {}", e); }
    });

    // 7. INGESTION: Network Sniffer (CONFIG CONTROLLED)
    if cfg.sniffer_enabled {
        let sniffer_tx = ingest_tx.clone();
        let sniffer_node = node_name.clone();
        let interface = cfg.sniffer_interface.clone();
        let filter = cfg.sniffer_filter.clone();

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        tokio::spawn(async move {
            info!("🕸️ Sniffer Module ENABLED. Device: {}, Filter: {}", interface, filter);
            let sniffer = adapters::sniffer::NetworkSniffer::new(&interface, &filter, sniffer_tx, sniffer_node);
            
            match sniffer.start().await {
                Ok(_) => info!("🕸️ Sniffer stopped cleanly."),
                Err(e) => warn!("⚠️ Sniffer failed to start: {}", e),
            }
        });
    } else {
        info!("zzz Sniffer Module DISABLED (Performans Modu). Trafik dinlenmiyor.");
    }

    // 8. PRESENTATION: Web Server
    let app_state = Arc::new(api::routes::AppState { tx: ui_tx });
    let app = api::routes::create_router(app_state);
    let http_addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));
    
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
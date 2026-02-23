// src/main.rs
mod core;
mod adapters;
mod ports;
mod utils;
mod config;
mod api;

use tracing::{info, error}; 
use crate::config::AppConfig;
use crate::core::aggregator::Aggregator;
use crate::core::domain::LogRecord;
use crate::ports::LogIngestor; 
use tokio::sync::{mpsc, broadcast};
use std::sync::{Arc, atomic::AtomicBool};
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    
    // 1. Config Yükle
    let cfg = AppConfig::load();

    // 2. Loglama Başlat
    tracing_subscriber::fmt::init();
    
    info!("👁️ SENTIRIC OBSERVER v4.1 (Sniffer-Ready) Booting...");
    info!("🚀 Environment: {}", cfg.env);
    info!("🔧 Bind: {}:{}", cfg.host, cfg.http_port); 
    info!("🔧 Metric Port: {} (Reserved for Prometheus)", cfg.metric_port);


    // Kanallar
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(10000);
    let (ui_tx, _) = broadcast::channel::<LogRecord>(1000);

    // STATE: Sniffer Kontrol Bayrağı
    // Config'deki varsayılan değerle başla
    let sniffer_active = Arc::new(AtomicBool::new(cfg.sniffer_enabled));

    // Aggregator Task (Değişmedi)
    let aggregator_ui_tx = ui_tx.clone();
    let max_sessions = cfg.max_active_sessions;
    let ttl_seconds = cfg.session_ttl_seconds;
    tokio::spawn(async move {
        let mut aggregator = Aggregator::new(max_sessions, ttl_seconds);
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        loop {
            tokio::select! {
                Some(mut log) = ingest_rx.recv() => {
                    // Trace ID Injection Logic...
                    if log.trace_id.is_none() {
                        if let Some(call_id_val) = log.attributes.get("sip.call_id") {
                             if let Some(s) = call_id_val.as_str() { log.trace_id = Some(s.to_string()); }
                        }
                    }
                    let _ = aggregator.process(log.clone());
                    let _ = aggregator_ui_tx.send(log);
                }
                _ = cleanup_interval.tick() => { aggregator.cleanup(); }
            }
        }
    });

    // Node Name
    let node_name = hostname::get().map(|h| h.to_string_lossy().into_owned()).unwrap_or("unknown".into());

    // Sniffer Task
    let sniffer_tx = ingest_tx.clone();
    let sniffer_flag = sniffer_active.clone();
    let interface = cfg.sniffer_interface.clone();
    let filter = cfg.sniffer_filter.clone();
    let sniffer_node = node_name.clone();

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    tokio::spawn(async move {
        let sniffer = adapters::sniffer::NetworkSniffer::new(&interface, &filter, sniffer_tx, sniffer_node, sniffer_flag);
        if let Err(e) = sniffer.start().await {
            error!("Sniffer init failed: {}", e);
        }
    });

    // Docker & gRPC Ingestors (Değişmedi - Kısaltıldı)
    let docker_tx = ingest_tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    let node_clone = node_name.clone();
    tokio::spawn(async move {
        if let Ok(ingestor) = adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_clone) {
            let _ = ingestor.start().await;
        }
    });
    
    let grpc_tx = ingest_tx.clone();
    let grpc_addr = SocketAddr::from(([0, 0, 0, 0], cfg.grpc_port));
    tokio::spawn(async move {
        let state = api::grpc::GrpcServerState { tx: grpc_tx };
        let server = tonic::transport::Server::builder()
            .add_service(api::grpc::observer_proto::observer_service_server::ObserverServiceServer::new(state))
            .serve(grpc_addr);
        let _ = server.await;
    });

    // API & UI
    let app_state = Arc::new(api::routes::AppState { 
        tx: ui_tx, 
        sniffer_active, // State'e eklendi
        config: cfg.clone() 
    });
    
    let app = api::routes::create_router(app_state);
    let http_addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
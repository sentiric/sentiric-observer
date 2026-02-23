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
    
    info!("👁️ SENTIRIC OBSERVER v4.5 (Omniscient Mode) Booting...");
    info!("🚀 Environment: {}", cfg.env);
    info!("🔧 Bind: {}:{}", cfg.host, cfg.http_port); 
    info!("🔧 Metric Port: {} (Reserved for Prometheus)", cfg.metric_port);

    // KANALLAR
    // ingest_tx: Docker/Sniffer -> Aggregator (MPSC)
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(10000);
    // ui_tx: Aggregator -> WebSocket & Export (Broadcast)
    let (ui_tx, _) = broadcast::channel::<LogRecord>(10000);

    // STATE: Sniffer Kontrol Bayrağı
    let sniffer_active = Arc::new(AtomicBool::new(cfg.sniffer_enabled));

    // --- 3. AGGREGATOR TASK (Core Logic) ---
    // ui_tx'in bir kopyasını alıyoruz
    let aggregator_ui_tx = ui_tx.clone();
    let max_sessions = cfg.max_active_sessions;
    let ttl_seconds = cfg.session_ttl_seconds;
    
    tokio::spawn(async move {
        let mut aggregator = Aggregator::new(max_sessions, ttl_seconds);
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        loop {
            tokio::select! {
                Some(mut log) = ingest_rx.recv() => {
                    // Trace ID Injection Logic
                    if log.trace_id.is_none() {
                        if let Some(call_id_val) = log.attributes.get("sip.call_id") {
                             if let Some(s) = call_id_val.as_str() { log.trace_id = Some(s.to_string()); }
                        }
                    }
                    let _ = aggregator.process(log.clone());
                    // İşlenen logu UI ve Export kanallarına yayınla
                    let _ = aggregator_ui_tx.send(log);
                }
                _ = cleanup_interval.tick() => { aggregator.cleanup(); }
            }
        }
    });

    // Node Name
    let node_name = hostname::get().map(|h| h.to_string_lossy().into_owned()).unwrap_or("unknown".into());

    // --- 4. INGESTION ADAPTERS ---

    // A. Sniffer (Linux/Mac Only)
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

    // B. Docker
    let docker_tx = ingest_tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    let node_clone = node_name.clone();
    tokio::spawn(async move {
        if let Ok(ingestor) = adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_clone) {
            let _ = ingestor.start().await;
        }
    });
    
    // C. gRPC Ingest Server (Port 11071)
    let grpc_tx = ingest_tx.clone();
    let grpc_addr = SocketAddr::from(([0, 0, 0, 0], cfg.grpc_port));
    tokio::spawn(async move {
        let state = api::grpc::GrpcServerState { tx: grpc_tx };
        let server = tonic::transport::Server::builder()
            .add_service(api::grpc::observer_proto::observer_service_server::ObserverServiceServer::new(state))
            .serve(grpc_addr);
        if let Err(e) = server.await {
            error!("gRPC Server Error: {}", e);
        }
    });

    // --- 5. OMNISCIENT LINK (Upstream Export) ---
    // Bu kısım Agent modunda çalışırken logları Master'a yollar.
    let upstream_url = std::env::var("UPSTREAM_OBSERVER_URL").unwrap_or_default();
    
    if !upstream_url.is_empty() {
        info!("🚀 OMNISCIENT MODE: Activating Upstream Link -> {}", upstream_url);
        
        // Export Manager
        let mut export_manager = adapters::exporter::ExportManager::new(50, 2); // 50 log veya 2sn
        // gRPC Emitter
        export_manager.register_emitter(Arc::new(adapters::grpc_client::GrpcEmitter::new(upstream_url)));
        
        // Broadcast kanalına abone ol (UI ile aynı veriyi alır)
        // [DÜZELTME]: ui_tx.subscribe() yerine ui_tx.clone().subscribe() değil, 
        // direkt ui_tx üzerinden subscribe alabiliriz ama sonra ui_tx move olacaksa clone şart.
        // Aşağıda ui_tx'i AppState'e veriyoruz, o yüzden burada subscribe alıp devam edebiliriz 
        // çünkü subscribe() &self alır, sahiplik almaz.
        // ANCAK AppState move edeceği için, AppState'e clone verelim.
        
        let mut rx_export = ui_tx.subscribe();
        let (bridge_tx, bridge_rx) = mpsc::channel(2000);
        
        tokio::spawn(async move {
            while let Ok(log) = rx_export.recv().await {
                // Loop Prevention: Eğer bu log zaten gRPC'den geldiyse, tekrar geri yollama!
                if let Some(src) = log.attributes.get("source") {
                    if src.as_str() == Some("grpc") { continue; }
                }
                
                // MPSC kanalına kopyala
                let _ = bridge_tx.send(log).await;
            }
        });
        
        export_manager.start(bridge_rx);
    }

    // --- 6. API & UI SERVER ---
    // [DÜZELTME]: ui_tx burada move oluyor. Yukarıda subscribe() çağırdığımız için sorun yok.
    // Ancak temizlik adına clone kullanabiliriz.
    let app_state = Arc::new(api::routes::AppState { 
        tx: ui_tx, // Sahiplik buraya geçti
        sniffer_active, 
        config: cfg.clone() 
    });
    
    let app = api::routes::create_router(app_state);
    let http_addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));
    
    // HTTP Sunucusu
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
mod model;
mod config;
mod engine;
mod api;
mod utils; // BU SATIRI EKLEYİN (Genelde mod api; satırının altına)

use std::sync::Arc;
use std::net::SocketAddr;
use tokio::sync::broadcast;
use tracing::{info, error};

use crate::api::routes::AppState;
use crate::api::grpc::observer_proto::observer_service_server::ObserverServiceServer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    info!("👁️ SENTIRIC OBSERVER v3.5 (Sovereign) Başlatılıyor...");
    
    let cfg = config::AppConfig::load();
    let (tx, _) = broadcast::channel::<model::OtelLogRecord>(10000);
    let state = Arc::new(AppState { tx: tx.clone() });

    // 2. Harvester Motorunu Çalıştır (Config'den gelen soketi veriyoruz)
    let harvester_tx = tx.clone();
    let node_name = cfg.node_name.clone();
    let socket_path = cfg.docker_socket.clone(); // Config'den aldık
    tokio::spawn(async move {
        let harvester = engine::harvester::DockerHarvester::new(harvester_tx, node_name, socket_path);
        harvester.run().await;
    });

    // 3. Sniffer
    if cfg.enable_sniffer {
        let sniffer = engine::sniffer::NetworkSniffer::new(tx.clone(), cfg.node_name.clone());
        sniffer.start();
    }

    // 4. gRPC Ingest Server
    let grpc_state = state.clone();
    let grpc_addr: SocketAddr = format!("{}:{}", cfg.host, cfg.grpc_port).parse()
        .map_err(|e| anyhow::anyhow!("Geçersiz gRPC adresi: {}", e))?;

    tokio::spawn(async move {
        info!("📡 gRPC Ingest API dinleniyor: {}", grpc_addr);
        let server = tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new((*grpc_state).clone()))
            .serve(grpc_addr);

        if let Err(e) = server.await {
            error!("❌ KRİTİK: gRPC Server başlatılamadı (Port {} dolu olabilir): {}", grpc_addr, e);
            std::process::exit(1); // Port doluysa uygulamayı kapat ki debug yapabilelim
        }
    });

    // 5. Web UI & WebSocket Server
    let app = api::routes::create_router(state);
    let http_addr: SocketAddr = format!("{}:{}", cfg.host, cfg.http_port).parse()
        .map_err(|e| anyhow::anyhow!("Geçersiz HTTP adresi: {}", e))?;

    info!("🌍 Observer UI aktif: http://{}", http_addr);
    
    let listener = tokio::net::TcpListener::bind(http_addr).await
        .map_err(|e| anyhow::anyhow!("❌ KRİTİK: HTTP Port {} bağlanamadı: {}", http_addr, e))?;

    axum::serve(listener, app).await?;

    Ok(())
}
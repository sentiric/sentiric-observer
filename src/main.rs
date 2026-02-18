mod docker_harvester;
mod model;
mod sniffer; // Yeni eklediğimiz sniffer modülü

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, error, warn};

// gRPC Proto Tanımları
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::{IngestLogRequest, IngestLogResponse};

// Frontend (V3.0 HTML) Gömülü
const INDEX_HTML: &str = include_str!("index.html");

#[derive(Clone)]
pub struct AppState {
    pub tx: broadcast::Sender<String>,
    pub host_name: String,
}

// gRPC Servis Uygulaması (Uzak node'lardan gelen logları kabul eder)
#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(
        &self,
        request: tonic::Request<IngestLogRequest>,
    ) -> Result<tonic::Response<IngestLogResponse>, tonic::Status> {
        let req = request.into_inner();
        
        // Uzak node'dan gelen veriyi Otel formatına sokup yerel WebSocket'e bas
        let log = model::OtelLogRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            severity_text: req.level.to_uppercase(),
            body: req.message,
            resource: model::OtelResource {
                service_name: req.service_name,
                host_name: if req.node_id.is_empty() { "remote-node".into() } else { req.node_id },
            },
            attributes: serde_json::json!({ "source": "grpc_relay" }),
        };

        if let Ok(json_str) = serde_json::to_string(&log) {
            let _ = self.tx.send(json_str);
        }

        Ok(tonic::Response::new(IngestLogResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Loglama ve Node Kimliği
    tracing_subscriber::fmt::init();
    info!("👁️ SENTIRIC PANOPTICON v3.0 Başlatılıyor...");

    let host_name = std::env::var("NODE_NAME").unwrap_or_else(|_| {
        hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unknown-node".into())
    });

    // 2. Merkezi Mesaj Kanalı (Tüm veriler buradan geçer)
    let (tx, _rx) = broadcast::channel::<String>(10000);
    let state = Arc::new(AppState { 
        tx: tx.clone(),
        host_name: host_name.clone(),
    });

    // 3. MOTORLARI BAŞLAT
    
    // A. Docker Harvester (Konteyner Logları)
    let harvester = docker_harvester::DockerHarvester::new(tx.clone(), host_name.clone());
    tokio::spawn(async move {
        harvester.run().await;
    });

    // B. RTP Sniffer (Ağ Paket Analizi) - Eğer env aktifse
    if std::env::var("ENABLE_NETWORK_SNIFFER").unwrap_or_default() == "true" {
        let sniffer_tx = tx.clone();
        let sniffer_host = host_name.clone();
        tokio::spawn(async move {
            let sniffer_engine = sniffer::RtpSniffer::new(sniffer_tx, sniffer_host);
            sniffer_engine.run().await;
        });
    }

    // C. gRPC Server (Ingest - Port 11071)
    let grpc_state = state.clone();
    tokio::spawn(async move {
        let addr: SocketAddr = "0.0.0.0:11071".parse().unwrap();
        info!("📡 gRPC Ingest API: {}", addr);
        let _ = tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new((*grpc_state).clone()))
            .serve(addr)
            .await;
    });

    // D. Web & WebSocket Server (Dashboard - Port 11070)
    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 11070));
    info!("🌍 Panopticon UI: http://{}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn index_handler() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.tx.subscribe();
    while let Ok(msg) = rx.recv().await {
        if socket.send(Message::Text(msg)).await.is_err() {
            break; // Bağlantı koptuysa döngüden çık
        }
    }
}
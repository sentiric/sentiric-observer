// sentiric-observer/src/main.rs
mod docker_harvester;
mod model;

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
use tracing::{info, error};

// gRPC Proto Tanımları
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::{IngestLogRequest, IngestLogResponse};

// Frontend (HTML) Gömülü
const INDEX_HTML: &str = include_str!("index.html");

#[derive(Clone)]
struct AppState {
    tx: broadcast::Sender<String>,
    host_name: String,
}

// gRPC Servis Uygulaması (Diğer Node'lardan log kabul eder)
#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(
        &self,
        request: tonic::Request<IngestLogRequest>,
    ) -> Result<tonic::Response<IngestLogResponse>, tonic::Status> {
        let req = request.into_inner();
        
        // Gelen gRPC logunu OTEL JSON formatına çevirip WebSocket'e bas
        let log = model::OtelLogRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            severity_text: req.level.to_uppercase(),
            body: req.message,
            resource: model::OtelResource {
                service_name: req.service_name,
                host_name: req.node_id, // Kaynak node ismi
            },
            attributes: Some(serde_json::json!({ "trace_id": req.trace_id, "source": "grpc" })),
        };

        if let Ok(json_str) = serde_json::to_string(&log) {
            let _ = self.tx.send(json_str);
        }

        Ok(tonic::Response::new(IngestLogResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    info!("👁️ Sentiric Observer v2.0 (Panopticon) Başlatılıyor...");

    let (tx, _rx) = broadcast::channel::<String>(5000);
    let host_name = std::env::var("NODE_NAME").unwrap_or("unknown-node".to_string());
    
    let state = Arc::new(AppState { 
        tx: tx.clone(),
        host_name: host_name.clone(),
    });

    // 1. Docker Harvester Başlat (Local Loglar)
    let harvester = docker_harvester::DockerHarvester::new(tx.clone(), host_name);
    tokio::spawn(async move {
        harvester.run().await;
    });

    // 2. gRPC Server Başlat (Remote Loglar - Port 11071)
    let grpc_state = state.clone();
    tokio::spawn(async move {
        let addr = "0.0.0.0:11071".parse().unwrap();
        info!("📡 gRPC Ingest aktif: {}", addr);
        if let Err(e) = tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new((*grpc_state).clone()))
            .serve(addr)
            .await {
                error!("gRPC Server Error: {}", e);
            }
    });

    // 3. Web & WebSocket Server Başlat (Port 11070)
    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 11070));
    info!("🌍 UI & WebSocket aktif: http://{}", addr);
    
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
            break;
        }
    }
}
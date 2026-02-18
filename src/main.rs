mod docker_harvester;
mod model;
mod sniffer;

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
use tracing::info;

pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::{IngestLogRequest, IngestLogResponse};

const INDEX_HTML: &str = include_str!("index.html");

#[derive(Clone)]
pub struct AppState {
    pub tx: broadcast::Sender<String>,
}

#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log( &self, request: tonic::Request<IngestLogRequest>) -> Result<tonic::Response<IngestLogResponse>, tonic::Status> {
        let req = request.into_inner();
        let log = model::OtelLogRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            severity_text: req.level.to_uppercase(),
            body: req.message,
            resource: model::OtelResource {
                service_name: req.service_name,
                host_name: req.node_id,
            },
            attributes: serde_json::json!({ "source": "remote_grpc" }),
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
    info!("👁️ SENTIRIC PANOPTICON v3.2 (Sovereign) Başlatılıyor...");

    let host_name = std::env::var("NODE_NAME").unwrap_or_else(|_| {
        hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unknown-node".into())
    });

    let (tx, _rx) = broadcast::channel::<String>(10000);
    let state = Arc::new(AppState { tx: tx.clone() });

    // --- Motorları Devreye Al ---

    // 1. Docker Log Toplayıcı
    let harvester = docker_harvester::DockerHarvester::new(tx.clone(), host_name.clone());
    tokio::spawn(async move {
        harvester.run().await;
    });

    // 2. Ağ Sniffer Motoru (Eğer aktifse)
    if std::env::var("ENABLE_NETWORK_SNIFFER").unwrap_or_default() == "true" {
        sniffer::spawn_sniffer_task(tx.clone(), host_name.clone());
    }

    // 3. gRPC Sunucusu (Diğer node'lardan log almak için)
    let grpc_state = state.clone();
    tokio::spawn(async move {
        let addr: SocketAddr = "0.0.0.0:11071".parse().unwrap();
        info!("📡 gRPC Ingest API dinleniyor: {}", addr);
        let _ = tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new((*grpc_state).clone()))
            .serve(addr)
            .await;
    });

    // 4. Web & WebSocket Sunucusu (UI)
    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 11070));
    info!("🌍 Panopticon UI arayüzü aktif: http://{}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn index_handler() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn ws_handler( ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
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
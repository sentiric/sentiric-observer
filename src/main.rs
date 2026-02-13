// sentiric-observer/src/main.rs

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Html,
    routing::get,
    Router,
};
use bollard::container::LogOutput;
use bollard::Docker;
use futures_util::stream::StreamExt;
use std::env;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn}; // 'debug' ve 'error' kullanılmadığı için çıkarıldı

// gRPC Generated Code
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::{IngestLogRequest, IngestLogResponse};
use tonic::{Request, Response, Status};

// --- gRPC SERVICE IMPLEMENTATION ---
pub struct MyObserver {
    tx: Arc<broadcast::Sender<String>>,
}

#[tonic::async_trait]
impl ObserverService for MyObserver {
    async fn ingest_log(&self, request: Request<IngestLogRequest>) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();
        
        let formatted = format!(
            "[{}] [{}] [{}] {}",
            chrono::Utc::now().format("%H:%M:%S"),
            req.service_name.to_uppercase(),
            req.level.to_uppercase(),
            req.message
        );

        // UI'a ve terminale bas
        println!("{}", formatted);
        let _ = self.tx.send(formatted);

        Ok(Response::new(IngestLogResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logger başlat
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("👁️ Sentiric Observer v0.2.0 starting...");

    let self_id = env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into());
    let docker = Arc::new(Docker::connect_with_local_defaults().expect("Docker connection fail"));
    
    // Merkezi Yayın Kanalı
    let (tx, _) = broadcast::channel::<String>(5000); 
    let tx = Arc::new(tx);

    // 1. Docker Harvester Task
    let containers = docker.list_containers::<String>(None).await?;
    for container in containers {
        let container_id = container.id.expect("Container ID missing");
        let container_name = container.names.unwrap_or_default().join("");
        
        // Kendi logumuzu dinleyip sonsuz döngüye girmeyelim
        if container_id.starts_with(&self_id) || container_name.contains("observer-service") {
            continue;
        }

        let docker_clone = docker.clone();
        let tx_clone = tx.clone();
        let name_display = container_name.trim_start_matches('/').to_string();

        tokio::spawn(async move {
            let options = bollard::container::LogsOptions {
                follow: true,
                stdout: true,
                stderr: true,
                tail: "10", 
                ..Default::default()
            };

            let mut logs_stream = docker_clone.logs(&container_id, Some(options));
            while let Some(log_result) = logs_stream.next().await {
                if let Ok(log) = log_result {
                    let log_text = match log {
                        LogOutput::StdOut { message } => String::from_utf8_lossy(&message).to_string(),
                        LogOutput::StdErr { message } => String::from_utf8_lossy(&message).to_string(),
                        _ => continue,
                    };

                    if log_text.trim().is_empty() { continue; }

                    let formatted = format!(
                        "[{}] [{}] {}",
                        chrono::Utc::now().format("%H:%M:%S"),
                        name_display,
                        log_text.trim()
                    );
                    println!("{}", formatted);
                    let _ = tx_clone.send(formatted);
                }
            }
        });
    }

    // 2. HTTP/WebSocket Sunucusu (Port 11070)
    let tx_for_axum = tx.clone();
    let axum_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/", get(index_handler))
            .route("/ws", get(ws_handler))
            .with_state(tx_for_axum);
        
        // Harmonik port 11070
        let listener = tokio::net::TcpListener::bind("0.0.0.0:11070").await.unwrap();
        info!("🚀 Portal UI active at http://localhost:11070");
        axum::serve(listener, app).await.unwrap();
    });

    // 3. gRPC Ingest Sunucusu (Port 11071)
    let tx_for_grpc = tx.clone();
    let grpc_task = tokio::spawn(async move {
        // Harmonik port 11071
        let addr = "0.0.0.0:11071".parse().unwrap();
        let svc = MyObserver { tx: tx_for_grpc };
        info!("📥 gRPC Ingest active at 0.0.0.0:11071");
        tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new(svc))
            .serve(addr)
            .await.unwrap();
    });

    // Her iki sunucuyu paralel olarak sonsuza kadar çalıştır
    let _ = tokio::join!(axum_task, grpc_task);

    Ok(())
}

// --- Axum Handlers ---
async fn index_handler() -> Html<&'static str> {
    Html(include_str!("index.html"))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<Arc<broadcast::Sender<String>>>,
) -> axum::response::Response {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, tx: Arc<broadcast::Sender<String>>) {
    let mut rx = tx.subscribe();
    while let Ok(msg) = rx.recv().await {
        if socket.send(Message::Text(msg)).await.is_err() {
            break;
        }
    }
}
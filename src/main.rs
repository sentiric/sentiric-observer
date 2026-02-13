// sentiric-observer/src/main.rs

use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
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
use tracing::info;
use regex::Regex;

pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::observer_service_client::ObserverServiceClient;
use observer_proto::{IngestLogRequest, IngestLogResponse};
use tonic::{Request, Response, Status};

lazy_static::lazy_static! {
    static ref ANSI_REGEX: Regex = Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
}

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
            req.node_id.to_uppercase(),
            req.service_name.to_uppercase(),
            req.message
        );

        let _ = self.tx.send(formatted);
        Ok(Response::new(IngestLogResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let node_name = env::var("NODE_NAME").unwrap_or_else(|_| "unknown-node".into());
    let upstream_url = env::var("UPSTREAM_OBSERVER_URL").ok();
    let self_id = env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into());

    info!("👁️ Sentiric Observer v0.3.0 | Node: {} starting...", node_name);

    let docker = Arc::new(Docker::connect_with_local_defaults().expect("Docker connection failed"));
    let (tx, _) = broadcast::channel::<String>(5000); 
    let tx = Arc::new(tx);

    // --- 1. FORWARDER TASK (Nexus'a Veri Gönderimi) ---
    if let Some(url) = upstream_url.filter(|u| !u.is_empty()) {
        let tx_clone = tx.clone();
        let node_id_clone = node_name.clone();
        tokio::spawn(async move {
            info!("🔗 Upstream detected. Forwarding logs to: {}", url);
            let mut rx = tx_clone.subscribe();
            loop {
                match ObserverServiceClient::connect(url.clone()).await {
                    Ok(mut client) => {
                        info!("✅ Connected to Nexus: {}", url);
                        while let Ok(msg) = rx.recv().await {
                            let req = IngestLogRequest {
                                service_name: "HARVESTER".into(),
                                message: msg,
                                level: "INFO".into(),
                                trace_id: "".into(),
                                node_id: node_id_clone.clone(),
                            };
                            if client.ingest_log(req).await.is_err() {
                                info!("❌ Nexus connection lost.");
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    }
                }
            }
        });
    }

    // --- 2. DOCKER HARVESTER TASK ---
    let containers = docker.list_containers::<String>(None).await?;
    for container in containers {
        let container_id = container.id.expect("ID missing");
        let container_name = container.names.unwrap_or_default().join("");
        
        if container_id.starts_with(&self_id) || container_name.contains("observer-service") {
            continue;
        }

        let docker_clone = docker.clone();
        let tx_clone = tx.clone();
        let name_display = container_name.trim_start_matches('/').to_string();

        tokio::spawn(async move {
            let options = bollard::container::LogsOptions {
                follow: true, stdout: true, stderr: true, tail: "5", ..Default::default()
            };

            let mut logs_stream = docker_clone.logs(&container_id, Some(options));
            while let Some(Ok(log)) = logs_stream.next().await {
                let log_text = match log {
                    LogOutput::StdOut { message } => String::from_utf8_lossy(&message).to_string(),
                    LogOutput::StdErr { message } => String::from_utf8_lossy(&message).to_string(),
                    _ => continue,
                };

                let clean_text = ANSI_REGEX.replace_all(&log_text, "").to_string();
                if clean_text.trim().is_empty() { continue; }

                let formatted = format!(
                    "[{}] [{}] {}",
                    chrono::Utc::now().format("%H:%M:%S"),
                    name_display,
                    clean_text.trim()
                );
                let _ = tx_clone.send(formatted);
            }
        });
    }

    // --- 3. SERVERS (Port 11070 & 11071) ---
    let tx_for_axum = tx.clone();
    let axum_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/", get(index_handler))
            .route("/ws", get(ws_handler))
            .with_state(tx_for_axum);
        let listener = tokio::net::TcpListener::bind("0.0.0.0:11070").await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    let tx_for_grpc = tx.clone();
    let grpc_task = tokio::spawn(async move {
        let addr = "0.0.0.0:11071".parse().unwrap();
        let svc = MyObserver { tx: tx_for_grpc };
        tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new(svc))
            .serve(addr)
            .await.unwrap();
    });

    let _ = tokio::join!(axum_task, grpc_task);
    Ok(())
}

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
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
    
    loop {
        tokio::select! {
            msg_res = rx.recv() => {
                match msg_res {
                    Ok(msg) => if socket.send(WsMessage::Text(msg)).await.is_err() { break; },
                    Err(_) => break,
                }
            }
            _ = heartbeat.tick() => {
                if socket.send(WsMessage::Ping(vec![])).await.is_err() { break; }
            }
        }
    }
}
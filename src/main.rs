// sentiric-observer/src/main.rs

use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    response::Html,
    routing::get,
    Router,
};
use bollard::container::{LogOutput, LogsOptions, ListContainersOptions};
use bollard::system::EventsOptions;
use bollard::Docker;
use futures_util::stream::StreamExt;
use std::env;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn, error};
use regex::Regex;

// gRPC Generated Code
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

/// AppState holds the shared broadcast channel for all log sources.
#[derive(Clone)]
pub struct AppState {
    tx: Arc<broadcast::Sender<String>>,
}

#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(&self, request: Request<IngestLogRequest>) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();
        
        // Determine source icon
        let icon = if req.service_name.contains("MOBILE-SDK") { "📱" } else { "🌍" };
        
        let formatted = format!(
            "[{}] {} [{}] [{}] {}",
            chrono::Utc::now().format("%H:%M:%S"),
            icon,
            req.node_id.to_uppercase(),
            req.service_name.to_uppercase(),
            req.message.trim()
        );
        
        // Broadcast to local listeners (Web UI and Forwarder)
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

    info!("👁️ Sentiric Observer v0.7.0 starting on node: {}", node_name);

    let docker = Arc::new(Docker::connect_with_local_defaults().expect("❌ Docker socket unreachable"));
    let (tx, _) = broadcast::channel::<String>(10000); 
    let tx = Arc::new(tx);
    
    let app_state = AppState { tx: tx.clone() };

    // --- 1. UNIFIED FORWARDER TASK ---
    if let Some(url) = upstream_url.filter(|u| !u.is_empty()) {
        let tx_forward = tx.clone();
        let node_id_forward = node_name.clone();
        tokio::spawn(async move {
            info!("🔗 Upstream Nexus defined. Starting forwarder to: {}", url);
            let mut rx = tx_forward.subscribe();
            loop {
                match ObserverServiceClient::connect(url.clone()).await {
                    Ok(mut client) => {
                        info!("✅ Handshake successful with Nexus: {}", url);
                        while let Ok(msg) = rx.recv().await {
                            // Sadece yerel üretilen (📍) logları ilet, döngüyü engelle.
                            if !msg.contains("📍") { continue; }
                            
                            let req = IngestLogRequest {
                                service_name: "NODE-RELAY".into(),
                                message: msg,
                                level: "INFO".into(),
                                trace_id: "".into(),
                                node_id: node_id_forward.clone(),
                            };
                            if let Err(e) = client.ingest_log(req).await {
                                warn!("❌ Nexus link broken: {}", e);
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        warn!("⏳ Nexus unreachable ({}). Retrying in 10s...", e);
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    }
                }
            }
        });
    }

    // --- 2. DYNAMIC HARVESTER (Local Docker Logs) ---
    let initial_containers = docker.list_containers(Some(ListContainersOptions::<String> { 
        all: false, ..Default::default() 
    })).await?;
    
    for c in initial_containers {
        if let Some(id) = c.id {
            start_harvesting(docker.clone(), tx.clone(), id, self_id.clone(), node_name.clone());
        }
    }

    let docker_events = docker.clone();
    let tx_events = tx.clone();
    let self_id_events = self_id.clone();
    let node_name_events = node_name.clone();

    tokio::spawn(async move {
        let mut events = docker_events.events(Some(EventsOptions::<String> {
            filters: [("event".into(), vec!["start".into()])].into(),
            ..Default::default()
        }));
        info!("🔔 Container lifecycle listener active.");
        while let Some(Ok(event)) = events.next().await {
            if let Some(actor) = event.actor {
                start_harvesting(docker_events.clone(), tx_events.clone(), actor.id.unwrap_or_default(), self_id_events.clone(), node_name_events.clone());
            }
        }
    });

    // --- 3. SERVERS (Axum & gRPC) ---
    
    // Axum Spawn
    let app_state_axum = app_state.clone();
    let axum_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/", get(index_handler))
            .route("/ws", get(ws_handler))
            .with_state(app_state_axum);
        
        let listener = tokio::net::TcpListener::bind("0.0.0.0:11070").await.unwrap();
        info!("🚀 Web Portal: http://0.0.0.0:11070");
        axum::serve(listener, app).await.unwrap();
    });

    // gRPC Spawn
    let app_state_grpc = app_state.clone();
    let grpc_task = tokio::spawn(async move {
        let addr = "0.0.0.0:11071".parse().unwrap();
        info!("📥 gRPC Ingest: 0.0.0.0:11071");
        tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new(app_state_grpc))
            .serve(addr)
            .await.unwrap();
    });

    let _ = tokio::join!(axum_task, grpc_task);
    Ok(())
}

fn start_harvesting(docker: Arc<Docker>, tx: Arc<broadcast::Sender<String>>, container_id: String, self_id: String, node_name: String) {
    if container_id.starts_with(&self_id) { return; }

    tokio::spawn(async move {
        let inspect = match docker.inspect_container(&container_id, None).await {
            Ok(i) => i,
            Err(_) => return,
        };

        let name = inspect.name.unwrap_or_else(|| "unknown".into()).trim_start_matches('/').to_string();
        
        let envs = inspect.config.and_then(|c| c.env).unwrap_or_default();
        if envs.iter().any(|e| e.contains("SERVICE_IGNORE=true")) || name.contains("observer") {
            info!("🚫 Ignoring service: {}", name);
            return;
        }

        info!("🚜 Harvesting started: {}", name);

        let mut stream = docker.logs(&container_id, Some(LogsOptions {
            follow: true, stdout: true, stderr: true, tail: "10", ..Default::default()
        }));

        while let Some(Ok(log)) = stream.next().await {
            let log_text = match log {
                LogOutput::StdOut { message } => String::from_utf8_lossy(&message).to_string(),
                LogOutput::StdErr { message } => String::from_utf8_lossy(&message).to_string(),
                _ => continue,
            };

            let clean = ANSI_REGEX.replace_all(&log_text, "").to_string();
            if clean.trim().is_empty() { continue; }

            let formatted = format!("[{}] 📍 [{}] [{}] {}", 
                chrono::Utc::now().format("%H:%M:%S"),
                node_name.to_uppercase(),
                name.to_uppercase(), 
                clean.trim()
            );
            let _ = tx.send(formatted);
        }
        warn!("🛑 Harvesting stopped: {}", name);
    });
}

// --- Axum & WebSocket Handlers ---

async fn index_handler() -> Html<&'static str> {
    Html(include_str!("index.html"))
}

async fn ws_handler(
    ws: WebSocketUpgrade, 
    axum::extract::State(state): axum::extract::State<AppState>
) -> axum::response::Response {
    ws.on_upgrade(|socket| handle_socket(socket, state.tx))
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
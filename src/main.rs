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
// [FIX]: 'warn' kullanılmadığı için çıkarıldı
use tracing::{info, error}; 
use regex::Regex;
use serde::{Serialize, Deserialize};

// Network Sniffing
// [FIX]: 'Device' kullanılmadığı için çıkarıldı
use pcap::Capture;
use etherparse::{SlicedPacket, TransportSlice};

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

#[derive(Serialize, Deserialize, Clone, Debug)]
struct LogEntry {
    ts: String,
    node: String,
    service: String,
    level: String,
    msg: String,
    source_type: String, // "docker", "grpc", "mobile", "network"
}

#[derive(Clone)]
pub struct AppState {
    tx: Arc<broadcast::Sender<String>>,
}

#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(&self, request: Request<IngestLogRequest>) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();
        
        let entry = LogEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            node: req.node_id.to_uppercase(),
            service: req.service_name.to_uppercase(),
            level: req.level.to_uppercase(),
            msg: req.message,
            source_type: if req.service_name.contains("MOBILE") { "mobile".into() } else { "grpc".into() },
        };

        if let Ok(json_str) = serde_json::to_string(&entry) {
            let _ = self.tx.send(json_str);
        }
        
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
    let enable_sniffer = env::var("ENABLE_NETWORK_SNIFFER").unwrap_or_else(|_| "false".to_string()) == "true";

    info!("👁️ Sentiric Observer v1.1.0 (SNI) | Node: {} starting...", node_name);

    let docker = Arc::new(Docker::connect_with_local_defaults().expect("Docker fail"));
    let (tx, _) = broadcast::channel::<String>(10000); 
    let tx = Arc::new(tx);
    
    let app_state = AppState { tx: tx.clone() };

    // --- 1. NETWORK SNIFFER TASK (YENİ) ---
    if enable_sniffer {
        let tx_net = tx.clone();
        let node_id_net = node_name.clone();
        
        // Blocking task olduğu için spawn_blocking veya ayrı thread kullanıyoruz
        std::thread::spawn(move || {
            start_network_sniffer(tx_net, node_id_net);
        });
    }

    // --- 2. UNIFIED FORWARDER TASK ---
    if let Some(url) = upstream_url.filter(|u| !u.is_empty()) {
        let tx_clone = tx.clone();
        let node_id_clone = node_name.clone().to_uppercase();
        tokio::spawn(async move {
            info!("🔗 Forwarding logs to Nexus: {}", url);
            let mut rx = tx_clone.subscribe();
            loop {
                match ObserverServiceClient::connect(url.clone()).await {
                    Ok(mut client) => {
                        info!("✅ Connected to Nexus Cluster");
                        while let Ok(msg) = rx.recv().await {
                            if let Ok(entry) = serde_json::from_str::<LogEntry>(&msg) {
                                if entry.node != node_id_clone { continue; }
                                
                                let req = IngestLogRequest {
                                    service_name: entry.service,
                                    message: entry.msg,
                                    level: entry.level,
                                    trace_id: "".into(),
                                    node_id: entry.node,
                                };
                                if client.ingest_log(req).await.is_err() { break; }
                            }
                        }
                    }
                    Err(_) => tokio::time::sleep(std::time::Duration::from_secs(5)).await,
                }
            }
        });
    }

    // --- 3. DOCKER HARVESTER ---
    let initial_containers = docker.list_containers(Some(ListContainersOptions::<String> { all: false, ..Default::default() })).await?;
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
        while let Some(Ok(event)) = events.next().await {
            if let Some(actor) = event.actor {
                start_harvesting(docker_events.clone(), tx_events.clone(), actor.id.unwrap_or_default(), self_id_events.clone(), node_name_events.clone());
            }
        }
    });

    // --- 4. SERVERS ---
    let app_state_axum = app_state.clone();
    let axum_task = tokio::spawn(async move {
        let app = Router::new().route("/", get(index_handler)).route("/ws", get(ws_handler)).with_state(app_state_axum);
        let listener = tokio::net::TcpListener::bind("0.0.0.0:11070").await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    let grpc_task = tokio::spawn(async move {
        let addr = "0.0.0.0:11071".parse().unwrap();
        tonic::transport::Server::builder().add_service(ObserverServiceServer::new(app_state)).serve(addr).await.unwrap();
    });

    let _ = tokio::join!(axum_task, grpc_task);
    Ok(())
}

fn start_network_sniffer(tx: Arc<broadcast::Sender<String>>, node_name: String) {
    info!("📡 Network Sniffer Initializing on ANY interface...");
    
    // [FIX]: 'mut' kaldırıldı çünkü cap değişkeni capture'a taşınırken değiştirilmiyor
    let cap = match Capture::from_device("any") {
        Ok(c) => c.promisc(true).snaplen(65535).timeout(1000).open(),
        Err(e) => {
            error!("Failed to open capture device: {}", e);
            return;
        }
    };

    let mut capture = match cap {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to activate capture: {}", e);
            return;
        }
    };

    // SIP Filtresi (Port 5060 veya Sentiric İç Portları)
    if let Err(e) = capture.filter("udp and (port 5060 or portrange 13000-13100)", true) {
        error!("BPF Filter Error: {}", e);
        return;
    }

    info!("📡 Sniffer Active: Filtering SIP traffic...");

    while let Ok(packet) = capture.next_packet() {
        // Raw byte'ları parse et
        if let Ok(sliced) = SlicedPacket::from_ethernet(&packet.data) {
            if let Some(TransportSlice::Udp(udp)) = sliced.transport {
                let payload = sliced.payload;
                
                if payload.len() < 4 { continue; }
                
                if let Ok(text) = std::str::from_utf8(payload) {
                    if text.starts_with("SIP/2.0") || 
                       text.starts_with("INVITE") || 
                       text.starts_with("ACK") || 
                       text.starts_with("BYE") || 
                       text.starts_with("CANCEL") ||
                       text.starts_with("REGISTER") ||
                       text.starts_with("OPTIONS") {
                        
                        let src_port = udp.source_port();
                        let dst_port = udp.destination_port();
                        
                        let entry = LogEntry {
                            ts: chrono::Utc::now().to_rfc3339(),
                            node: node_name.to_uppercase(),
                            service: format!("SIP-NET [{}->{}]", src_port, dst_port),
                            level: "TRACE".into(),
                            msg: text.to_string(),
                            source_type: "network".into(),
                        };

                        if let Ok(json_str) = serde_json::to_string(&entry) {
                            let _ = tx.send(json_str);
                        }
                    }
                }
            }
        }
    }
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
        if envs.iter().any(|e| e.contains("SERVICE_IGNORE=true")) || name.contains("observer") { return; }

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

            let entry = LogEntry {
                ts: chrono::Utc::now().to_rfc3339(),
                node: node_name.clone().to_uppercase(),
                service: name.to_uppercase(),
                level: "INFO".into(),
                msg: clean.trim().to_string(),
                source_type: "docker".into(),
            };

            if let Ok(json_str) = serde_json::to_string(&entry) {
                let _ = tx.send(json_str);
            }
        }
    });
}

async fn index_handler() -> Html<&'static str> { Html(include_str!("index.html")) }
async fn ws_handler(ws: WebSocketUpgrade, axum::extract::State(state): axum::extract::State<AppState>) -> axum::response::Response {
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
                    Err(_) => continue, 
                }
            },
            _ = heartbeat.tick() => { if socket.send(WsMessage::Ping(vec![])).await.is_err() { break; } }
        }
    }
}
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
use std::{env, sync::Arc, time::{Duration, Instant}};
use tokio::sync::broadcast;
use tracing::{info, warn};
use serde::{Serialize, Deserialize};
use pcap::Capture;
use sysinfo::System;

lazy_static::lazy_static! {
    static ref ANSI_REGEX: regex::Regex = regex::Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct LogEntry {
    ts: String,
    node: String,
    service: String,
    level: String,
    msg: String,
    source_type: String, 
}

pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::observer_service_client::ObserverServiceClient; // İSTEMCİ GERİ GELDİ
use observer_proto::{IngestLogRequest, IngestLogResponse};

#[derive(Clone)]
pub struct AppState {
    tx: Arc<broadcast::Sender<String>>,
}

#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(&self, request: tonic::Request<IngestLogRequest>) -> Result<tonic::Response<IngestLogResponse>, tonic::Status> {
        let req = request.into_inner();
        let entry = LogEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            node: req.node_id.to_uppercase(),
            service: req.service_name.to_uppercase(),
            level: req.level.to_uppercase(),
            msg: req.message,
            source_type: "grpc".into(),
        };
        if let Ok(json_str) = serde_json::to_string(&entry) {
            let _ = self.tx.send(json_str);
        }
        Ok(tonic::Response::new(IngestLogResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let node_name = env::var("NODE_NAME").unwrap_or_else(|_| "sentiric-node".into());
    let upstream_url = env::var("UPSTREAM_OBSERVER_URL").ok(); // UPSTREAM GERİ GELDİ
    let enable_sniffer = env::var("ENABLE_NETWORK_SNIFFER").unwrap_or_default() == "true";

    info!("👁️ Sentiric Observer v1.5.0 (Grand Unified) | Node: {} | Sniffer: {}", node_name, enable_sniffer);

    let (tx, _) = broadcast::channel::<String>(10000);
    let tx = Arc::new(tx);
    let app_state = AppState { tx: tx.clone() };

    // --- 1. SYSTEM METRICS TASK ---
    let tx_sys = tx.clone();
    let node_sys = node_name.clone();
    tokio::spawn(async move {
        let mut sys = System::new_all();
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            
            let cpu_usage = sys.global_cpu_usage();
            let used_mem = sys.used_memory() / 1024 / 1024;
            let total_mem = sys.total_memory() / 1024 / 1024;
            
            let msg = format!("📊 SYS_METRICS | CPU: {:.1}% | RAM: {}/{}MB", cpu_usage, used_mem, total_mem);
            let entry = LogEntry {
                ts: chrono::Utc::now().to_rfc3339(),
                node: node_sys.to_uppercase(),
                service: "SYSTEM".into(),
                level: "INFO".into(),
                msg,
                source_type: "system".into(),
            };
            if let Ok(json) = serde_json::to_string(&entry) {
                let _ = tx_sys.send(json);
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // --- 2. UPSTREAM FORWARDER (NEXUS LINK) ---
    // [FIX]: Bu blok geri eklendi. Logları merkeze iletir.
    if let Some(url) = upstream_url.filter(|u| !u.is_empty()) {
        let tx_forward = tx.clone();
        let node_id_fwd = node_name.clone().to_uppercase();
        tokio::spawn(async move {
            info!("🔗 Nexus Forwarder Active: {}", url);
            let mut rx = tx_forward.subscribe();
            
            // Basit bir bağlantı döngüsü
            loop {
                // Bağlantı kurulana kadar bekle
                match ObserverServiceClient::connect(url.clone()).await {
                    Ok(mut client) => {
                        info!("✅ Connected to Upstream Observer");
                        while let Ok(msg) = rx.recv().await {
                            if let Ok(entry) = serde_json::from_str::<LogEntry>(&msg) {
                                // Sonsuz döngüyü önlemek için kendi logunu tekrar kendine atma
                                if entry.node == node_id_fwd && entry.source_type == "grpc" { continue; }
                                
                                let req = IngestLogRequest {
                                    service_name: entry.service,
                                    message: entry.msg,
                                    level: entry.level,
                                    trace_id: "".into(),
                                    node_id: entry.node,
                                };
                                // Hata alırsak döngüyü kırıp yeniden bağlanmayı deneriz
                                if client.ingest_log(req).await.is_err() { 
                                    warn!("⚠️ Upstream connection lost.");
                                    break; 
                                }
                            }
                        }
                    },
                    Err(e) => {
                        warn!("⚠️ Upstream connect failed: {}. Retrying in 5s...", e);
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });
    }

    // --- 3. SMART NETWORK SNIFFER ---
    if enable_sniffer {
        let tx_net = tx.clone();
        let node_net = node_name.clone();
        std::thread::spawn(move || start_smart_sniffer(tx_net, node_net));
    }

    // --- 4. DOCKER HARVESTER ---
    let docker = Arc::new(Docker::connect_with_local_defaults().expect("Docker socket fail"));
    
    // A. Mevcut Konteynerler
    let initial_containers = docker.list_containers(Some(ListContainersOptions::<String> { all: false, ..Default::default() })).await?;
    for c in initial_containers {
        if let Some(id) = c.id {
            let d_clone = docker.clone();
            let t_clone = tx.clone();
            let n_clone = node_name.clone();
            tokio::spawn(async move {
                start_harvesting(d_clone, t_clone, id, n_clone).await;
            });
        }
    }

    // B. Event Listener (Restart/Start yakalama)
    let docker_events = docker.clone();
    let tx_events = tx.clone();
    let node_events = node_name.clone();
    tokio::spawn(async move {
        let mut events = docker_events.events(Some(EventsOptions::<String> {
            filters: [("event".into(), vec!["start".into(), "restart".into()])].into(),
            ..Default::default()
        }));
        while let Some(Ok(event)) = events.next().await {
            if let Some(actor) = event.actor {
                if let Some(id) = actor.id {
                    let d = docker_events.clone();
                    let t = tx_events.clone();
                    let n = node_events.clone();
                    tokio::spawn(async move {
                        // Container hazır olana kadar azıcık bekle
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        start_harvesting(d, t, id, n).await;
                    });
                }
            }
        }
    });

    // --- 5. SERVERS ---
    let tx_ws = tx.clone();
    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("index.html")) }))
        .route("/ws", get(move |ws: WebSocketUpgrade| async move {
            ws.on_upgrade(move |socket| handle_socket(socket, tx_ws))
        }))
        .with_state(app_state.clone());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:11070").await?;
    info!("🚀 Observer UI: http://localhost:11070");
    
    let grpc_state = app_state.clone();
    tokio::spawn(async move {
        let addr = "0.0.0.0:11071".parse().unwrap();
        let _ = tonic::transport::Server::builder()
            .add_service(ObserverServiceServer::new(grpc_state))
            .serve(addr).await;
    });

    axum::serve(listener, app).await?;
    Ok(())
}

fn start_smart_sniffer(tx: Arc<broadcast::Sender<String>>, node_name: String) {
    let mut capture = Capture::from_device("any").unwrap().promisc(true).snaplen(65535).timeout(100).open().unwrap();
    // Filtreyi ayarlıyoruz
    let _ = capture.filter("udp and (port 5060 or portrange 13000-13100 or portrange 30000-60000)", true);

    let mut rtp_count = 0u64;
    // [FIX]: Hata veren değişken burada tanımlandı
    let mut last_rtp_log = Instant::now(); 
    let mut is_call_active = false;

    loop {
        if let Ok(packet) = capture.next_packet() {
            let data = packet.data;
            if data.len() < 12 { continue; }

            // --- 1. KATEGORİ BELİRLEME ---
            let text = String::from_utf8_lossy(data);
            let mut service_name = "SNIFFER-UDP"; 
            let mut log_level = "DEBUG";

            // A. SIP Tespiti
            let is_sip = text.contains("INVITE") || text.contains("SIP/2.0") || text.contains("BYE") || text.contains("ACK");
            
            // B. RTP Tespiti (V2, Signature 0x80)
            let is_rtp = (data[0] >> 6) == 2 && data.len() > 50;

            // C. Keep-Alive / STUN
            let is_keepalive = data.len() <= 4 || text.contains("STUN");

            if is_sip {
                service_name = "SNIFFER-SIP";
                log_level = "TRACE";
                if text.contains("INVITE") { is_call_active = true; }
                if text.contains("BYE") { is_call_active = false; }
            } else if is_rtp {
                service_name = "SNIFFER-RTP";
                rtp_count += 1;
            } else if is_keepalive {
                service_name = "SNIFFER-KEEP";
                log_level = "DEBUG";
            }

            // --- 2. LOGLAMA MANTIĞI ---
            
            // SIP ve Keep-Alive anında basılır
            if is_sip || is_keepalive {
                 let entry = LogEntry {
                    ts: chrono::Utc::now().to_rfc3339(),
                    node: node_name.to_uppercase(),
                    service: service_name.into(),
                    level: log_level.into(),
                    msg: if is_keepalive { "💤 UDP Keep-Alive".into() } else { text.trim().to_string() },
                    source_type: "network".into(),
                };
                if let Ok(json_str) = serde_json::to_string(&entry) { let _ = tx.send(json_str); }
            }

            // RTP özetlenerek basılır
            if is_rtp {
                let threshold = if is_call_active { 2 } else { 30 };
                // [FIX]: last_rtp_log burada kullanılıyor
                if last_rtp_log.elapsed().as_secs() >= threshold {
                    let entry = LogEntry {
                        ts: chrono::Utc::now().to_rfc3339(),
                        node: node_name.to_uppercase(),
                        service: "SNIFFER-RTP".into(),
                        level: "DEBUG".into(),
                        msg: format!("🎵 RTP FLOW: {} pkts | State: {}", rtp_count, if is_call_active { "CALL_ACTIVE" } else { "IDLE" }),
                        source_type: "network".into(),
                    };
                    if let Ok(json_str) = serde_json::to_string(&entry) { let _ = tx.send(json_str); }
                    rtp_count = 0; 
                    last_rtp_log = Instant::now();
                }
            }
        }
    }
}

async fn start_harvesting(docker: Arc<Docker>, tx: Arc<broadcast::Sender<String>>, container_id: String, node_name: String) {
    let inspect = match docker.inspect_container(&container_id, None).await {
        Ok(i) => i,
        Err(_) => return,
    };
    let name = inspect.name.unwrap_or_default().replace("/", "");
    if name.contains("observer") { return; }

    info!("🚜 Harvesting started for: {}", name);

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
            node: node_name.to_uppercase(),
            service: name.to_uppercase(),
            level: "INFO".into(),
            msg: clean.trim().to_string(),
            source_type: "docker".into(),
        };
        let _ = tx.send(serde_json::to_string(&entry).unwrap());
    }
}

async fn handle_socket(mut socket: WebSocket, tx: Arc<broadcast::Sender<String>>) {
    let mut rx = tx.subscribe();
    loop {
        if let Ok(msg) = rx.recv().await {
            if socket.send(WsMessage::Text(msg.into())).await.is_err() { break; }
        }
    }
}
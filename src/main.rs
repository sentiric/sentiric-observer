// sentiric-observer/src/main.rs

mod model; // src/model.rs dosyasını kullan

use crate::model::OtelLogRecord;
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
use tracing::{info, warn, error}; // warn burada kullanılıyor
use pcap::Capture;
use sysinfo::System;

lazy_static::lazy_static! {
    static ref ANSI_REGEX: regex::Regex = regex::Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
}

// gRPC Proto
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}
use observer_proto::observer_service_server::{ObserverService, ObserverServiceServer};
use observer_proto::observer_service_client::ObserverServiceClient; 
use observer_proto::{IngestLogRequest, IngestLogResponse};

#[derive(Clone)]
pub struct AppState {
    tx: Arc<broadcast::Sender<String>>,
    host_name: String,
}

#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(&self, request: tonic::Request<IngestLogRequest>) -> Result<tonic::Response<IngestLogResponse>, tonic::Status> {
        let req = request.into_inner();
        
        let log = OtelLogRecord::new(
            if req.node_id.is_empty() { &self.host_name } else { &req.node_id },
            &req.service_name,
            &req.level,
            req.message
        ).with_attributes(serde_json::json!({
            "source": "grpc",
            "trace_id": req.trace_id 
        }));

        if let Ok(json_str) = serde_json::to_string(&log) {
            let _ = self.tx.send(json_str);
        }
        Ok(tonic::Response::new(IngestLogResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    // 1. OTOMATİK KİMLİK TANIMLAMA
    let host_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "UNKNOWN-HOST".to_string())
        .to_uppercase();

    let upstream_url = env::var("UPSTREAM_OBSERVER_URL").ok();
    let enable_sniffer = env::var("ENABLE_NETWORK_SNIFFER").unwrap_or_default() == "true";

    info!("👁️ Sentiric Observer v2.0 (OTEL Engine) | Host: {} | Sniffer: {}", host_name, enable_sniffer);

    let (tx, _) = broadcast::channel::<String>(10000);
    let tx = Arc::new(tx);
    let app_state = AppState { tx: tx.clone(), host_name: host_name.clone() };

    // --- 2. SYSTEM METRICS ---
    let tx_sys = tx.clone();
    let host_sys = host_name.clone();
    tokio::spawn(async move {
        let mut sys = System::new_all();
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            
            let cpu_usage = sys.global_cpu_usage();
            let used_mem = sys.used_memory() / 1024 / 1024;
            let total_mem = sys.total_memory() / 1024 / 1024;
            
            let log = OtelLogRecord::new(
                &host_sys,
                "SYSTEM-METRICS",
                "INFO",
                format!("System Health Check: CPU {:.1}%", cpu_usage)
            ).with_attributes(serde_json::json!({
                "host.cpu.usage": cpu_usage,
                "host.memory.used_mb": used_mem,
                "host.memory.total_mb": total_mem
            }));

            if let Ok(json) = serde_json::to_string(&log) {
                let _ = tx_sys.send(json);
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // --- 3. UPSTREAM FORWARDER ---
    if let Some(url) = upstream_url.filter(|u| !u.is_empty()) {
        let tx_forward = tx.clone();
        let host_fwd = host_name.clone();
        tokio::spawn(async move {
            info!("🔗 Upstream Relay Active: {}", url);
            let mut rx = tx_forward.subscribe();
            loop {
                match ObserverServiceClient::connect(url.clone()).await {
                    Ok(mut client) => {
                        info!("✅ Upstream Connected");
                        while let Ok(msg) = rx.recv().await {
                            if let Ok(entry) = serde_json::from_str::<OtelLogRecord>(&msg) {
                                if entry.resource.host_name == host_fwd { continue; }
                                
                                let req = IngestLogRequest {
                                    service_name: entry.resource.service_name,
                                    message: entry.body,
                                    level: entry.severity_text,
                                    trace_id: "".into(),
                                    node_id: entry.resource.host_name,
                                };
                                if client.ingest_log(req).await.is_err() { break; }
                            }
                        }
                    },
                    Err(_) => {
                        warn!("⚠️ Upstream connect failed. Retrying in 5s...");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });
    }

    // --- 4. NETWORK SNIFFER ---
    if enable_sniffer {
        let tx_net = tx.clone();
        let host_net = host_name.clone();
        std::thread::spawn(move || start_smart_sniffer(tx_net, host_net));
    }

    // --- 5. DOCKER HARVESTER ---
    let docker = Arc::new(Docker::connect_with_local_defaults().expect("Docker socket fail"));
    let initial_containers = docker.list_containers(Some(ListContainersOptions::<String> { all: false, ..Default::default() })).await?;
    
    for c in initial_containers {
        if let Some(id) = c.id {
            let d = docker.clone();
            let t = tx.clone();
            let h = host_name.clone();
            tokio::spawn(async move { start_harvesting(d, t, id, h).await; });
        }
    }
    
    // Event Listener
    let d_ev = docker.clone();
    let t_ev = tx.clone();
    let h_ev = host_name.clone();
    tokio::spawn(async move {
        let mut events = d_ev.events(Some(EventsOptions::<String> {
            filters: [("event".into(), vec!["start".into(), "restart".into()])].into(),
            ..Default::default()
        }));
        while let Some(Ok(event)) = events.next().await {
            if let Some(actor) = event.actor {
                if let Some(id) = actor.id {
                    let d = d_ev.clone();
                    let t = t_ev.clone();
                    let h = h_ev.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(1000)).await;
                        start_harvesting(d, t, id, h).await;
                    });
                }
            }
        }
    });

    // --- 6. SERVERS ---
    let tx_ws = tx.clone();
    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("index.html")) }))
        .route("/ws", get(move |ws: WebSocketUpgrade| async move {
            ws.on_upgrade(move |socket| handle_socket(socket, tx_ws))
        }))
        .with_state(app_state.clone());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:11070").await?;
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

fn start_smart_sniffer(tx: Arc<broadcast::Sender<String>>, host_name: String) {
    let mut capture = match Capture::from_device("any") {
        Ok(c) => c.promisc(true).snaplen(65535).timeout(100).open().unwrap(),
        Err(e) => {
            error!("Sniffer başlatılamadı (Yetki sorunu?): {}", e);
            return;
        }
    };
    let _ = capture.filter("udp and (port 5060 or portrange 13000-13100 or portrange 30000-60000)", true);

    let mut rtp_count = 0u64;
    let mut last_rtp_log = Instant::now(); 
    let mut is_call_active = false;

    loop {
        if let Ok(packet) = capture.next_packet() {
            let data = packet.data;
            if data.len() < 12 { continue; }

            let text = String::from_utf8_lossy(data);
            let mut service = "SNIFFER-UDP";
            let mut level = "DEBUG";
            let mut should_log = false;
            let mut msg = String::new();

            if text.contains("INVITE") || text.contains("SIP/2.0") {
                service = "SNIFFER-SIP";
                level = "TRACE";
                if text.contains("INVITE") { is_call_active = true; }
                if text.contains("BYE") { is_call_active = false; }
                should_log = true;
                msg = text.trim().to_string();
            } else if (data[0] >> 6) == 2 && data.len() > 50 {
                service = "SNIFFER-RTP";
                rtp_count += 1;
                if last_rtp_log.elapsed().as_secs() >= (if is_call_active { 2 } else { 30 }) {
                    should_log = true;
                    msg = format!("🎵 RTP FLOW: {} pkts | State: {}", rtp_count, if is_call_active { "CALL" } else { "IDLE" });
                    rtp_count = 0; 
                    last_rtp_log = Instant::now();
                }
            }

            if should_log {
                let log = OtelLogRecord::new(&host_name, service, level, msg)
                    .with_attributes(serde_json::json!({ "source": "pcap", "protocol": "udp" }));
                
                if let Ok(json) = serde_json::to_string(&log) { let _ = tx.send(json); }
            }
        }
    }
}

async fn start_harvesting(docker: Arc<Docker>, tx: Arc<broadcast::Sender<String>>, container_id: String, host_name: String) {
    let inspect = match docker.inspect_container(&container_id, None).await {
        Ok(i) => i,
        Err(_) => return,
    };
    
    let raw_name = inspect.name.unwrap_or_default().replace("/", "");
    let service_name = raw_name.replace("sentiric-", "").to_uppercase();
    if raw_name.contains("observer") { return; }

    info!(host = %host_name, service = %service_name, "🚜 Harvesting Logs");

    let mut stream = docker.logs(&container_id, Some(LogsOptions { 
        follow: true, stdout: true, stderr: true, tail: "10", ..Default::default() 
    }));

    while let Some(Ok(log)) = stream.next().await {
        let log_text = match log {
            LogOutput::StdOut { message } => String::from_utf8_lossy(&message).to_string(),
            LogOutput::StdErr { message } => String::from_utf8_lossy(&message).to_string(),
            _ => continue,
        };
        let clean_text = ANSI_REGEX.replace_all(&log_text, "").to_string();
        let clean_str = clean_text.trim();
        if clean_str.is_empty() { continue; }

        // --- AKILLI JSON AYRIŞTIRMA (FIXED) ---
        let final_log: OtelLogRecord;

        if let Ok(mut parsed_json) = serde_json::from_str::<serde_json::Value>(clean_str) {
            
            // Log Seviyesi
            let level = parsed_json.get("level")
                .or(parsed_json.get("severity"))
                .and_then(|v| v.as_str())
                .unwrap_or("INFO")
                .to_uppercase();

            // Mesaj Gövdesi
            let body = parsed_json.get("message")
                .or(parsed_json.get("msg"))
                .or(parsed_json.get("fields").and_then(|f| f.get("message")))
                .and_then(|v| v.as_str())
                .unwrap_or(clean_str)
                .to_string();

            // Zaman Damgası (HATA DÜZELTİLDİ: Artık String dönüyor)
            let timestamp = parsed_json.get("timestamp")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()) // Varsa String'e çevir
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()); // Yoksa yenisini üret

            // Konteyner ID'sini ekle
            if let Some(obj) = parsed_json.as_object_mut() {
                obj.insert("container.id".to_string(), serde_json::json!(container_id));
            }

            final_log = OtelLogRecord {
                timestamp,
                severity_text: level,
                body,
                resource: crate::model::OtelResource {
                    service_name: service_name.clone(),
                    host_name: host_name.clone(),
                    namespace: "sentiric-docker".into(),
                },
                attributes: Some(parsed_json),
            };

        } else {
            // JSON değilse düz metin
            final_log = OtelLogRecord::new(&host_name, &service_name, "INFO", clean_str.to_string())
                .with_attributes(serde_json::json!({ "container.id": container_id }));
        }

        if let Ok(json_str) = serde_json::to_string(&final_log) {
            let _ = tx.send(json_str);
        }
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
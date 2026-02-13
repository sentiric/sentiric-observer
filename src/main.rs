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
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{debug, error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Logger başlat
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("👁️ Sentiric Observer v0.1.0 starting...");

    // 2. Kendi ID'mizi öğrenelim (Döngü koruması)
    let self_id = env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into());
    
    // 3. Docker Engine Bağlantısı
    let docker = Arc::new(Docker::connect_with_local_defaults()
        .expect("❌ Failed to connect to Docker socket."));

    // 4. Merkezi Yayın Kanalı (Broadcasting)
    // Bu kanal hasat edilen logları tüm bağlı WebSocket istemcilerine dağıtır.
    let (tx, _) = broadcast::channel::<String>(5000); 
    let tx = Arc::new(tx);

    // 5. Log Harvester Task'larını Başlat
    let containers = docker.list_containers::<String>(None).await?;
    for container in containers {
        let container_id = container.id.expect("Container ID missing");
        let container_name = container.names.unwrap_or_default().join(", ");
        
        if container_id.starts_with(&self_id) || container_name.contains("observer-service") {
            continue;
        }

        let docker_clone = docker.clone();
        let tx_clone = tx.clone();
        let name_display = container_name.trim_start_matches('/').to_string();

        info!("👀 Harvesting: [{}]", name_display);

        tokio::spawn(async move {
            let options = bollard::container::LogsOptions {
                follow: true,
                stdout: true,
                stderr: true,
                tail: "20", 
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

                    let clean_text = log_text.trim();
                    if clean_text.is_empty() { continue; }

                    let formatted_log = format!(
                        "[{}] [{}] {}",
                        chrono::Utc::now().format("%H:%M:%S"),
                        name_display,
                        clean_text
                    );

                    println!("{}", formatted_log);
                    let _ = tx_clone.send(formatted_log);
                }
            }
        });
    }

    // 6. Web Server & UI Katmanı
    let app_state = tx.clone();
    
    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        .with_state(app_state);

    // Harmonik Port: 11070
    let addr = SocketAddr::from(([0, 0, 0, 0], 11070));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    
    info!("🚀 Portal active at http://localhost:11070");
    
    axum::serve(listener, app).await?;

    Ok(())
}

// --- HANDLERS ---

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
            break; // Bağlantı koptuysa döngüden çık
        }
    }
}
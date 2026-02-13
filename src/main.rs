// sentiric-observer/src/main.rs

use bollard::container::LogOutput;
use bollard::Docker;
use futures_util::stream::StreamExt;
use std::env;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{debug, error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Logger başlat (Standard Sentiric Format)
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("👁️ Sentiric Observer v0.1.0 starting...");

    // 2. Kendi ID'mizi öğrenelim (Döngü koruması için)
    let self_id = env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into());
    info!("🆔 Observer Self-ID: {}", self_id);

    // 3. Docker Engine Bağlantısı
    let docker = Arc::new(Docker::connect_with_local_defaults()
        .expect("❌ Failed to connect to Docker socket. Ensure /var/run/docker.sock is mounted."));

    // 4. Merkezi Yayın Kanalı (UI/WebSocket Hazırlığı)
    let (tx, _) = broadcast::channel::<String>(5000); 
    let tx = Arc::new(tx);

    // 5. Mevcut konteynerleri tara ve log dinleyicileri başlat
    let containers = docker.list_containers::<String>(None).await?;
    
    for container in containers {
        let container_id = container.id.expect("Container must have an ID");
        let container_name = container.names.unwrap_or_default().join(", ");
        
        // KRİTİK: Kendi logumuzu dinleyip sonsuz döngüye girmeyelim
        if container_id.starts_with(&self_id) || container_name.contains("observer-service") {
            debug!("🚫 Skipping self: {}", container_name);
            continue;
        }

        let docker_clone = docker.clone();
        let tx_clone = tx.clone();
        let name_display = container_name.trim_start_matches('/').to_string();

        info!("👀 Monitoring logs: [{}] ({})", name_display, &container_id[..12]);

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
                match log_result {
                    Ok(log) => {
                        let log_text = match log {
                            LogOutput::StdOut { message } => String::from_utf8_lossy(&message).to_string(),
                            LogOutput::StdErr { message } => String::from_utf8_lossy(&message).to_string(),
                            _ => continue,
                        };

                        if log_text.trim().is_empty() { continue; }

                        let formatted_log = format!(
                            "[{}] [{}] {}",
                            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
                            name_display,
                            log_text.trim()
                        );

                        // 1. Terminale bas (Bu sayede docker logs -f observer-service her şeyi gösterir)
                        println!("{}", formatted_log);

                        // 2. Yayın kanalına gönder (Gelecek WebSocket UI için)
                        let _ = tx_clone.send(formatted_log);
                    }
                    Err(e) => {
                        error!("❌ Log stream error for {}: {}", name_display, e);
                        break;
                    }
                }
            }
        });
    }

    // 6. Servisleri Blokla (Sinyal Bekle)
    info!("✅ Observer is active. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    
    info!("🛑 Sentiric Observer shutting down gracefully.");
    Ok(())
}
mod core;
mod adapters;
mod ports;
mod utils;
mod config;

use tracing::{info, error};
use crate::core::domain::LogRecord;
use crate::config::AppConfig;
use crate::ports::LogIngestor; // Trait scope'ta olmalı
use tokio::sync::mpsc;

use crate::core::aggregator::Aggregator; // <--- EKLENDİ

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Config Yükle
    let cfg = AppConfig::load();

    // 2. Loglama Başlat
    tracing_subscriber::fmt::init();
    
    info!("👁️ SENTIRIC OBSERVER v4.0 (Sovereign Edition) Booting...");
    
    // 3. Kanal Kurulumu
    let (tx, mut rx) = mpsc::channel::<LogRecord>(10000);

    // 4. Core Engine (Aggregator Aktif)
    tokio::spawn(async move {
        info!("🧠 Core Engine Active. Waiting for telemetry...");
        
        // Aggregator State'i burada yaşar (Thread-local gibi davranır)
        let mut aggregator = Aggregator::new();
        
        while let Some(log) = rx.recv().await {
            // Logu işle
            if let Some(session) = aggregator.process(log.clone()) {
                // Eğer bir session güncellendiyse buraya düşer.
                // İleride buradaki 'session' nesnesini WebSocket'e basacağız.
                
                // Debug için: Sadece yeni session oluştuğunda veya hata olduğunda bas
                if session.logs.len() == 1 || session.status == crate::core::aggregator::SessionStatus::Failed {
                     info!(
                        "🔄 Session Update [{}]: {} logs | Status: {:?}", 
                        session.session_id, 
                        session.logs.len(), 
                        session.status
                    );
                }
            } else {
                // Trace ID'si olmayan loglar (System logs vb.)
                // println!("Orphan Log: {}", log.message);
            }
            
            // Ara sıra temizlik yap (Her logda değil, gerekirse sayaç koy)
            // aggregator.cleanup(); 
        }
    });

    // 5. Docker Ingestor Başlat
    let docker_tx = tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    
    // Hostname'i güvenli al
    let node_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-node".to_string());

    info!("🐳 Connecting to Docker Socket: {}", docker_socket);

    tokio::spawn(async move {
        // DockerIngestor başlatma
        match adapters::docker::DockerIngestor::new(&docker_socket, docker_tx, node_name) {
            Ok(ingestor) => {
                if let Err(e) = ingestor.start().await {
                    error!("❌ Docker Ingestor Runtime Error: {}", e);
                }
            },
            Err(e) => {
                error!("❌ Docker Ingestor Connection Error: {}", e);
            }
        }
    });

    // Main thread'i hayatta tut
    info!("🚀 System Ready. Listening on channels...");
    tokio::signal::ctrl_c().await?;
    info!("🛑 Shutdown signal received.");
    
    Ok(())
}
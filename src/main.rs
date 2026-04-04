// Dosya: src/main.rs
mod adapters;
mod api;
mod config;
mod core;
mod ports;
mod utils;

use crate::config::AppConfig;
use crate::core::aggregator::Aggregator;
use crate::core::domain::LogRecord;
use crate::ports::LogIngestor;
use std::net::SocketAddr;
use std::sync::{atomic::AtomicBool, Arc};
use tokio::sync::{broadcast, mpsc};
use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Config Yükle
    let cfg = AppConfig::load();

    // 2. Loglama Başlat
    if cfg.env == "production" || std::env::var("LOG_FORMAT").unwrap_or_default() == "json" {
        tracing_subscriber::fmt()
            .json()
            .with_current_span(false)
            .with_span_list(false)
            .init();
    } else {
        tracing_subscriber::fmt::init();
    }

    //[ARCH-COMPLIANCE] Event zorunluluğu
    info!(event="PANOPTICON_STARTUP", version="v5.0", profile=%cfg.env, "👁️ SENTIRIC PANOPTICON v5.0 (Sovereign Edition) Başlatılıyor...");

    let (ingest_tx, mut ingest_rx) = mpsc::channel::<LogRecord>(50000);
    let (ui_tx, _) = broadcast::channel::<LogRecord>(50000);

    let sniffer_active = Arc::new(AtomicBool::new(cfg.sniffer_enabled));

    // --- 3. AGGREGATOR TASK ---
    let aggregator_ui_tx = ui_tx.clone();
    let max_sessions = cfg.max_active_sessions;
    let ttl_seconds = cfg.session_ttl_seconds;

    tokio::spawn(async move {
        let mut aggregator = Aggregator::new(max_sessions, ttl_seconds);
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));

        loop {
            tokio::select! {
                Some(mut log) = ingest_rx.recv() => {
                    log._idx = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros() as f64 / 1000.0;

                    if log.trace_id.is_none() {
                        if let Some(call_id_val) = log.attributes.get("sip.call_id") {
                             if let Some(s) = call_id_val.as_str() { log.trace_id = Some(s.to_string()); }
                        }
                    }

                    aggregator.process(&log);
                    let _ = aggregator_ui_tx.send(log);
                }
                _ = cleanup_interval.tick() => { aggregator.cleanup(); }
            }
        }
    });

    let node_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or("unknown".into());
    let global_tenant_id = cfg.tenant_id.clone();

    // --- 4. INGESTION ADAPTERS ---

    // A. Sniffer
    let sniffer_tx = ingest_tx.clone();
    let sniffer_flag = sniffer_active.clone();
    let interface = cfg.sniffer_interface.clone();
    let filter = cfg.sniffer_filter.clone();
    let sniffer_node = node_name.clone();
    let sniffer_tenant = global_tenant_id.clone();

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    tokio::spawn(async move {
        let sniffer = adapters::sniffer::NetworkSniffer::new(
            &interface,
            &filter,
            sniffer_tx,
            sniffer_node,
            sniffer_flag,
            sniffer_tenant,
        );
        if let Err(e) = sniffer.start().await {
            error!(event="SNIFFER_START_FAIL", error=%e, "Sniffer Başlatılamadı");
        }
    });

    // B. Docker
    let docker_tx = ingest_tx.clone();
    let docker_socket = cfg.docker_socket.clone();
    let node_clone = node_name.clone();
    let docker_tenant = global_tenant_id.clone();

    tokio::spawn(async move {
        if let Ok(ingestor) = adapters::docker::DockerIngestor::new(
            &docker_socket,
            docker_tx,
            node_clone,
            docker_tenant,
        ) {
            let _ = ingestor.start().await;
        }
    });

    // C. gRPC Server
    let grpc_tx = ingest_tx.clone();
    let grpc_addr = SocketAddr::from(([0, 0, 0, 0], cfg.grpc_port));

    let tls_cert = cfg.tls_cert_path.clone();
    let tls_key = cfg.tls_key_path.clone();
    let tls_ca = cfg.tls_ca_path.clone();
    let grpc_tenant = global_tenant_id.clone();

    tokio::spawn(async move {
        let state = api::grpc::GrpcServerState {
            tx: grpc_tx,
            tenant_id: grpc_tenant,
        };

        // [ARCH-COMPLIANCE] mTLS Failure Policy: Silent degradation YASAKTIR. Bail fırlatılır.
        let mut server_builder = match (tls_cert, tls_key, tls_ca) {
            (Some(cert_path), Some(key_path), Some(ca_path)) => {
                info!(
                    event = "GRPC_MTLS_ACTIVE",
                    "🔒 gRPC Server: Enforcing mTLS Authentication."
                );
                let cert = std::fs::read_to_string(cert_path).expect("Failed to read TLS Cert");
                let key = std::fs::read_to_string(key_path).expect("Failed to read TLS Key");
                let ca_cert = std::fs::read_to_string(ca_path).expect("Failed to read TLS CA");

                let identity = tonic::transport::Identity::from_pem(cert, key);
                let client_ca = tonic::transport::Certificate::from_pem(ca_cert);
                let tls_config = tonic::transport::ServerTlsConfig::new()
                    .identity(identity)
                    .client_ca_root(client_ca);

                tonic::transport::Server::builder()
                    .tls_config(tls_config)
                    .expect("TLS Config failed")
            }
            _ => {
                error!(
                    event = "MTLS_CONFIG_MISSING",
                    "mTLS sertifikaları eksik. Servis çökecektir."
                );
                panic!("[ARCH-COMPLIANCE] mTLS sertifikaları zorunludur. Güvensiz sunucu başlatılamaz.");
            }
        };

        let server = server_builder
            .add_service(
                api::grpc::observer_proto::observer_service_server::ObserverServiceServer::new(
                    state,
                ),
            )
            .serve(grpc_addr);

        if let Err(e) = server.await {
            error!(event="GRPC_SERVER_ERROR", error=%e, "gRPC Server Error");
        }
    });

    // --- 5. UPSTREAM EXPORT ---
    if !cfg.upstream_url.is_empty() {
        info!(event="UPSTREAM_MODE_ACTIVE", url=%cfg.upstream_url, "🚀 OMNISCIENT MODE: Upstream aktif");
        let mut export_manager = adapters::exporter::ExportManager::new(50, 2);

        export_manager.register_emitter(Arc::new(adapters::grpc_client::GrpcEmitter::new(
            cfg.upstream_url.clone(),
            cfg.tls_cert_path.clone(),
            cfg.tls_key_path.clone(),
            cfg.tls_ca_path.clone(),
        )));

        let mut rx_export = ui_tx.subscribe();
        let (bridge_tx, bridge_rx) = mpsc::channel(20000);

        tokio::spawn(async move {
            while let Ok(log) = rx_export.recv().await {
                if let Some(src) = log.attributes.get("source") {
                    if src.as_str() == Some("grpc") {
                        continue;
                    }
                }
                let _ = bridge_tx.send(log).await;
            }
        });
        export_manager.start(bridge_rx);
    }

    // --- 6. API & UI ---
    let app_state = Arc::new(api::routes::AppState {
        tx: ui_tx,
        sniffer_active,
        config: cfg.clone(),
    });

    let app = api::routes::create_router(app_state);
    let http_addr = SocketAddr::from(([0, 0, 0, 0], cfg.http_port));

    info!(event="SYSTEM_READY", url=%cfg.host, port=cfg.http_port, "✅ Sistem Hazır.");
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

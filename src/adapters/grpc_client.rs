// Dosya: src/adapters/grpc_client.rs
use crate::core::domain::LogRecord;
use crate::ports::LogEmitter;
use async_trait::async_trait;
use anyhow::{Result, bail};
use tonic::transport::{Channel, ClientTlsConfig, Certificate, Identity};
use tracing::{error, info, debug};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::api::grpc::observer_proto::observer_service_client::ObserverServiceClient;
use crate::api::grpc::observer_proto::IngestLogRequest;

pub struct GrpcEmitter {
    client: Arc<RwLock<Option<ObserverServiceClient<Channel>>>>,
    target_url: String,
    tls_cert_path: Option<String>,
    tls_key_path: Option<String>,
    tls_ca_path: Option<String>,
}

impl GrpcEmitter {
    pub fn new(url: String, tls_cert_path: Option<String>, tls_key_path: Option<String>, tls_ca_path: Option<String>) -> Self {
        Self {
            client: Arc::new(RwLock::new(None)),
            target_url: url,
            tls_cert_path,
            tls_key_path,
            tls_ca_path,
        }
    }

    async fn connect(&self) -> Result<ObserverServiceClient<Channel>> {
        {
            let read_guard = self.client.read().await;
            if let Some(c) = &*read_guard { return Ok(c.clone()); }
        }

        let mut write_guard = self.client.write().await;
        if let Some(c) = &*write_guard { return Ok(c.clone()); }

        info!(event="GRPC_CLIENT_CONNECT", target=%self.target_url, "🔌 Connecting to Upstream Observer.");
        
        // [ARCH-COMPLIANCE] mTLS Failure Policy: Client tarafında da güvensiz fallback YASAKTIR.
        let endpoint = match (
            self.tls_cert_path.as_ref(),
            self.tls_key_path.as_ref(),
            self.tls_ca_path.as_ref()
        ) {
            (Some(cert_path), Some(key_path), Some(ca_path)) => {
                info!(event="GRPC_CLIENT_MTLS", "🔒 gRPC Client: Utilizing mTLS for upstream connection.");
                let cert = std::fs::read_to_string(cert_path)?;
                let key = std::fs::read_to_string(key_path)?;
                let ca_cert = std::fs::read_to_string(ca_path)?;
                
                let identity = Identity::from_pem(cert, key);
                let ca = Certificate::from_pem(ca_cert);
                
                let tls_config = ClientTlsConfig::new()
                    .domain_name(self.target_url.replace("https://", "").replace("http://", "").split(':').next().unwrap_or(""))
                    .ca_certificate(ca)
                    .identity(identity);

                Channel::from_shared(self.target_url.clone())?
                    .tls_config(tls_config)?
            },
            _ => {
                error!(event="GRPC_CLIENT_MTLS_FAIL", "mTLS yapılandırması eksik.");
                bail!("[ARCH-COMPLIANCE] Upstream gRPC Client bağlantısında mTLS zorunludur.");
            }
        };

        let channel = endpoint
            .connect_timeout(std::time::Duration::from_secs(5))
            .connect()
            .await?;

        let c = ObserverServiceClient::new(channel);
        *write_guard = Some(c.clone());
        Ok(c)
    }
}

#[async_trait]
impl LogEmitter for GrpcEmitter {
    fn name(&self) -> &'static str { "gRPC Upstream" }

    #[allow(dead_code)]
    async fn emit(&self, _log: LogRecord) -> Result<()> { Ok(()) }

    async fn emit_batch(&self, logs: Vec<LogRecord>) -> Result<()> {
        let mut client = self.connect().await?;

        for log in logs {
            let raw_json = match serde_json::to_string(&log) {
                Ok(json) => json,
                Err(e) => {
                    error!(event="JSON_SERIALIZE_ERROR", error=%e, "Failed to serialize LogRecord for gRPC");
                    continue; 
                }
            };
            
            let mut req = tonic::Request::new(IngestLogRequest {
                raw_json_log: raw_json,
            });

            // [ARCH-COMPLIANCE] Zorunlu Senkron Çağrı Timeout Koruması
            req.set_timeout(std::time::Duration::from_secs(3));

            if let Err(e) = client.ingest_log(req).await {
                debug!(event="UPSTREAM_SEND_FAIL", error=%e, "⚠️ Failed to send log to upstream");
            }
        }
        Ok(())
    }
}
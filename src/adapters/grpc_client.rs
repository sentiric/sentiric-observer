// src/adapters/grpc_client.rs
use crate::core::domain::LogRecord;
use crate::ports::LogEmitter;
use async_trait::async_trait;
use anyhow::Result;
use tonic::transport::Channel;
use tracing::{error, info, debug};
use std::sync::Arc;
use tokio::sync::RwLock;

// Proto generated
use crate::api::grpc::observer_proto::observer_service_client::ObserverServiceClient;
use crate::api::grpc::observer_proto::IngestLogRequest;

pub struct GrpcEmitter {
    client: Arc<RwLock<Option<ObserverServiceClient<Channel>>>>,
    target_url: String,
}

impl GrpcEmitter {
    pub fn new(url: String) -> Self {
        Self {
            client: Arc::new(RwLock::new(None)),
            target_url: url,
        }
    }

    async fn connect(&self) -> Result<ObserverServiceClient<Channel>> {
        {
            let read_guard = self.client.read().await;
            if let Some(c) = &*read_guard { return Ok(c.clone()); }
        }

        let mut write_guard = self.client.write().await;
        if let Some(c) = &*write_guard { return Ok(c.clone()); }

        info!("🔌 Connecting to Upstream Observer: {}", self.target_url);
        let channel = Channel::from_shared(self.target_url.clone())?
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

    async fn emit(&self, _log: LogRecord) -> Result<()> { Ok(()) }

    async fn emit_batch(&self, logs: Vec<LogRecord>) -> Result<()> {
        let mut client = match self.connect().await {
            Ok(c) => c,
            Err(e) => {
                error!("❌ Upstream Connection Failed: {}", e);
                return Err(e.into());
            }
        };

        for log in logs {
            let req = tonic::Request::new(IngestLogRequest {
                service_name: log.resource.service_name,
                message: log.message,
                level: log.severity,
                trace_id: log.trace_id.unwrap_or_default(),
                node_id: log.resource.host_name.unwrap_or_else(|| "unknown".into()),
            });

            if let Err(e) = client.ingest_log(req).await {
                debug!("⚠️ Failed to send log to upstream: {}", e);
            }
        }
        Ok(())
    }
}
// src/api/grpc.rs
use crate::core::domain::LogRecord;
use tonic::{Request, Response, Status};
use tokio::sync::mpsc;

pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}

use observer_proto::observer_service_server::ObserverService;
use observer_proto::{IngestLogRequest, IngestLogResponse};

pub struct GrpcServerState {
    pub tx: mpsc::Sender<LogRecord>,
    pub tenant_id: String, //[ARCH-COMPLIANCE] Tenant ID Enjeksiyonu
}

#[tonic::async_trait]
impl ObserverService for GrpcServerState {
    async fn ingest_log(
        &self,
        request: Request<IngestLogRequest>,
    ) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();

        let mut log: LogRecord = match serde_json::from_str(&req.raw_json_log) {
            Ok(rec) => rec,
            Err(e) => {
                tracing::warn!(event="GRPC_PARSE_WARN", error=%e, "Failed to parse incoming gRPC log");
                // [ARCH-COMPLIANCE] Hardcoded system iptal edildi, mevcut tenant verildi.
                LogRecord::new_system("WARN", "GRPC_PARSE_ERROR", &e.to_string(), &self.tenant_id)
            }
        };

        log.attributes.insert("source".to_string(), serde_json::Value::String("grpc".to_string()));
        log.smart_tags.push("GRPC".to_string());
        log.smart_tags.push("REMOTE".to_string()); 

        if let Err(e) = self.tx.send(log).await {
            tracing::error!(event="GRPC_CHANNEL_FULL", error=%e, "gRPC Ingest Error (Channel Closed/Full)");
        }

        Ok(Response::new(IngestLogResponse { success: true }))
    }
}
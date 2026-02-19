use crate::core::domain::{LogRecord, ResourceContext};
use tonic::{Request, Response, Status};
use std::collections::HashMap;
use tokio::sync::mpsc;

// Proto dosyasından üretilen kodları dahil et
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}

use observer_proto::observer_service_server::ObserverService;
use observer_proto::{IngestLogRequest, IngestLogResponse};

// gRPC sunucusunun durumu (Logları ana kanala iletmek için sender tutar)
pub struct GrpcServerState {
    pub tx: mpsc::Sender<LogRecord>,
}

// KRİTİK DÜZELTME: Bu makro olmadan Rust async traitleri derleyemez.
#[tonic::async_trait]
impl ObserverService for GrpcServerState {
    async fn ingest_log(
        &self,
        request: Request<IngestLogRequest>,
    ) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();

        // Metadata zenginleştirme
        let mut attributes = HashMap::new();
        attributes.insert("source".to_string(), serde_json::Value::String("grpc".to_string()));

        // Gelen veriyi SUTS v4.0 formatına çevir
        let log = LogRecord {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: if req.level.is_empty() { "INFO".to_string() } else { req.level.to_uppercase() },
            tenant_id: "default".to_string(),
            resource: ResourceContext {
                service_name: if req.service_name.is_empty() { "unknown_grpc".to_string() } else { req.service_name },
                service_version: "unknown".to_string(),
                service_env: "production".to_string(),
                host_name: if req.node_id.is_empty() { None } else { Some(req.node_id) },
            },
            trace_id: if req.trace_id.is_empty() { None } else { Some(req.trace_id) },
            span_id: None,
            event: "GRPC_LOG_INGESTED".to_string(),
            message: req.message,
            attributes,
        };

        // Aggregator kanalına gönder (Hata olursa logla ama client'a success dön)
        if let Err(e) = self.tx.send(log).await {
            tracing::error!("gRPC Ingest Error: Kanal kapalı veya dolu. Hata: {}", e);
        }

        Ok(Response::new(IngestLogResponse { success: true }))
    }
}
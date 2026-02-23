// src/api/grpc.rs
use crate::core::domain::LogRecord;
use tonic::{Request, Response, Status};
use tokio::sync::mpsc;

// Proto dosyasından üretilen kodları dahil et
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}

use observer_proto::observer_service_server::ObserverService;
use observer_proto::{IngestLogRequest, IngestLogResponse};

pub struct GrpcServerState {
    pub tx: mpsc::Sender<LogRecord>,
}

#[tonic::async_trait]
impl ObserverService for GrpcServerState {
    async fn ingest_log(
        &self,
        request: Request<IngestLogRequest>,
    ) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();

        // Gelen JSON string'ini LogRecord'a parse et
        let mut log: LogRecord = match serde_json::from_str(&req.raw_json_log) {
            Ok(rec) => rec,
            Err(e) => {
                tracing::warn!("Failed to parse incoming gRPC log: {}", e);
                // Hatalı formatta log gelirse, boş bir log oluşturup hatayı içine yazalım
                LogRecord::system_log("WARN", "GRPC_PARSE_ERROR", &e.to_string())
            }
        };

        // Infinite Loop Koruması: Kaynağı "grpc" olarak etiketle
        log.attributes.insert("source".to_string(), serde_json::Value::String("grpc".to_string()));
        log.smart_tags.push("GRPC".to_string());
        log.smart_tags.push("REMOTE".to_string()); // UI'da renklendirme için

        // Ana kanala gönder
        if let Err(e) = self.tx.send(log).await {
            tracing::error!("gRPC Ingest Error (Channel Closed/Full): {}", e);
        }

        Ok(Response::new(IngestLogResponse { success: true }))
    }
}
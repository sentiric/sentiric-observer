use crate::model::{EventType, OtelLogRecord};
use crate::api::routes::AppState;
use tonic::{Request, Response, Status};

// Proto üretilen kodları dahil et
pub mod observer_proto {
    tonic::include_proto!("sentiric.observer.v1");
}

use observer_proto::observer_service_server::ObserverService;
use observer_proto::{IngestLogRequest, IngestLogResponse};

#[tonic::async_trait]
impl ObserverService for AppState {
    async fn ingest_log(
        &self,
        request: Request<IngestLogRequest>,
    ) -> Result<Response<IngestLogResponse>, Status> {
        let req = request.into_inner();

        let log = OtelLogRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: req.level.to_uppercase(),
            service: req.service_name,
            node: req.node_id,
            trace_id: if req.trace_id.is_empty() { None } else { Some(req.trace_id) },
            event_type: EventType::Log,
            body: req.message,
            attributes: serde_json::json!({ "source": "remote_grpc" }),
        };

        // Ana kanala gönder (UI ve diğerleri görsün)
        let _ = self.tx.send(log);

        Ok(Response::new(IngestLogResponse { success: true }))
    }
}
use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use crate::utils::parser; // ANSI cleaner
use anyhow::Result;
use async_trait::async_trait;
use bollard::container::{ListContainersOptions, LogsOptions};
use bollard::Docker;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc::Sender;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

fn extract_call_id_from_json(map: &serde_json::Map<String, Value>) -> Option<&str> {
    const CALL_ID_KEYS: [&str; 3] = ["call_id", "callid", "sip.call_id"];
    for (key, value) in map {
        if CALL_ID_KEYS.iter().any(|&k| k.eq_ignore_ascii_case(key)) {
            if let Some(s) = value.as_str() {
                return Some(s);
            }
        }
    }
    None
}

pub struct DockerIngestor {
    docker: Docker,
    tx: Sender<LogRecord>,
    node_name: String,
    monitored_containers: Arc<Mutex<HashMap<String, String>>>,
}

impl DockerIngestor {
    pub fn new(socket_path: &str, tx: Sender<LogRecord>, node_name: String) -> Result<Self> {
        let docker = Docker::connect_with_unix(socket_path, 120, bollard::API_DEFAULT_VERSION)
            .or_else(|_| Docker::connect_with_local_defaults())
            .map_err(|e| anyhow::anyhow!("Docker bağlantı hatası: {}", e))?;
        Ok(Self { docker, tx, node_name, monitored_containers: Arc::new(Mutex::new(HashMap::new())) })
    }

    fn process_line(&self, line: String, container_name: &str, stream_type: &str) -> LogRecord {
        let cleaned_line = parser::clean_ansi(&line);

        if let Ok(mut record) = serde_json::from_str::<LogRecord>(&cleaned_line) {
            if record.resource.host_name.is_none() {
                record.resource.host_name = Some(self.node_name.clone());
            }
            return record;
        }
        
        if let Ok(json_val) = serde_json::from_str::<Value>(&cleaned_line) {
            if let Some(map) = json_val.as_object() {
                let message = map.get("message").and_then(Value::as_str).unwrap_or(&cleaned_line).to_string();
                let severity = map.get("level").and_then(Value::as_str).unwrap_or("INFO").to_uppercase();
                let ts = map.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
                
                let mut attributes = HashMap::new();
                if let Some(cid) = extract_call_id_from_json(map) {
                    attributes.insert("sip.call_id".to_string(), Value::String(cid.to_string()));
                }

                return LogRecord {
                    schema_v: "1.0.0".to_string(),
                    ts: if ts.is_empty() { chrono::Utc::now().to_rfc3339() } else { ts },
                    severity, tenant_id: "default".to_string(),
                    resource: ResourceContext {
                        service_name: container_name.to_string(), service_version: "unknown".to_string(),
                        service_env: "production".to_string(), host_name: Some(self.node_name.clone()),
                    },
                    trace_id: None, span_id: None, event: "JSON_LOG_PARSED".to_string(),
                    message, attributes,
                };
            }
        }

        let severity = if stream_type == "stderr" { "ERROR" } else { "INFO" };
        LogRecord {
            schema_v: "1.0.0".to_string(), ts: chrono::Utc::now().to_rfc3339(),
            severity: severity.to_string(), tenant_id: "default".to_string(),
            resource: ResourceContext {
                service_name: container_name.to_string(), service_version: "unknown".to_string(),
                service_env: "production".to_string(), host_name: Some(self.node_name.clone()),
            },
            trace_id: None, span_id: None, event: "RAW_LOG_OUTPUT".to_string(),
            message: cleaned_line, attributes: HashMap::new(),
        }
    }
}

#[async_trait]
impl LogIngestor for DockerIngestor {
    async fn start(&self) -> Result<()> {
        info!("🐳 Docker Ingestor: Başlatıldı (Node: {})", self.node_name);
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            let options = ListContainersOptions::<String> { all: true, ..Default::default() };
            match self.docker.list_containers(Some(options)).await {
                Ok(containers) => {
                    let mut monitored = self.monitored_containers.lock().await;
                    for container in containers {
                        let id = container.id.unwrap_or_default();
                        let name = container.names.as_ref().and_then(|names| names.first())
                            .map(|s| s.trim_start_matches('/').to_string()).unwrap_or_else(|| "unknown".to_string());
                        if name.contains("observer") { continue; }
                        if !monitored.contains_key(&id) && !id.is_empty() {
                            info!("✨ Yeni Servis Algılandı: {} ({})", name, &id[..12]);
                            monitored.insert(id.clone(), name.clone());
                            let docker_clone = self.docker.clone(); let tx_clone = self.tx.clone();
                            let node_name_clone = self.node_name.clone(); let monitored_clone = self.monitored_containers.clone();
                            let id_clone = id.clone(); let name_clone = name.clone();
                            tokio::spawn(async move {
                                let options = LogsOptions::<String> { follow: true, stdout: true, stderr: true, tail: "0".into(), ..Default::default() };
                                let mut stream = docker_clone.logs(&id_clone, Some(options));
                                let ingestor_logic = DockerIngestor { docker: docker_clone, tx: tx_clone.clone(), node_name: node_name_clone, monitored_containers: monitored_clone.clone() };
                                while let Some(log_result) = stream.next().await {
                                    match log_result {
                                        Ok(log_output) => {
                                            let (msg, stream_type) = match log_output {
                                                bollard::container::LogOutput::StdOut { message } => (message, "stdout"),
                                                bollard::container::LogOutput::StdErr { message } => (message, "stderr"),
                                                _ => (bytes::Bytes::new(), "unknown"),
                                            };
                                            let text = String::from_utf8_lossy(&msg).trim().to_string();
                                            if !text.is_empty() {
                                                let record = ingestor_logic.process_line(text, &name_clone, stream_type);
                                                if tx_clone.send(record).await.is_err() { break; }
                                            }
                                        }
                                        Err(e) => { warn!("Log stream hatası ({}): {}", name_clone, e); break; }
                                    }
                                }
                                warn!("💀 Servis Durdu/Log Kesildi: {}", name_clone);
                                let mut mon = monitored_clone.lock().await;
                                mon.remove(&id_clone);
                            });
                        }
                    }
                }
                Err(e) => { error!("Docker listeleme hatası: {}", e); }
            }
        }
    }
}
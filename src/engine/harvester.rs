use crate::model::{EventType, OtelLogRecord};
use crate::engine::aggregator::Aggregator;
use bollard::container::{ListContainersOptions, LogsOptions};
use bollard::Docker;
use bollard::API_DEFAULT_VERSION; // API Versiyonu eklendi
use futures_util::StreamExt;
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::Sender;
use tracing::{info, warn};

lazy_static! {
    static ref ANSI_REGEX: Regex = Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
}

pub struct DockerHarvester {
    docker: Docker,
    tx: Sender<OtelLogRecord>,
    node_name: String,
    monitored_containers: Arc<Mutex<HashSet<String>>>,
}

impl DockerHarvester {
    pub fn new(tx: Sender<OtelLogRecord>, node_name: String, socket_path: String) -> Self {
        // [DÜZELTME]: Bollard v0.15 için 3 parametreli bağlantı
        let docker = Docker::connect_with_unix(&socket_path, 120, &API_DEFAULT_VERSION)
            .or_else(|_| Docker::connect_with_local_defaults())
            .expect("Docker bağlantısı başarısız!");
        
        Self {
            docker,
            tx,
            node_name,
            monitored_containers: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub async fn run(&self) {
        info!("🐳 Docker Harvester: Başlatıldı (Node: {})", self.node_name);
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            self.scan_and_spawn().await;
        }
    }

    async fn scan_and_spawn(&self) {
        let options = ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        };

        if let Ok(containers) = self.docker.list_containers(Some(options)).await {
            for container in containers {
                let names = container.names.unwrap_or_default();
                let name = names.first().map(|s| s.trim_start_matches('/')).unwrap_or("unknown");

                if name.contains("observer") { continue; }

                let id = container.id.unwrap_or_default();
                if id.is_empty() { continue; }

                let is_new = {
                    let mut set = self.monitored_containers.lock().unwrap();
                    set.insert(id.clone())
                };

                if is_new {
                    info!("✨ Yeni Servis Algılandı: {} ({})", name, &id[..12]);
                    self.spawn_log_stream(id, name.to_string());
                }
            }
        }
    }

    fn spawn_log_stream(&self, id: String, name: String) {
        let docker = self.docker.clone();
        let tx = self.tx.clone();
        let node = self.node_name.clone();
        let monitored = self.monitored_containers.clone();
        let container_id_clone = id.clone();

        tokio::spawn(async move {
            let options = LogsOptions::<String> {
                follow: true, stdout: true, stderr: true, tail: "0".into(), ..Default::default()
            };

            let mut stream = docker.logs(&id, Some(options));

            while let Some(log_result) = stream.next().await {
                if let Ok(log_msg) = log_result {
                    let raw_msg = log_msg.to_string();
                    let clean_msg = ANSI_REGEX.replace_all(&raw_msg, "").trim().to_string();
                    if clean_msg.is_empty() { continue; }

                    let record = match serde_json::from_str::<serde_json::Value>(&clean_msg) {
                        Ok(json_val) => OtelLogRecord {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            level: json_val.get("level").and_then(|v| v.as_str()).unwrap_or("INFO").to_uppercase(),
                            service: name.clone(),
                            node: node.clone(),
                            trace_id: json_val.get("trace_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            event_type: EventType::Log,
                            body: json_val.get("message").and_then(|v| v.as_str()).unwrap_or(&clean_msg).to_string(),
                            attributes: json_val,
                        },
                        Err(_) => OtelLogRecord::new_log(name.clone(), node.clone(), "INFO".into(), clean_msg),
                    };

                    // [AGGREGATOR ENTEGRASYONU]
                    let processed_record = Aggregator::process(record);
                    let _ = tx.send(processed_record);
                }
            }
            warn!("💀 Servis Durdu: {}", name);
            let mut set = monitored.lock().unwrap();
            set.remove(&container_id_clone);
        });
    }
}
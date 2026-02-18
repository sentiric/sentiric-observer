use crate::model::{OtelLogRecord, OtelResource};
use bollard::container::{ListContainersOptions, LogsOptions};
use bollard::Docker;
use futures_util::StreamExt;
use tokio::sync::broadcast::Sender;
use tracing::{error, info, warn};
use std::collections::HashMap;

lazy_static::lazy_static! {
    static ref ANSI_REGEX: regex::Regex = regex::Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
}

pub struct DockerHarvester {
    docker: Docker,
    tx: Sender<String>,
    host_name: String,
}

impl DockerHarvester {
    pub fn new(tx: Sender<String>, host_name: String) -> Self {
        let docker = Docker::connect_with_local_defaults()
            .expect("Docker bağlantısı başarısız! /var/run/docker.sock mount edildi mi?");
        Self { docker, tx, host_name }
    }

    pub async fn run(&self) {
        info!("🐳 Docker Harvester: Konteyner logları taranıyor...");
        let options = ListContainersOptions { all: true, filters: HashMap::<String, Vec<String>>::new(), ..Default::default() };

        if let Ok(containers) = self.docker.list_containers(Some(options)).await {
            for container in containers {
                if let Some(names) = &container.names {
                    if names.iter().any(|n| n.contains("observer") || n.contains("registrator")) { continue; }
                }

                if let Some(id) = container.id {
                    let name = container.names.unwrap_or_default().first().cloned().unwrap_or_else(|| "unknown".into());
                    self.spawn_logger(id, name.trim_start_matches('/').to_string());
                }
            }
        } else {
            error!("Docker'a bağlanılamadı veya konteynerler listelenemedi.");
        }
    }

    fn spawn_logger(&self, container_id: String, service_name: String) {
        let docker = self.docker.clone();
        let tx = self.tx.clone();
        let host = self.host_name.clone();

        tokio::spawn(async move {
            info!("└── Log akışı bağlandı: {}", service_name);
            let options = LogsOptions::<String> { follow: true, stdout: true, stderr: true, tail: "10".into(), ..Default::default() };
            let mut stream = docker.logs(&container_id, Some(options));

            while let Some(log_result) = stream.next().await {
                if let Ok(log_output) = log_result {
                    let msg = log_output.to_string();
                    let clean_msg = ANSI_REGEX.replace_all(&msg, "").trim().to_string();
                    if clean_msg.is_empty() { continue; }

                    let otel_record = match serde_json::from_str::<serde_json::Value>(&clean_msg) {
                        Ok(json_val) => OtelLogRecord {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            severity_text: json_val.get("level").and_then(|v| v.as_str()).unwrap_or("INFO").to_uppercase(),
                            body: json_val.get("message").and_then(|v| v.as_str()).unwrap_or(&clean_msg).to_string(),
                            resource: OtelResource { service_name: service_name.clone(), host_name: host.clone() },
                            attributes: json_val,
                        },
                        Err(_) => OtelLogRecord::new_raw(service_name.clone(), host.clone(), clean_msg),
                    };

                    if let Ok(json_str) = serde_json::to_string(&otel_record) {
                        let _ = tx.send(json_str);
                    }
                }
            }
            warn!("└── Log akışı koptu: {}", service_name);
        });
    }
}
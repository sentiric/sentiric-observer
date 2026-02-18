// sentiric-observer/src/docker_harvester.rs
use crate::model::{OtelLogRecord, OtelResource};
use bollard::container::{ListContainersOptions, LogsOptions};
use bollard::Docker;
use futures_util::StreamExt;
// [DÜZELTME] unused Arc kaldırıldı.
use tokio::sync::broadcast::Sender;
use tracing::{error, info, warn};
use std::collections::HashMap;

// Log satırlarında ANSI renk kodlarını temizlemek için
lazy_static::lazy_static! {
    static ref ANSI_REGEX: regex::Regex = regex::Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
}

pub struct DockerHarvester {
    docker: Docker,
    tx: Sender<String>, // WebSocket'e gidecek kanal
    host_name: String,
}

impl DockerHarvester {
    pub fn new(tx: Sender<String>, host_name: String) -> Self {
        // Docker soketine bağlan (Linux default)
        let docker = Docker::connect_with_local_defaults()
            .expect("Docker bağlantısı başarısız! /var/run/docker.sock mount edildi mi?");
        
        Self { docker, tx, host_name }
    }

    /// Ana döngü: Konteynerleri bul ve dinle
    pub async fn run(&self) {
        info!("🐳 Docker Harvester başlatıldı. Konteynerler taranıyor...");

        // [DÜZELTME] Tip belirsizliği giderildi: HashMap<String, Vec<String>>
        let filters: HashMap<String, Vec<String>> = HashMap::new();

        let options = ListContainersOptions {
            all: true,
            filters, // Değişken burada kullanılarak tipi kesinleştirildi
            ..Default::default()
        };

        match self.docker.list_containers(Some(options)).await {
            Ok(containers) => {
                for container in containers {
                    // Observer'ın kendi loglarını dinlemesini engelle (Sonsuz döngü riski)
                    if let Some(names) = &container.names {
                        if names.iter().any(|n| n.contains("observer")) {
                            continue;
                        }
                    }

                    if let Some(id) = container.id {
                        let name = container.names.unwrap_or_default().first().cloned().unwrap_or("unknown".into());
                        // "/" karakterini temizle (/sentiric-sbc -> sentiric-sbc)
                        let clean_name = name.trim_start_matches('/').to_string();
                        
                        self.spawn_logger(id, clean_name);
                    }
                }
            }
            Err(e) => error!("Docker listeleme hatası: {}", e),
        }
    }

    fn spawn_logger(&self, container_id: String, service_name: String) {
        let docker = self.docker.clone();
        let tx = self.tx.clone();
        let host = self.host_name.clone();

        tokio::spawn(async move {
            info!("🔌 Log akışı bağlandı: {}", service_name);

            let options = LogsOptions::<String> {
                follow: true,
                stdout: true,
                stderr: true,
                tail: "10".into(), // Son 10 satırdan başla
                ..Default::default()
            };

            let mut stream = docker.logs(&container_id, Some(options));

            while let Some(log_result) = stream.next().await {
                match log_result {
                    Ok(log_output) => {
                        let msg = log_output.to_string();
                        // ANSI kodlarını temizle
                        let clean_msg = ANSI_REGEX.replace_all(&msg, "").to_string();
                        if clean_msg.trim().is_empty() { continue; }

                        // JSON Parse Denemesi
                        let otel_record = match serde_json::from_str::<serde_json::Value>(&clean_msg) {
                            Ok(json_val) => {
                                // Eğer zaten bizim formatımızdaysa (STS v2.0)
                                if json_val.get("Timestamp").is_some() && json_val.get("Body").is_some() {
                                    serde_json::to_string(&json_val).unwrap_or_default()
                                } else {
                                    // Başka bir JSON ise sar sarmala
                                    let record = OtelLogRecord {
                                        timestamp: chrono::Utc::now().to_rfc3339(),
                                        severity_text: json_val.get("level").and_then(|v| v.as_str()).unwrap_or("INFO").to_uppercase(),
                                        body: json_val.get("message").and_then(|v| v.as_str()).unwrap_or(&clean_msg).to_string(),
                                        resource: OtelResource {
                                            service_name: service_name.clone(),
                                            host_name: host.clone(),
                                        },
                                        attributes: Some(json_val),
                                    };
                                    serde_json::to_string(&record).unwrap_or_default()
                                }
                            },
                            Err(_) => {
                                // Düz Metin (Legacy Loglar)
                                let record = OtelLogRecord::new_raw(
                                    service_name.clone(),
                                    host.clone(),
                                    clean_msg
                                );
                                serde_json::to_string(&record).unwrap_or_default()
                            }
                        };

                        // WebSocket kanalına bas
                        if !otel_record.is_empty() {
                            let _ = tx.send(otel_record);
                        }
                    }
                    Err(_) => break, // Stream koptu
                }
            }
            warn!("🔌 Log akışı koptu: {}", service_name);
        });
    }
}
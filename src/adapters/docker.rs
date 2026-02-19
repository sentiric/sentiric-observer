use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use anyhow::Result;
use async_trait::async_trait;
use bollard::container::{ListContainersOptions, LogsOptions};
use bollard::Docker;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc::Sender;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

pub struct DockerIngestor {
    docker: Docker,
    tx: Sender<LogRecord>,
    node_name: String,
    monitored_containers: Arc<Mutex<HashMap<String, String>>>, // ID -> Name
}

impl DockerIngestor {
    pub fn new(socket_path: &str, tx: Sender<LogRecord>, node_name: String) -> Result<Self> {
        // Platforma göre bağlantı (Unix Socket veya Named Pipe)
        let docker = Docker::connect_with_unix(socket_path, 120, bollard::API_DEFAULT_VERSION)
            .or_else(|_| Docker::connect_with_local_defaults())
            .map_err(|e| anyhow::anyhow!("Docker bağlantı hatası: {}", e))?;

        Ok(Self {
            docker,
            tx,
            node_name,
            monitored_containers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Ham log satırını (JSON veya Text) SUTS v4.0 formatına çevirir
    fn process_line(&self, line: String, container_name: &str, stream_type: &str) -> LogRecord {
        // 1. Önce JSON olarak parse etmeyi dene (SUTS uyumlu servisler)
        if let Ok(mut record) = serde_json::from_str::<LogRecord>(&line) {
            // Eksik alanları tamamla (Enrichment)
            if record.resource.host_name.is_none() {
                record.resource.host_name = Some(self.node_name.clone());
            }
            return record;
        }

        // 2. JSON değilse (Legacy veya Panic çıktısı), Raw Log olarak paketle
        let severity = if stream_type == "stderr" { "ERROR" } else { "INFO" };
        
        LogRecord {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: severity.to_string(),
            tenant_id: "default".to_string(),
            resource: ResourceContext {
                service_name: container_name.to_string(),
                service_version: "unknown".to_string(),
                service_env: "production".to_string(),
                host_name: Some(self.node_name.clone()),
            },
            trace_id: None,
            span_id: None,
            event: "RAW_LOG_OUTPUT".to_string(),
            message: line, // Ham mesaj
            attributes: HashMap::new(),
        }
    }
}

#[async_trait]
impl LogIngestor for DockerIngestor {
    async fn start(&self) -> Result<()> {
        info!("🐳 Docker Ingestor: Başlatıldı (Node: {})", self.node_name);

        // Discovery Loop: Her 5 saniyede bir yeni konteyner var mı diye bakar
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));

        loop {
            interval.tick().await;

            let options = ListContainersOptions::<String> {
                all: true,
                ..Default::default()
            };

            match self.docker.list_containers(Some(options)).await {
                Ok(containers) => {
                    let mut monitored = self.monitored_containers.lock().await;
                    
                    for container in containers {
                        let id = container.id.unwrap_or_default();
                        // Container isimleri "/app-name" şeklinde gelir, slash'ı temizle
                        let name = container.names.unwrap_or_default()
                            .first().map(|s| s.trim_start_matches('/').to_string())
                            .unwrap_or("unknown".to_string());

                        // Kendi kendimizi izlemeyelim (Loop olmasın)
                        if name.contains("observer") { continue; }

                        if !monitored.contains_key(&id) && !id.is_empty() {
                            info!("✨ Yeni Servis Algılandı: {} ({})", name, &id[..12]);
                            monitored.insert(id.clone(), name.clone());
                            
                            // Yeni bir task spawn et (Stream Log)
                            let docker_clone = self.docker.clone();
                            let tx_clone = self.tx.clone();
                            let node_name_clone = self.node_name.clone();
                            let monitored_clone = self.monitored_containers.clone();
                            let id_clone = id.clone();
                            let name_clone = name.clone();

                            tokio::spawn(async move {
                                let options = LogsOptions::<String> {
                                    follow: true,
                                    stdout: true,
                                    stderr: true,
                                    tail: "0".into(), // Sadece yeni logları al
                                    ..Default::default()
                                };

                                let mut stream = docker_clone.logs(&id_clone, Some(options));

                                // Ingestor struct'ını burada tekrar oluşturamayız (Clone yok),
                                // bu yüzden process logic'ini basit tutacağız.
                                let ingestor_logic = DockerIngestor { 
                                    docker: docker_clone, 
                                    tx: tx_clone.clone(), 
                                    node_name: node_name_clone, 
                                    monitored_containers: monitored_clone.clone() 
                                };

                                while let Some(log_result) = stream.next().await {
                                    match log_result {
                                        Ok(log_output) => {
                                            // Bollard LogOutput enum döner (StdOut/StdErr)
                                            let (msg, stream_type) = match log_output {
                                                bollard::container::LogOutput::StdOut { message } => (message, "stdout"),
                                                bollard::container::LogOutput::StdErr { message } => (message, "stderr"),
                                                _ => (bytes::Bytes::new(), "unknown"),
                                            };

                                            let text = String::from_utf8_lossy(&msg).trim().to_string();
                                            if !text.is_empty() {
                                                let record = ingestor_logic.process_line(text, &name_clone, stream_type);
                                                if let Err(_) = tx_clone.send(record).await {
                                                    break; // Kanal kapandıysa çık
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            warn!("Log stream hatası ({}): {}", name_clone, e);
                                            break;
                                        }
                                    }
                                }

                                warn!("💀 Servis Durdu/Log Kesildi: {}", name_clone);
                                let mut mon = monitored_clone.lock().await;
                                mon.remove(&id_clone);
                            });
                        }
                    }
                }
                Err(e) => {
                    error!("Docker listeleme hatası: {}", e);
                    // Exponential backoff yerine basit bekleme, loop devam eder.
                }
            }
        }
    }
}
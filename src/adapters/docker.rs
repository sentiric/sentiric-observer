// sentiric-observer/src/adapters/docker.rs
use crate::core::domain::{LogRecord, ResourceContext};
use crate::ports::LogIngestor;
use crate::utils::parser;
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
            .map_err(|e| anyhow::anyhow!("Docker Connect Fail: {}", e))?;
        Ok(Self { docker, tx, node_name, monitored_containers: Arc::new(Mutex::new(HashMap::new())) })
    }

    // [ROBUSTNESS FIX]: JSON parse hatası olduğunda veriyi atmak yerine RAW olarak sarmalıyoruz.
    fn process_line(&self, line: String, container_name: &str, stream_type: &str) -> LogRecord {
        let cleaned_line = parser::clean_ansi(&line);

        // 1. Önce Generic JSON olarak parse etmeyi dene (En hızlı yöntem)
        match serde_json::from_str::<Value>(&cleaned_line) {
            Ok(json_val) => {
                // Eğer bir obje ise (Array veya String değil)
                if let Some(map) = json_val.as_object() {
                    // SUTS uyumlu alanları çekmeye çalış
                    let schema = map.get("schema_v").and_then(Value::as_str).unwrap_or("1.0.0");
                    let severity = map.get("severity")
                        .or_else(|| map.get("level"))
                        .and_then(Value::as_str)
                        .unwrap_or(if stream_type == "stderr" { "ERROR" } else { "INFO" })
                        .to_uppercase();
                    
                    let msg = map.get("message")
                        .or_else(|| map.get("msg"))
                        .and_then(Value::as_str)
                        .unwrap_or(&cleaned_line)
                        .to_string();

                    let ts = map.get("ts")
                        .or_else(|| map.get("time"))
                        .or_else(|| map.get("timestamp"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();

                    let trace_id = map.get("trace_id").and_then(Value::as_str).map(|s| s.to_string());
                    let event = map.get("event").and_then(Value::as_str).unwrap_or("LOG_EVENT").to_string();

                    // Attributes ayıkla
                    let mut attributes = HashMap::new();
                    // Orijinal "attributes" alanı varsa onu al
                    if let Some(attrs) = map.get("attributes").and_then(Value::as_object) {
                        for (k, v) in attrs {
                            attributes.insert(k.clone(), v.clone());
                        }
                    } 
                    // Yoksa kök dizindeki diğer alanları attribute yap (User-Service, Media-Service uyumu)
                    else {
                        for (k, v) in map {
                            if !["schema_v", "severity", "level", "message", "msg", "ts", "time", "trace_id", "event", "resource"].contains(&k.as_str()) {
                                attributes.insert(k.clone(), v.clone());
                            }
                        }
                    }

                    // Resource Context'i koru veya varsayılanı kullan
                    let resource = if let Some(r) = map.get("resource").and_then(Value::as_object) {
                        ResourceContext {
                            service_name: r.get("service.name").and_then(Value::as_str).unwrap_or(container_name).to_string(),
                            service_version: r.get("service.version").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                            service_env: r.get("service.env").and_then(Value::as_str).unwrap_or("production").to_string(),
                            host_name: Some(self.node_name.clone()),
                        }
                    } else {
                        ResourceContext {
                            service_name: container_name.to_string(),
                            service_version: "unknown".to_string(),
                            service_env: "production".to_string(),
                            host_name: Some(self.node_name.clone()),
                        }
                    };

                    let mut record = LogRecord {
                        schema_v: schema.to_string(),
                        ts: if ts.is_empty() { chrono::Utc::now().to_rfc3339() } else { ts },
                        severity,
                        tenant_id: "default".to_string(),
                        resource,
                        trace_id,
                        span_id: None,
                        event,
                        message: msg,
                        attributes,
                        smart_tags: vec![],
                        _idx: 0.0, // Aggregator veya Main loop bunu dolduracak
                    };
                    
                    record.sanitize_and_enrich();
                    return record;
                }
            }
            Err(_) => {
                // JSON Parse edilemedi -> RAW TEXT Log
                // Media Service bazen bozuk JSON veya düz text basabilir, bunu kaçırmamalıyız.
            }
        }

        // Fallback: Raw Log Record
        let mut raw_record = LogRecord {
            schema_v: "1.0.0".to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            severity: if stream_type == "stderr" { "ERROR".to_string() } else { "INFO".to_string() },
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
            message: cleaned_line,
            attributes: HashMap::new(),
            smart_tags: vec!["RAW".to_string()],
            _idx: 0.0,
        };
        raw_record.sanitize_and_enrich();
        raw_record
    }
}

#[async_trait]
impl LogIngestor for DockerIngestor {
    async fn start(&self) -> Result<()> {
        info!("🐳 Docker Ingestor: Başlatıldı (Node: {})", self.node_name);
        
        // Başlangıç zamanı
        let mut last_scan_time = chrono::Utc::now().timestamp();
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));

        loop {
            interval.tick().await;
            let current_scan_time = chrono::Utc::now().timestamp();

            let options = ListContainersOptions::<String> { all: true, ..Default::default() };
            match self.docker.list_containers(Some(options)).await {
                Ok(containers) => {
                    let mut monitored = self.monitored_containers.lock().await;
                    for container in containers {
                        let id = container.id.unwrap_or_default();
                        // Container ismini düzelt (/sbc-service -> sbc-service)
                        let name = container.names.as_ref()
                            .and_then(|names| names.first())
                            .map(|s| s.trim_start_matches('/').to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        
                        // Observer kendini izlemesin (Loop prevention)
                        if name.contains("observer") { continue; }
                        
                        if !monitored.contains_key(&id) && !id.is_empty() {
                            info!("✨ Yeni Hedef Kilitlendi: {} (ID: {:.8})", name, id);
                            monitored.insert(id.clone(), name.clone());
                            
                            // Clone'lar (Tokio task için)
                            let docker = self.docker.clone(); 
                            let tx = self.tx.clone();
                            let node = self.node_name.clone(); 
                            let monitored_map = self.monitored_containers.clone();
                            let container_id = id.clone(); 
                            let container_name = name.clone();
                            let since = last_scan_time;

                            tokio::spawn(async move {
                                let opts = LogsOptions::<String> { 
                                    follow: true, 
                                    stdout: true, 
                                    stderr: true, 
                                    since: since, 
                                    timestamps: false, // Timestamp'i Docker'dan değil logun içinden alacağız
                                    ..Default::default() 
                                };
                                
                                let mut stream = docker.logs(&container_id, Some(opts));
                                let ingestor = DockerIngestor { 
                                    docker: docker.clone(), 
                                    tx: tx.clone(), 
                                    node_name: node.clone(), 
                                    monitored_containers: monitored_map.clone() 
                                };

                                while let Some(log_result) = stream.next().await {
                                    match log_result {
                                        Ok(output) => {
                                            let (msg, stream_type) = match output {
                                                bollard::container::LogOutput::StdOut { message } => (message, "stdout"),
                                                bollard::container::LogOutput::StdErr { message } => (message, "stderr"),
                                                _ => (bytes::Bytes::new(), "unknown"),
                                            };
                                            
                                            // Lossy conversion (Bozuk karakterler patlatmasın)
                                            let text = String::from_utf8_lossy(&msg).trim().to_string();
                                            if !text.is_empty() {
                                                let record = ingestor.process_line(text, &container_name, stream_type);
                                                
                                                // [CRITICAL]: Channel doluysa bekleme, drop et ve uyar (Backpressure)
                                                // try_send kullanmıyoruz çünkü buffer dolu diye veri kaybetmek istemiyoruz,
                                                // ancak sistem çok sıkışırsa send().await bloklar.
                                                // Burası "Ürün Kararı" gerektirir: Hız mı, Veri Bütünlüğü mü?
                                                // Panopticon "Forensics" aracı olduğu için veri bütünlüğü önemli -> await.
                                                if let Err(_) = tx.send(record).await {
                                                    // Kanal kapandıysa (Main process öldüyse)
                                                    break;
                                                }
                                            }
                                        }
                                        Err(e) => { 
                                            warn!("Stream Hatası ({}): {}", container_name, e); 
                                            break; 
                                        }
                                    }
                                }
                                
                                warn!("💀 Bağlantı Koptu: {}", container_name);
                                let mut m = monitored_map.lock().await;
                                m.remove(&container_id);
                            });
                        }
                    }
                }
                Err(e) => error!("Docker API Hatası: {}", e),
            }
            last_scan_time = current_scan_time;
        }
    }
}
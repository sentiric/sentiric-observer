// Dosya: src/config.rs
use std::env;

#[derive(Debug, Clone)]
pub struct AppConfig {
    // --- Basic ---
    pub env: String,
    pub host: String,
    pub http_port: u16,
    pub grpc_port: u16,
    #[allow(dead_code)]
    pub metric_port: u16,
    pub docker_socket: String,

    // --- Feature Flags (Sniffer) ---
    pub sniffer_enabled: bool,
    pub sniffer_interface: String,
    pub sniffer_filter: String,

    // --- Memory Governance (Aggregator) ---
    pub max_active_sessions: usize,
    pub session_ttl_seconds: i64,

    // --- mTLS Security & Upstream ---
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
    pub tls_ca_path: Option<String>,
    pub upstream_url: String,

    // [ARCH-COMPLIANCE] Tenant ID
    pub tenant_id: String,
}

impl AppConfig {
    pub fn load() -> Self {
        // [ARCH-COMPLIANCE] Tenant ID doğrulaması
        let tenant_id = env::var("TENANT_ID").unwrap_or_default();
        if tenant_id.trim().is_empty() {
            panic!("[ARCH-COMPLIANCE] TENANT_ID ortam değişkeni ZORUNLUDUR ve boş olamaz. Servis başlatılamaz.");
        }

        Self {
            env: env::var("ENV").unwrap_or_else(|_| "development".into()),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            http_port: env::var("HTTP_PORT")
                .or_else(|_| env::var("OBSERVER_SERVICE_HTTP_PORT"))
                .unwrap_or("11070".to_string())
                .parse()
                .unwrap_or(11070),
            grpc_port: env::var("GRPC_PORT")
                .or_else(|_| env::var("OBSERVER_SERVICE_GRPC_PORT"))
                .unwrap_or("11071".to_string())
                .parse()
                .unwrap_or(11071),
            metric_port: env::var("METRIC_PORT")
                .or_else(|_| env::var("OBSERVER_SERVICE_METRICS_PORT"))
                .unwrap_or("11072".to_string())
                .parse()
                .unwrap_or(11072),
            docker_socket: env::var("DOCKER_SOCKET").unwrap_or_else(|_| {
                if cfg!(target_os = "windows") {
                    "//./pipe/docker_engine".into()
                } else {
                    "/var/run/docker.sock".into()
                }
            }),

            sniffer_enabled: env::var("SNIFFER_ENABLED")
                .unwrap_or("false".to_string())
                .parse()
                .unwrap_or(false),
            sniffer_interface: env::var("SNIFFER_INTERFACE").unwrap_or_else(|_| {
                if cfg!(target_os = "linux") {
                    "any".into()
                } else {
                    "lo0".into()
                }
            }),
            sniffer_filter: env::var("SNIFFER_FILTER")
                .unwrap_or("port 5060 or port 5061".to_string()),

            max_active_sessions: env::var("MAX_ACTIVE_SESSIONS")
                .unwrap_or("10000".to_string())
                .parse()
                .unwrap_or(10000),
            session_ttl_seconds: env::var("SESSION_TTL_SECONDS")
                .unwrap_or("300".to_string())
                .parse()
                .unwrap_or(300),

            //[ARCH-COMPLIANCE]: Docker Compose legacy isimlerini ve standart isimleri destekle
            tls_cert_path: env::var("TLS_CERT_PATH")
                .or_else(|_| env::var("OBSERVER_SERVICE_CERT_PATH"))
                .ok(),
            tls_key_path: env::var("TLS_KEY_PATH")
                .or_else(|_| env::var("OBSERVER_SERVICE_KEY_PATH"))
                .ok(),
            tls_ca_path: env::var("TLS_CA_PATH")
                .or_else(|_| env::var("GRPC_TLS_CA_PATH"))
                .ok(),

            upstream_url: env::var("UPSTREAM_OBSERVER_URL").unwrap_or_default(),
            tenant_id,
        }
    }
}

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
    pub sniffer_enabled: bool,      // Aç/Kapa anahtarı
    pub sniffer_interface: String,  // Hangi kartı dinleyelim? (eth0, any)
    pub sniffer_filter: String,     // Hangi paketleri alalım? (port 5060)

    // --- Memory Governance (Aggregator) ---
    pub max_active_sessions: usize, // RAM koruması (örn: 10,000)
    pub session_ttl_seconds: i64,   // Ne kadar süre sonra unutalım? (örn: 300sn)
}

impl AppConfig {
    pub fn load() -> Self {
        Self {
            // Basic
            env: env::var("ENV").unwrap_or_else(|_| "development".into()),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            http_port: env::var("HTTP_PORT").unwrap_or("11070".to_string()).parse().unwrap_or(11070),
            grpc_port: env::var("GRPC_PORT").unwrap_or("11071".to_string()).parse().unwrap_or(11071),
            metric_port: env::var("METRIC_PORT").unwrap_or("11072".to_string()).parse().unwrap_or(11072),
            docker_socket: env::var("DOCKER_SOCKET").unwrap_or_else(|_| 
                if cfg!(target_os = "windows") { "//./pipe/docker_engine".into() } 
                else { "/var/run/docker.sock".into() }
            ),

            // Sniffer Config (Varsayılan: Kapalı - Performans için)
            sniffer_enabled: env::var("SNIFFER_ENABLED").unwrap_or("false".to_string()).parse().unwrap_or(false),
            sniffer_interface: env::var("SNIFFER_INTERFACE").unwrap_or_else(|_| 
                if cfg!(target_os = "linux") { "any".into() } else { "lo0".into() }
            ),
            sniffer_filter: env::var("SNIFFER_FILTER").unwrap_or("port 5060 or port 5061".to_string()),

            // Aggregator Limits (Carrier-Grade Defaults)
            max_active_sessions: env::var("MAX_ACTIVE_SESSIONS").unwrap_or("10000".to_string()).parse().unwrap_or(10000),
            session_ttl_seconds: env::var("SESSION_TTL_SECONDS").unwrap_or("300".to_string()).parse().unwrap_or(300), // 5 Dakika
        }
    }
}
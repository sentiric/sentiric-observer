use std::env;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub env: String,
    pub host: String,
    pub http_port: u16,
    pub grpc_port: u16,
    pub docker_socket: String,
}

impl AppConfig {
    pub fn load() -> Self {
        Self {
            env: env::var("ENV").unwrap_or_else(|_| "development".into()),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            http_port: env::var("HTTP_PORT").unwrap_or("11070".to_string()).parse().unwrap_or(11070),
            grpc_port: env::var("GRPC_PORT").unwrap_or("11071".to_string()).parse().unwrap_or(11071),
            docker_socket: env::var("DOCKER_SOCKET").unwrap_or_else(|_| 
                if cfg!(target_os = "windows") { "//./pipe/docker_engine".into() } 
                else { "/var/run/docker.sock".into() }
            ),
        }
    }
}
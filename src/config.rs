use std::env;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub node_name: String,
    pub host: String,
    pub http_port: u16,
    pub grpc_port: u16,
    pub enable_sniffer: bool,
    pub docker_socket: String,
}

impl AppConfig {
    pub fn load() -> Self {
        Self {
            node_name: env::var("NODE_NAME").unwrap_or_else(|_| {
                hostname::get()
                    .map(|h| h.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| "unknown-node".into())
            }),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            http_port: env::var("HTTP_PORT").unwrap_or("11070".to_string()).parse().unwrap(),
            grpc_port: env::var("GRPC_PORT").unwrap_or("11071".to_string()).parse().unwrap(),
            enable_sniffer: env::var("ENABLE_NETWORK_SNIFFER").unwrap_or("false".to_string()) == "true",
            docker_socket: env::var("DOCKER_SOCKET").unwrap_or_else(|_| 
                if cfg!(target_os = "windows") { "//./pipe/docker_engine".into() } 
                else { "/var/run/docker.sock".into() }
            ),
        }
    }
}
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use tower_http::services::ServeDir;
use std::sync::Arc;
use tokio::sync::broadcast;
use crate::core::domain::LogRecord;
use tracing::{info, warn};

// UI Dosyalarının bulunduğu klasör
const UI_ASSETS_PATH: &str = "src/ui";

// Uygulama Durumu (Tüm handler'lar buna erişebilir)
#[derive(Clone)]
pub struct AppState {
    // Canlı yayın kanalı (Logları tarayıcılara basar)
    pub tx: broadcast::Sender<LogRecord>,
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        // Statik dosyaları (CSS/JS) sun
        .nest_service("/ui", ServeDir::new(UI_ASSETS_PATH))
        .with_state(state)
}

// Ana sayfa (index.html)
async fn index_handler() -> impl IntoResponse {
    // Development modunda dosyadan okumak daha iyidir (Hot reload için)
    // Production'da bu binary içine gömülebilir (include_str!)
    match std::fs::read_to_string(format!("{}/index.html", UI_ASSETS_PATH)) {
        Ok(html) => Html(html),
        Err(_) => Html("<h1>Error: UI not found. Check src/ui folder.</h1>".to_string()),
    }
}

// WebSocket Upgrade Handler
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

// Her bağlanan istemci için çalışan fonksiyon
async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    // Broadcast kanalına abone ol
    let mut rx = state.tx.subscribe();
    
    info!("🔌 Yeni bir UI istemcisi bağlandı.");

    while let Ok(log) = rx.recv().await {
        // Logu JSON'a çevir
        if let Ok(json_msg) = serde_json::to_string(&log) {
            // Tarayıcıya gönder
            if let Err(e) = socket.send(Message::Text(json_msg)).await {
                warn!("İstemci hatası (Koptu): {}", e);
                break;
            }
        }
    }
}
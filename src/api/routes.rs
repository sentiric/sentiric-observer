// src/api/routes.rs
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State, Path}, // Path eklendi
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use tower_http::services::ServeDir;
use std::sync::Arc;
use tokio::sync::broadcast;
use crate::core::domain::LogRecord;
use crate::adapters::sniffer::NetworkSniffer; // Sniffer import
use tracing::{info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::json;

// UI Dosyalarının bulunduğu klasör
const UI_ASSETS_PATH: &str = "src/ui";

// Uygulama Durumu
pub struct AppState {
    pub tx: broadcast::Sender<LogRecord>,
    pub sniffer_active: Arc<AtomicBool>, // Sniffer Durumu
    pub config: crate::config::AppConfig, // Config erişimi
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        // API - Sniffer Controls
        .route("/api/sniffer/status", get(get_sniffer_status))
        .route("/api/sniffer/enable", post(enable_sniffer))
        .route("/api/sniffer/disable", post(disable_sniffer))
        // Statik dosyalar
        .nest_service("/ui", ServeDir::new(UI_ASSETS_PATH))
        .with_state(state)
}

// --- HANDLERS ---

async fn get_sniffer_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let is_active = state.sniffer_active.load(Ordering::Relaxed);
    Json(json!({ "active": is_active }))
}

async fn enable_sniffer(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    if state.sniffer_active.load(Ordering::Relaxed) {
        return Json(json!({ "status": "already_active" }));
    }

    state.sniffer_active.store(true, Ordering::Relaxed);
    
    // Sniffer'ı arka planda başlat
    let sniffer_tx = state.tx.clone(); // Broadcast sender'ı sniffer için mpsc'ye çevirmek gerekir ama burada basitlik için log akışına direkt müdahale etmiyoruz. 
    // Mimaride küçük bir uyumsuzluk var: Sniffer MPSC channel bekliyor, AppState Broadcast channel tutuyor.
    // Çözüm: Main.rs'deki mpsc channel'ı AppState'e taşımak yerine, 
    // Sniffer'ı main.rs'de bir "Command Channel" ile yönetmek daha doğru olurdu ama
    // hızlı çözüm için burada yeni bir thread açıp global channel'a erişmeyeceğiz.
    // Sniffer'ın "Active" bayrağını kontrol etmesini sağlayacağız.
    
    // NOT: Gerçek başlatma mantığı NetworkSniffer içindeki döngüde "active" bayrağını kontrol ederek yapılacak.
    // Burada sadece bayrağı kaldırıyoruz.
    
    info!("🕷️ Sniffer Activated via UI");
    Json(json!({ "status": "activated" }))
}

async fn disable_sniffer(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    state.sniffer_active.store(false, Ordering::Relaxed);
    info!("zzz Sniffer Deactivated via UI");
    Json(json!({ "status": "deactivated" }))
}

async fn index_handler() -> impl IntoResponse {
    match std::fs::read_to_string(format!("{}/index.html", UI_ASSETS_PATH)) {
        Ok(html) => Html(html),
        Err(_) => Html("<h1>Error: UI not found. Check src/ui folder.</h1>".to_string()),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.tx.subscribe();
    while let Ok(log) = rx.recv().await {
        if let Ok(json_msg) = serde_json::to_string(&log) {
            if socket.send(Message::Text(json_msg)).await.is_err() {
                break;
            }
        }
    }
}
// src/api/routes.rs
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use tower_http::services::ServeDir;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::broadcast;
use crate::core::domain::LogRecord;
use serde_json::{json, Value};
// DÜZELTME: "warn" import'u artık `handle_socket` içinde kullanılıyor.
use tracing::{info, warn}; 

const UI_ASSETS_PATH: &str = "src/ui";

/// Uygulamanın Bellek Durumu (Global State)
pub struct AppState {
    pub tx: broadcast::Sender<LogRecord>,
    pub sniffer_active: Arc<AtomicBool>, // Sniffer Motorunun Anahtarı
    pub config: crate::config::AppConfig,
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        // Ana Sayfa (Mission Control UI)
        .route("/", get(index_handler))
        
        // Gerçek Zamanlı Veri Akışı
        .route("/ws", get(ws_handler))
        
        // REST API: Otonom Sniffer Kontrolü
        .route("/api/sniffer/status", get(get_sniffer_status))
        .route("/api/sniffer/enable", post(enable_sniffer))
        .route("/api/sniffer/disable", post(disable_sniffer))
        
        // Statik Varlıklar (CSS/JS)
        .nest_service("/ui", ServeDir::new(UI_ASSETS_PATH))
        .with_state(state)
}

// ==========================================
// REST HANDLERS
// ==========================================

async fn get_sniffer_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let is_active = state.sniffer_active.load(Ordering::Relaxed);
    Json(json!({ 
        "active": is_active,
        "interface": state.config.sniffer_interface,
        "filter": state.config.sniffer_filter
    }))
}

async fn enable_sniffer(State(state): State<Arc<AppState>>) -> Json<Value> {
    if state.sniffer_active.load(Ordering::Relaxed) {
        return Json(json!({ "status": "already_active", "message": "Sniffer is already running." }));
    }

    // Atomic değişkeni True yapıyoruz, arka plandaki C-Level pcap thread'i uyanacak.
    state.sniffer_active.store(true, Ordering::Relaxed);
    info!("🕷️ MISSION CONTROL: Network Sniffer ACTIVATED");
    
    Json(json!({ "status": "activated", "message": "Network interception started." }))
}

async fn disable_sniffer(State(state): State<Arc<AppState>>) -> Json<Value> {
    // Atomic değişkeni False yapıyoruz, thread CPU harcamayı kesip uykuya geçecek.
    state.sniffer_active.store(false, Ordering::Relaxed);
    info!("zzz MISSION CONTROL: Network Sniffer DEACTIVATED");
    
    Json(json!({ "status": "deactivated", "message": "Network interception stopped." }))
}

// ==========================================
// WEB & SOCKET HANDLERS
// ==========================================

async fn index_handler() -> impl IntoResponse {
    match std::fs::read_to_string(format!("{}/index.html", UI_ASSETS_PATH)) {
        Ok(html) => Html(html),
        Err(_) => Html("<h1>System Error: UI assets not found. Check src/ui folder.</h1>".to_string()),
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
    
    info!("🔌 MISSION CONTROL: New UI client connected to data stream.");

    while let Ok(log) = rx.recv().await {
        if let Ok(json_msg) = serde_json::to_string(&log) {
            if socket.send(Message::Text(json_msg)).await.is_err() {
                // DÜZELTME: 'warn' makrosu kullanılarak unused import engellendi.
                warn!("⚠️ MISSION CONTROL: UI Client disconnected unexpectedly.");
                break;
            }
        }
    }
}
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
use crate::model::OtelLogRecord;

const INDEX_HTML: &str = include_str!("../ui/index.html");

#[derive(Clone)]
pub struct AppState {
    pub tx: broadcast::Sender<OtelLogRecord>,
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index_handler))
        .route("/ws", get(ws_handler))
        // DÜZELTME: /ui/js/app.js isteği gelince src/ui/js/app.js'e bakacak
        .nest_service("/ui", ServeDir::new("src/ui"))
        .with_state(state)
}

async fn index_handler() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.tx.subscribe();
    while let Ok(log_record) = rx.recv().await {
        if let Ok(json_msg) = serde_json::to_string(&log_record) {
            if socket.send(Message::Text(json_msg)).await.is_err() { break; }
        }
    }
}
// src/ui/js/websocket.js
export class LogStream {
    constructor(url, onMessage, onStatusChange) {
        this.url = url;
        this.onMessage = onMessage;
        this.onStatusChange = onStatusChange;
        this.conn = null;
        this.reconnectAttempts = 0;
        this.maxDelay = 10000; // Max 10s bekleme
    }

    connect() {
        console.log(`📡 [v5.0] Connecting to Uplink: ${this.url}`);
        this.conn = new WebSocket(this.url);

        this.conn.onopen = () => {
            this.reconnectAttempts = 0;
            this.onStatusChange(true);
            console.log("✅ [v5.0] Uplink Secured");
        };

        this.conn.onclose = () => {
            this.onStatusChange(false);
            
            // Exponential Backoff (1s, 2s, 4s, 8s, 10s...)
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxDelay);
            this.reconnectAttempts++;
            
            console.log(`❌ Uplink Lost. Retrying in ${delay}ms...`);
            setTimeout(() => this.connect(), delay);
        };

        this.conn.onmessage = (e) => {
            try {
                this.onMessage(JSON.parse(e.data));
            } catch (err) {
                console.warn("⚠️ Corrupt Packet Dropped:", err);
            }
        };
    }
}
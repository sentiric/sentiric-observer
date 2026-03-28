// Dosya: src/ui/js/websocket.js (Tümü Değişecek)
export class LogStream {
    constructor(url, onMessage, onStatusChange) {
        this.url = url;
        this.onMessage = onMessage;
        this.onStatusChange = onStatusChange;
        this.conn = null;
        this.reconnectAttempts = 0;
        this.maxDelay = 10000;
    }

    connect() {
        console.log(`📡[v14.0] Connecting to Omniscient Uplink: ${this.url}`);
        this.conn = new WebSocket(this.url);

        this.conn.onopen = () => {
            this.reconnectAttempts = 0;
            this.onStatusChange(true);
            console.log("✅[v14.0] Uplink Secured (Micro-Batching Enabled)");
        };

        this.conn.onclose = () => {
            this.onStatusChange(false);
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxDelay);
            this.reconnectAttempts++;
            console.log(`❌ Uplink Lost. Retrying in ${delay}ms...`);
            setTimeout(() => this.connect(), delay);
        };

        this.conn.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                // Artık tek bir nesne değil, her 100ms'de bir Dizi (Array) gelir.
                if (Array.isArray(data)) {
                    this.onMessage(data); // Batched payload
                } else {
                    this.onMessage([data]); // Geriye dönük uyumluluk
                }
            } catch (err) {
                console.warn("⚠️ Corrupt Frame Dropped:", err);
            }
        };
    }
}
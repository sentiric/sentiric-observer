// Artık bu bir ES Module
export class LogStream {
    constructor(url, onMessage) {
        this.url = url;
        this.onMessage = onMessage;
        this.conn = null;
    }

    connect() {
        console.log("📡 Connecting to Uplink:", this.url);
        this.conn = new WebSocket(this.url);

        this.conn.onopen = () => {
            document.getElementById('ws-status').className = 'status-indicator online';
            console.log("✅ Uplink Secured");
        };

        this.conn.onclose = () => {
            document.getElementById('ws-status').className = 'status-indicator offline';
            console.log("❌ Uplink Lost. Retrying...");
            setTimeout(() => this.connect(), 3000);
        };

        this.conn.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                this.onMessage(data);
            } catch (err) {
                console.warn("Corrupt Packet:", err);
            }
        };
    }
}
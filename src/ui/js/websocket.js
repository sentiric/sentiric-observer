// Artık bu bir ES Module
export class LogStream {
    // [DÜZELTME]: onStatusChange callback'i eklendi
    constructor(url, onMessage, onStatusChange) {
        this.url = url;
        this.onMessage = onMessage;
        this.onStatusChange = onStatusChange; // Durum değişikliği fonksiyonu
        this.conn = null;
    }

    connect() {
        console.log("📡 Connecting to Uplink:", this.url);
        this.conn = new WebSocket(this.url);

        this.conn.onopen = () => {
            // [DÜZELTME]: Sadece UI elementini değil, callback'i çağır
            this.onStatusChange(true);
            console.log("✅ Uplink Secured");
        };

        this.conn.onclose = () => {
            // [DÜZELTME]: Sadece UI elementini değil, callback'i çağır
            this.onStatusChange(false);
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
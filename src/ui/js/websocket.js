const ws = {
    conn: null,
    connect() {
        console.log("📡 WebSocket Bağlanıyor: " + CONFIG.WS_URL);
        this.conn = new WebSocket(CONFIG.WS_URL);

        this.conn.onopen = () => {
            document.getElementById('ws-status').className = 'status-indicator online';
            console.log("✅ WebSocket Connected");
        };

        this.conn.onclose = () => {
            document.getElementById('ws-status').className = 'status-indicator offline';
            setTimeout(() => this.connect(), 3000); // Kopsa bile 3sn sonra tekrar dener
        };

        this.conn.onmessage = (e) => {
            try {
                const logData = JSON.parse(e.data);
                
                // SUTS v4.0 Verisini State'e Ekle
                state.logs.push(logData);
                
                // Kapasiteyi aşarsa baştan sil (Ring Buffer mantığı)
                if (state.logs.length > CONFIG.MAX_LOGS) {
                    state.logs.shift();
                }
                
                // UI Güncelle
                ui.updateHeader(logData);
                ui.render();
                
                if (state.autoScroll) ui.scrollToBottom();

                // Görselleştiriciye veri at (Şimdilik saniyede 1 pulse)
                if(window.visualizer) visualizer.ping();
                
            } catch (err) {
                console.error("📩 WS Parse Error:", err);
            }
        };
    }
};
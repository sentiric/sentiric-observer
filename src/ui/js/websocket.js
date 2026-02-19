const ws = {
    conn: null,
    connect() {
        if (typeof CONFIG === 'undefined') return;
        
        console.log("📡 WebSocket Bağlanıyor...");
        this.conn = new WebSocket(CONFIG.WS_URL);

        this.conn.onopen = () => {
            const status = document.getElementById('ws-status');
            if(status) status.className = 'status-indicator online';
            console.log("✅ Panopticon Connected");
        };

        this.conn.onclose = () => {
            const status = document.getElementById('ws-status');
            if(status) status.className = 'status-indicator offline';
            setTimeout(() => this.connect(), 2000);
        };

        this.conn.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                
                // Veriyi kaydet
                state.logs.push(data);
                if (state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
                
                // Arayüzü güncelle
                ui.updateStats(data);
                ui.render();
                
                // Scroll metodunu güvenli çağır
                if (typeof ui.scrollToBottom === 'function') {
                    ui.scrollToBottom();
                }
            } catch (err) {
                console.error("📩 Message Processing Error:", err);
            }
        };
    }
};
// Global State
const state = {
    logs: [],
    pps: 0, // Packets Per Second
    lastPpsCheck: Date.now(),
    autoScroll: true,
    filter: ''
};

// WebSocket Logic (Embedded for performance)
const ws = new WebSocket(CONFIG.WS_URL);

ws.onopen = () => {
    document.getElementById('ws-status').className = 'status-indicator online';
    console.log("✅ Uplink Established");
};

ws.onclose = () => {
    document.getElementById('ws-status').className = 'status-indicator offline';
    console.log("❌ Uplink Lost");
    setTimeout(() => window.location.reload(), 3000); // Auto-recover
};

ws.onmessage = (e) => {
    try {
        const log = JSON.parse(e.data);
        state.logs.push(log);
        state.pps++; // İstatistik için sayaç
        
        // Memory Protection (Ring Buffer)
        if (state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
        
        // UI Render (Throttled handled by loop)
    } catch (err) {}
};

// UI Controller
const ui = {
    wrapper: document.getElementById('console-wrapper'),
    content: document.getElementById('console-content'),
    ppsEl: document.getElementById('pps-val'),
    totalEl: document.getElementById('total-logs-val'),

    init() {
        // 60 FPS Render Loop
        requestAnimationFrame(this.loop.bind(this));
        
        // PPS Counter Loop (1 Second)
        setInterval(() => {
            this.ppsEl.innerText = state.pps;
            visualizer.pushData(state.pps); // Grafiğe veri at
            state.pps = 0; // Sıfırla
            this.totalEl.innerText = state.logs.length;
        }, 1000);
    },

    loop() {
        this.renderVirtual();
        if (state.autoScroll) this.scrollToBottom();
        requestAnimationFrame(this.loop.bind(this));
    },

    renderVirtual() {
        if (!this.wrapper || !this.content) return;

        const totalLogs = state.logs.length;
        const rowHeight = 24; // CSS ile eşleşmeli
        
        // Virtual Window Calculation
        const viewportHeight = this.wrapper.clientHeight;
        const scrollTop = this.wrapper.scrollTop;
        
        const startIndex = Math.floor(scrollTop / rowHeight);
        const visibleCount = Math.ceil(viewportHeight / rowHeight);
        
        // Render buffer (Above/Below)
        const buffer = 5;
        const start = Math.max(0, startIndex - buffer);
        const end = Math.min(totalLogs, startIndex + visibleCount + buffer);

        // Resize container to fit all logs (Fake scrollbar)
        this.content.style.height = `${totalLogs * rowHeight}px`;

        // Generate HTML
        let html = '';
        for (let i = start; i < end; i++) {
            const log = state.logs[i];
            const top = i * rowHeight;
            html += this.createRow(log, top);
        }
        this.content.innerHTML = html;
    },

    createRow(log, top) {
        // Smart Rendering Logic
        const time = log.ts.split('T')[1].split('.')[0]; // HH:MM:SS
        const svc = log.resource?.service_name || 'unknown';
        const msg = this.escapeHtml(log.message);
        
        // Determine Badge Style
        let badgeClass = `bg-${log.severity}`;
        let badgeText = log.severity;
        let rowClass = 'log-row';

        // SIP/Network Packet Logic
        if (log.attributes && log.attributes['sip.method']) {
            const method = log.attributes['sip.method'];
            badgeClass = `sip-${method}`; // sip-INVITE, sip-BYE
            badgeText = method;
            rowClass += ' row-packet';
        } else if (log.severity === 'ERROR' || log.severity === 'FATAL') {
            rowClass += ' row-error';
        }

        return `
            <div class="${rowClass}" style="position:absolute; top:${top}px; width:100%;">
                <span class="col-ts">${time}</span>
                <span class="badge ${badgeClass}">${badgeText}</span>
                <span class="col-svc" title="${svc}">${svc}</span>
                <span class="col-evt">${log.event}</span>
                <span class="col-msg" title="${msg}">${msg}</span>
            </div>
        `;
    },

    scrollToBottom() {
        if (this.wrapper) {
            // Sadece kullanıcı yukarıda değilse kaydır
            if(this.wrapper.scrollHeight - this.wrapper.scrollTop > this.wrapper.clientHeight + 100) return;
            this.wrapper.scrollTop = this.wrapper.scrollHeight;
        }
    },

    toggleAutoScroll() {
        state.autoScroll = !state.autoScroll;
        document.getElementById('btn-scroll').innerText = `AUTO-SCROLL [${state.autoScroll ? 'ON' : 'OFF'}]`;
        if (state.autoScroll) this.scrollToBottom();
    },

    clearLogs() {
        state.logs = [];
        this.renderVirtual();
    },

    escapeHtml(text) {
        if (!text) return "";
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
};

// Start
document.addEventListener('DOMContentLoaded', () => {
    visualizer.init();
    ui.init();
});
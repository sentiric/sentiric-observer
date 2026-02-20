import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],
    pps: 0,
    newLogs: false,
    autoScroll: true,
    isConnected: false,
};

const ui = {
    wrapper: document.getElementById('console-wrapper'),
    content: document.getElementById('console-content'),
    statusIndicator: document.getElementById('ws-status'),

    init() {
        // Kontrol butonları
        const controlsRight = document.querySelector('.controls-right');
        if(controlsRight) {
            // İndirme Butonu
            const exportBtn = document.createElement('button');
            exportBtn.innerText = "DOWNLOAD LOGS";
            exportBtn.className = "btn-control";
            exportBtn.onclick = () => this.exportLogs();
            controlsRight.appendChild(exportBtn);
        }
        
        const scrollBtn = document.getElementById('btn-scroll');
        if(scrollBtn) scrollBtn.onclick = () => this.toggleAutoScroll();

        // Render Loop
        requestAnimationFrame(() => this.loop());
        
        // Stats Interval (1 saniye)
        setInterval(() => {
            const ppsEl = document.getElementById('pps-val');
            const totalEl = document.getElementById('total-logs-val');
            
            if(ppsEl) ppsEl.innerText = state.pps;
            if(totalEl) totalEl.innerText = state.logs.length;
            
            // Grafiğe veri bas
            visualizer.pushData(state.pps); 
            
            // Sıfırla
            state.pps = 0;
        }, 1000);
    },

    loop() {
        // Sadece yeni veri varsa render et (CPU tasarrufu)
        if(state.newLogs) {
            this.renderVirtual();
            state.newLogs = false;
        }
        
        if (state.autoScroll && state.isConnected) this.scrollToBottom();
        requestAnimationFrame(() => this.loop());
    },

    renderVirtual() {
        if (!this.wrapper || !this.content) return;
        const totalLogs = state.logs.length;
        const rowHeight = 24; // CSS ile aynı olmalı
        const scrollTop = this.wrapper.scrollTop;
        const visibleCount = Math.ceil(this.wrapper.clientHeight / rowHeight);
        
        // Görünür alanın biraz üstünü ve altını render et (Buffer)
        const startIndex = Math.floor(scrollTop / rowHeight);
        const start = Math.max(0, startIndex - 5);
        const end = Math.min(totalLogs, startIndex + visibleCount + 5);

        // İçerik alanının toplam yüksekliğini ayarla ki scrollbar doğru çalışsın
        this.content.style.height = `${totalLogs * rowHeight}px`;
        
        let html = '';
        for (let i = start; i < end; i++) {
            html += this.createRow(state.logs[i], i * rowHeight);
        }
        this.content.innerHTML = html;
    },

    createRow(log, top) {
        const time = log.ts.split('T')[1].split('.')[0]; // Sadece saati al
        const severity = log.severity || 'INFO';
        
        // SIP/RTP Methodlarına göre renk ata
        let badgeClass = `bg-${severity}`;
        let method = severity;
        
        // Attributes kontrolü - Artık akıllı
        let details = "";
        
        if (log.attributes) {
            if (log.attributes['sip.method']) {
                method = log.attributes['sip.method'];
                badgeClass = `sip-${method}`;
                const cid = log.attributes['sip.call_id'] || '';
                if(cid) details += `<span style="opacity:0.5; font-size:9px; margin-left:5px;">CID:${cid.slice(-4)}</span>`;
            } else if (log.attributes['rtp.payload_type']) {
                method = "RTP";
                badgeClass = "bg-INFO";
                details += `<span style="color:#00ffa3; font-size:9px; margin-left:5px;">PT:${log.attributes['rtp.payload_type']}</span>`;
            }
        }

        const eventColor = log.event.includes('PACKET') ? '#00ffa3' : '#79c0ff';
        
        // ================== KRİTİK UI DÜZELTMESİ ==================
        const serviceName = log.resource ? (log.resource['service.name'] || 'sys') : 'sys';
        // =========================================================

        return `<div class="log-row" style="position:absolute; top:${top}px; width:100%;">
            <span class="col-ts">${time}</span>
            <span class="badge ${badgeClass}">${method}</span>
            <span class="col-svc" title="${serviceName}">
                ${serviceName}
            </span>
            <span class="col-evt" style="color:${eventColor}" title="${log.event}">${log.event}</span>
            <span class="col-msg" title="${this.escapeHtml(log.message)}">
                ${this.escapeHtml(log.message)} ${details}
            </span>
        </div>`;
    },

    escapeHtml(text) {
        if (!text) return "";
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },

    scrollToBottom() {
        if (this.wrapper) this.wrapper.scrollTop = this.wrapper.scrollHeight;
    },

    toggleAutoScroll() {
        state.autoScroll = !state.autoScroll;
        const btn = document.getElementById('btn-scroll');
        if(btn) btn.innerText = `AUTO-SCROLL [${state.autoScroll ? 'ON' : 'OFF'}]`;
    },

    exportLogs() {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.logs, null, 2));
        const node = document.createElement('a');
        node.setAttribute("href", dataStr);
        node.setAttribute("download", `sentiric_logs_${new Date().toISOString()}.json`);
        document.body.appendChild(node);
        node.click();
        node.remove();
    },

    setConnectionStatus(connected) {
        state.isConnected = connected;
        const el = document.getElementById('ws-status');
        if(el) {
            el.className = connected ? 'status-indicator online' : 'status-indicator offline';
        }
    }
};

// WebSocket logic
const stream = new LogStream(CONFIG.WS_URL, 
    // On Message
    (log) => {
        state.logs.push(log);
        state.pps++;
        state.newLogs = true;
        // Memory Protection: UI tarafında da 10k logdan fazlasını tutma
        if (state.logs.length > CONFIG.MAX_LOGS) {
            state.logs.shift(); // En eskiyi at
        }
    },
    // On Status Change
    (status) => ui.setConnectionStatus(status)
);

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init(); 
    ui.init();
    stream.connect();
});
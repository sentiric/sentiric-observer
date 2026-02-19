import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js'; // <--- IMPORT EKLENDİ

const state = {
    logs: [],
    pps: 0,
    newLogs: false,
    autoScroll: true,
};

const ui = {
    wrapper: document.getElementById('console-wrapper'),
    content: document.getElementById('console-content'),

    init() {
        // ... (Buton tanımları aynı) ...
        const exportBtn = document.createElement('button');
        exportBtn.innerText = "DOWNLOAD JSON";
        exportBtn.style.cssText = "background:none; border:1px solid #30363d; color:#58a6ff; border-radius:3px; padding:2px 8px; cursor:pointer; margin-left:10px;";
        exportBtn.onclick = () => this.exportLogs();
        const controlsRight = document.querySelector('.controls-right');
        if(controlsRight) controlsRight.appendChild(exportBtn);
        
        const scrollBtn = document.getElementById('btn-scroll');
        if(scrollBtn) scrollBtn.onclick = () => this.toggleAutoScroll();

        requestAnimationFrame(() => this.loop());
        
        setInterval(() => {
            const ppsEl = document.getElementById('pps-val');
            const totalEl = document.getElementById('total-logs-val');
            
            if(ppsEl) ppsEl.innerText = state.pps;
            if(totalEl) totalEl.innerText = state.logs.length;
            
            // window.visualizer yerine direkt import ettiğimiz nesneyi kullanıyoruz
            visualizer.pushData(state.pps); 
            
            state.pps = 0;
        }, 1000);
    },

    // (loop, renderVirtual, createRow, exportLogs fonksiyonları) ...

    loop() {
        if(state.newLogs) {
            this.renderVirtual();
            state.newLogs = false;
        }
        if (state.autoScroll) this.scrollToBottom();
        requestAnimationFrame(() => this.loop());
    },

    renderVirtual() {
        if (!this.wrapper || !this.content) return;
        const totalLogs = state.logs.length;
        const rowHeight = 24;
        const scrollTop = this.wrapper.scrollTop;
        const visibleCount = Math.ceil(this.wrapper.clientHeight / rowHeight);
        const startIndex = Math.floor(scrollTop / rowHeight);
        const start = Math.max(0, startIndex - 5);
        const end = Math.min(totalLogs, startIndex + visibleCount + 5);

        this.content.style.height = `${totalLogs * rowHeight}px`;
        
        let html = '';
        for (let i = start; i < end; i++) {
            html += this.createRow(state.logs[i], i * rowHeight);
        }
        this.content.innerHTML = html;
    },

    createRow(log, top) {
        const time = log.ts.split('T')[1].split('.')[0];
        const severity = log.severity || 'INFO';
        let badgeClass = `bg-${severity}`;
        if (log.attributes && log.attributes['sip.method']) {
            badgeClass = `sip-${log.attributes['sip.method']}`;
        }
        return `<div class="log-row" style="position:absolute; top:${top}px; width:100%;">
            <span class="col-ts">${time}</span>
            <span class="badge ${badgeClass}">${log.attributes?.['sip.method'] || severity}</span>
            <span class="col-svc">${log.resource?.service_name || 'sys'}</span>
            <span class="col-evt">${log.event}</span>
            <span class="col-msg">${this.escapeHtml(log.message)}</span>
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
        node.setAttribute("download", `sentiric_logs_${Date.now()}.json`);
        document.body.appendChild(node);
        node.click();
        node.remove();
    }
};

// Main Execution
const stream = new LogStream(CONFIG.WS_URL, (log) => {
    state.logs.push(log);
    state.pps++;
    state.newLogs = true;
    if (state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
});

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init(); // Artık import edildiği için çalışacak
    ui.init();
    stream.connect();
});
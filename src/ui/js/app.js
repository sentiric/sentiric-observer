import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],
    filteredLogs: [], // Filtrelenmiş ve işlenmiş görünüm
    pps: 0,
    newLogs: false,
    autoScroll: true,
    isConnected: false,
    filters: {
        service: '',
        trace: '',
        level: 'ALL',
        msg: '',
        dedup: true
    }
};

const ui = {
    wrapper: document.getElementById('console-wrapper'),
    content: document.getElementById('console-content'),
    
    // Filter Elements
    inpService: document.getElementById('filter-svc'),
    inpTrace: document.getElementById('filter-trace'),
    selLevel: document.getElementById('filter-level'),
    inpMsg: document.getElementById('filter-msg'),
    chkDedup: document.getElementById('chk-dedup'),

    init() {
        // Event Listeners for Filters
        const applyFilters = () => { 
            this.processLogs(); 
            this.renderVirtual();
        };
        
        if(this.inpService) this.inpService.addEventListener('input', applyFilters);
        if(this.inpTrace) this.inpTrace.addEventListener('input', applyFilters);
        if(this.selLevel) this.selLevel.addEventListener('change', applyFilters);
        if(this.inpMsg) this.inpMsg.addEventListener('input', applyFilters);
        if(this.chkDedup) this.chkDedup.addEventListener('change', applyFilters);

        const scrollBtn = document.getElementById('btn-scroll');
        if(scrollBtn) scrollBtn.onclick = () => this.toggleAutoScroll();

        // Render Loop
        requestAnimationFrame(() => this.loop());
        
        // Stats Interval (1 sn)
        setInterval(() => {
            const ppsEl = document.getElementById('pps-val');
            const totalEl = document.getElementById('total-logs-val');
            if(ppsEl) ppsEl.innerText = state.pps;
            if(totalEl) totalEl.innerText = state.logs.length;
            visualizer.pushData(state.pps); 
            state.pps = 0;
        }, 1000);
    },

    loop() {
        if(state.newLogs) {
            this.processLogs(); // Filtrele ve Dedup Yap
            this.renderVirtual();
            state.newLogs = false;
        }
        
        if (state.autoScroll && state.isConnected) this.scrollToBottom();
        requestAnimationFrame(() => this.loop());
    },

    // Filtreleme ve Gruplama Mantığı (The Engine)
    processLogs() {
        state.filters.service = this.inpService.value.toLowerCase();
        state.filters.trace = this.inpTrace.value.toLowerCase();
        state.filters.level = this.selLevel.value;
        state.filters.msg = this.inpMsg.value.toLowerCase();
        state.filters.dedup = this.chkDedup.checked;

        // 1. Filtering
        let temp = state.logs.filter(log => {
            // Service Filter
            if (state.filters.service && !log.resource['service.name'].toLowerCase().includes(state.filters.service)) return false;
            
            // Trace/Call ID Filter (Hem trace_id hem attributes içinde ara)
            if (state.filters.trace) {
                const tid = (log.trace_id || '').toLowerCase();
                const cid = (log.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(state.filters.trace) && !cid.includes(state.filters.trace)) return false;
            }

            // Message Filter
            if (state.filters.msg && !log.message.toLowerCase().includes(state.filters.msg)) return false;

            // Severity Filter
            if (state.filters.level !== 'ALL') {
                const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
                const logIdx = levels.indexOf(log.severity);
                const filterIdx = levels.indexOf(state.filters.level);
                if (logIdx < filterIdx) return false;
            }
            return true;
        });

        // 2. Deduplication (Visual Grouping)
        // Arka arkaya gelen aynı mesajları tek satıra indir
        if (state.filters.dedup) {
            const deduped = [];
            let lastLog = null;
            
            for (const log of temp) {
                if (lastLog && 
                    lastLog.message === log.message && 
                    lastLog.resource['service.name'] === log.resource['service.name'] &&
                    lastLog.severity === log.severity) {
                    
                    lastLog._count = (lastLog._count || 1) + 1;
                    // Zaman damgasını güncellemiyoruz ki ilki görülsün, ama isterseniz sonuncusu da olabilir.
                } else {
                    // Yeni bir kopya oluştur ki orijinal array bozulmasın
                    const newEntry = { ...log, _count: 1 };
                    deduped.push(newEntry);
                    lastLog = newEntry;
                }
            }
            state.filteredLogs = deduped;
        } else {
            state.filteredLogs = temp;
        }
    },

    renderVirtual() {
        if (!this.wrapper || !this.content) return;
        const data = state.filteredLogs;
        const totalLogs = data.length;
        const rowHeight = 24; 
        const scrollTop = this.wrapper.scrollTop;
        const visibleCount = Math.ceil(this.wrapper.clientHeight / rowHeight);
        
        const startIndex = Math.floor(scrollTop / rowHeight);
        const start = Math.max(0, startIndex - 5);
        const end = Math.min(totalLogs, startIndex + visibleCount + 5);

        this.content.style.height = `${totalLogs * rowHeight}px`;
        
        let html = '';
        for (let i = start; i < end; i++) {
            html += this.createRow(data[i], i * rowHeight);
        }
        this.content.innerHTML = html;
    },

    createRow(log, top) {
        const time = log.ts.split('T')[1].split('.')[0];
        const severity = log.severity || 'INFO';
        
        let badgeClass = `bg-${severity}`;
        let method = severity;
        let details = "";
        
        // Attributes Logic
        if (log.attributes) {
            if (log.attributes['sip.method']) {
                method = log.attributes['sip.method'];
                badgeClass = `sip-${method}`;
            } else if (log.attributes['rtp.payload_type']) {
                method = "RTP";
                badgeClass = "bg-INFO";
            }
            
            // Call ID Badge
            const cid = log.trace_id || log.attributes['sip.call_id'];
            if(cid) details += `<span style="opacity:0.5; font-size:9px; margin-left:5px; border:1px solid #30363d; padding:0 3px; border-radius:2px;">${cid.slice(-4)}</span>`;
            
            // Port Details
            if (log.attributes['rtp.port']) {
                 details += `<span style="color:#79c0ff; font-size:9px; margin-left:3px;">:${log.attributes['rtp.port']}</span>`;
            }
        }

        const eventColor = log.event.includes('PACKET') ? '#00ffa3' : '#79c0ff';
        const serviceName = log.resource ? (log.resource['service.name'] || 'sys') : 'sys';

        // Deduplication Badge
        let countBadge = "";
        if (log._count && log._count > 1) {
            countBadge = `<span class="dup-badge">x${log._count}</span>`;
        }
        
        // Error Row Highlight
        const rowClass = (severity === 'ERROR' || severity === 'FATAL') ? 'log-row row-error' : 'log-row';

        return `<div class="${rowClass}" style="position:absolute; top:${top}px; width:100%;">
            <span class="col-ts">${time}</span>
            <span class="badge ${badgeClass}">${method}</span>
            <span class="col-svc" title="${serviceName}">${serviceName}</span>
            <span class="col-evt" style="color:${eventColor}" title="${log.event}">${log.event}</span>
            <span class="col-msg" title="${this.escapeHtml(log.message)}">
                ${this.escapeHtml(log.message)} ${details} ${countBadge}
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

    setConnectionStatus(connected) {
        state.isConnected = connected;
        const el = document.getElementById('ws-status');
        if(el) el.className = connected ? 'status-indicator online' : 'status-indicator offline';
    }
};

const stream = new LogStream(CONFIG.WS_URL, 
    (log) => {
        state.logs.push(log);
        state.pps++;
        state.newLogs = true;
        if (state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    (status) => ui.setConnectionStatus(status)
);

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init(); 
    ui.init();
    stream.connect();
});
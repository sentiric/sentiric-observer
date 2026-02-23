import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],
    filteredLogs: [],
    pps: 0,
    isPaused: false,
    autoScroll: true,
    selectedLog: null,
    lockedTraceId: null, // TRACE LOCK
    filters: { trace: '', svc: '', msg: '', level: 'ALL' }
};

const ui = {
    // DOM Cache
    el: {},

    init() {
        // Güvenli Element Seçimi
        const get = (id) => document.getElementById(id);
        
        this.el = {
            pps: get('pps-val'),
            total: get('total-logs-val'),
            buffer: get('buffer-usage'),
            status: get('ws-status'),
            scroller: get('log-scroller'),
            content: get('log-content'),
            inspector: get('inspector'),
            inspBody: get('insp-body'),
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status-text'),
            
            // Inputs
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLevel: get('filter-level'),
            
            // Buttons
            btnPause: get('btn-pause'),
            btnClear: get('btn-clear'),
            btnCloseInsp: get('btn-close-insp'),
            btnLockTrace: get('btn-lock-trace'),
            
            // Media
            mediaModule: get('rtp-player'),
            codecBadge: get('rtp-codec-badge')
        };

        this.bindEvents();
        this.setupSniffer();
        this.startLoop();
        
        // 1 saniyelik stats
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = state.logs.length;
            if(this.el.buffer) this.el.buffer.innerText = Math.round((state.logs.length / 10000) * 100) + "%";
            visualizer.pushData(state.pps);
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filterLogs(); this.render(); };
        
        this.el.inpTrace.oninput = (e) => {
            // Eğer elle silinirse kilidi aç
            if(e.target.value === '') state.lockedTraceId = null;
            state.filters.trace = e.target.value.toLowerCase(); 
            apply();
        };
        this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        this.el.selLevel.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        this.el.btnPause.onclick = () => {
            state.isPaused = !state.isPaused;
            state.autoScroll = !state.isPaused;
            this.el.btnPause.innerText = state.isPaused ? "▶ RESUME" : "⏸ PAUSE";
            this.el.btnPause.style.color = state.isPaused ? "#eab308" : "#fff";
        };

        this.el.btnClear.onclick = () => { state.logs = []; state.filteredLogs = []; this.render(); };
        
        this.el.btnCloseInsp.onclick = () => {
            this.el.inspector.classList.remove('open');
            state.selectedLog = null;
            this.render();
        };

        // TRACE LOCK LOGIC
        this.el.btnLockTrace.onclick = () => {
            if (!state.selectedLog) return;
            
            const tid = state.selectedLog.trace_id || state.selectedLog.attributes['sip.call_id'];
            if (!tid) {
                alert("No Trace ID found in this packet.");
                return;
            }

            // Toggle Lock
            if (state.lockedTraceId === tid) {
                state.lockedTraceId = null;
                this.el.inpTrace.value = "";
                this.el.btnLockTrace.innerText = "🔒 LOCK TRACE";
                this.el.btnLockTrace.classList.remove('active');
            } else {
                state.lockedTraceId = tid;
                this.el.inpTrace.value = tid;
                this.el.btnLockTrace.innerText = "🔓 UNLOCK TRACE";
                this.el.btnLockTrace.classList.add('active');
            }
            
            // Trigger Filter
            this.el.inpTrace.dispatchEvent(new Event('input'));
        };

        // Row Click Delegation
        this.el.content.addEventListener('click', (e) => {
            const row = e.target.closest('.row');
            if (row) this.inspect(row.dataset.idx);
        });
    },

    setupSniffer() {
        if(!this.el.snifferToggle) return;
        
        // Initial Status
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            this.el.snifferToggle.checked = d.active;
            this.updateSnifferUI(d.active);
        }).catch(() => {});

        this.el.snifferToggle.addEventListener('change', (e) => {
            const act = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => this.updateSnifferUI(e.target.checked));
        });
    },

    updateSnifferUI(active) {
        this.el.snifferStatus.innerText = active ? "RECORDING" : "STANDBY";
        this.el.snifferStatus.className = active ? "status-text recording" : "status-text standby";
    },

    filterLogs() {
        const f = state.filters;
        state.filteredLogs = state.logs.filter(l => {
            if (state.lockedTraceId) {
                // Eğer kilitliyse SADECE o trace'i göster (Hızlı yol)
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                const lock = state.lockedTraceId.toLowerCase();
                if (!tid.includes(lock) && !cid.includes(lock)) return false;
            } else {
                // Normal arama
                if (f.trace) {
                     const tid = (l.trace_id || '').toLowerCase();
                     const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                     if (!tid.includes(f.trace) && !cid.includes(f.trace)) return false;
                }
            }

            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            if (f.svc && !l.resource['service.name'].toLowerCase().includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
            return true;
        });
    },

    startLoop() {
        const loop = () => {
            if (state.hasNew && !state.isPaused) {
                this.filterLogs();
                this.render();
                state.hasNew = false;
            }
            if (state.autoScroll && !state.isPaused && !state.selectedLog) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        const data = state.filteredLogs.slice(-200);
        this.el.content.innerHTML = data.map((log, idx) => {
            const time = log.ts.split('T')[1].slice(0, 12);
            const svc = log.resource['service.name'];
            const sel = state.selectedLog === log ? 'selected' : '';
            
            // Renkler
            let colSev = '#a1a1aa';
            if (log.severity === 'ERROR') colSev = '#f87171';
            else if (log.severity === 'WARN') colSev = '#facc15';
            else if (log.severity === 'INFO') colSev = '#60a5fa';

            // Özel Tagler
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            return `
                <div class="row ${sel}" data-idx="${log._idx}">
                    <span style="color:#555">${time}</span>
                    <span style="color:${colSev}; font-weight:bold;">${log.severity}</span>
                    <span style="color:#c084fc">${svc}</span>
                    <span style="color:#fff">${log.event}</span>
                    <span style="overflow:hidden; text-overflow:ellipsis;">${tags} ${this.esc(log.message)}</span>
                </div>
            `;
        }).join('');
    },

    inspect(idx) {
        // Orijinal log dizisinden bul (Filtrelenmişten değil, çünkü index global)
        // NOT: Loglara _idx eklemek için websocket handler'ı güncellemeliyiz, 
        // ya da burada basitçe referans buluyoruz.
        const log = state.logs.find(l => l._idx == idx);
        if (!log) return;

        state.selectedLog = log;
        state.isPaused = true;
        this.el.btnPause.innerText = "▶ RESUME";
        
        this.el.inspector.classList.add('open');
        this.render();

        // 1. Media Player Check
        if (log.smart_tags && (log.smart_tags.includes('RTP') || log.smart_tags.includes('DTMF'))) {
            this.el.mediaModule.style.display = 'block';
            let pt = log.attributes['rtp.payload_type'];
            this.el.codecBadge.innerText = pt === 101 ? "DTMF" : (pt === 0 ? "PCMU" : (pt === 8 ? "PCMA" : "G.729"));
        } else {
            this.el.mediaModule.style.display = 'none';
        }

        // 2. JSON View
        let attrs = {...log.attributes};
        let payloadHtml = "";
        if (attrs.payload) {
            payloadHtml = `<div style="color:#58a6ff; margin-bottom:5px;">RAW PAYLOAD:</div><pre style="border-left:2px solid #58a6ff; padding-left:10px; margin-bottom:20px;">${this.esc(attrs.payload)}</pre>`;
            delete attrs.payload;
        }

        this.el.inspBody.innerHTML = `
            <div style="margin-bottom:20px;">
                <div style="font-size:16px; font-weight:800; color:#fff;">${log.event}</div>
                <div style="color:#888; font-size:10px;">${log.ts} • ${log.resource['service.name']}</div>
                <div style="color:#888; font-size:10px;">TRACE: ${log.trace_id || 'N/A'}</div>
            </div>
            ${payloadHtml}
            <pre>${this.syntax(attrs)}</pre>
        `;
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; },
    syntax(json) {
        return JSON.stringify(json, null, 2).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
            let cls = '#a5d6ff';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) cls = '#79c0ff'; // Key
                else cls = '#a5d6ff'; // String
            } else cls = '#d2a8ff'; // Number/Bool
            return `<span style="color:${cls}">${match}</span>`;
        });
    }
};

// WebSocket
let logCounter = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = logCounter++; // Unique ID for UI Selection
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        if (state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(!el) return;
        el.innerText = status ? "● ONLINE" : "● OFFLINE";
        el.className = status ? "status-pill connected" : "status-pill disconnected";
    }
).connect();

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init();
    ui.init();
});
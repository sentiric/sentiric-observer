import { LogStream } from './websocket.js';

const state = {
    logs: [],
    filtered: [],
    pps: 0,
    paused: false,
    selectedLog: null,
    lockedTrace: null,
    filters: { trace: '', svc: '', msg: '', level: 'ALL' }
};

const ui = {
    el: {},

    init() {
        const get = (id) => document.getElementById(id);
        
        // SAFE DOM BINDING
        this.el = {
            scroller: get('log-scroller'),
            content: get('log-content'),
            detailPane: get('detail-pane'),
            
            // Stats
            pps: get('pps-val'),
            buffer: get('buffer-usage'),
            total: get('total-logs-val'),
            statusText: get('ws-text'),
            statusDot: get('ws-status'),
            
            // Sniffer
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status-text'),
            
            // Inputs
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLvl: get('filter-level'),
            
            // Buttons
            btnPause: get('btn-pause'),
            btnClear: get('btn-clear'),
            btnExpRaw: get('btn-export-raw'),
            btnExpAi: get('btn-export-ai'),
            btnCloseDetail: get('btn-close-detail'),
            
            // Detail View
            detTs: get('det-ts'),
            detSvc: get('det-svc'),
            detTrace: get('det-trace'),
            jsonView: get('json-viewer'),
            rawView: get('raw-payload'),
            tabs: document.querySelectorAll('.tab'),
            tabContents: document.querySelectorAll('.tab-content')
        };

        this.bindEvents();
        this.checkSniffer();
        this.loop();
        
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = `${state.logs.length}`;
            if(this.el.buffer) this.el.buffer.innerText = Math.round((state.logs.length / 10000) * 100) + "%";
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };

        if(this.el.inpTrace) this.el.inpTrace.oninput = (e) => {
            state.filters.trace = e.target.value.trim().toLowerCase();
            if(!state.filters.trace) state.lockedTrace = null;
            apply();
        };
        if(this.el.inpSvc) this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        if(this.el.inpMsg) this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        if(this.el.selLvl) this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        if(this.el.btnPause) this.el.btnPause.onclick = (e) => {
            state.paused = !state.paused;
            e.target.innerText = state.paused ? "RESUME" : "PAUSE";
        };

        if(this.el.btnClear) this.el.btnClear.onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        if(this.el.btnCloseDetail) this.el.btnCloseDetail.onclick = () => this.closeDetail();

        // EXPORT LOGIC
        if(this.el.btnExpRaw) this.el.btnExpRaw.onclick = () => this.exportLogs('raw');
        if(this.el.btnExpAi) this.el.btnExpAi.onclick = () => this.exportLogs('ai');

        if(this.el.content) this.el.content.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if(row) this.inspect(parseInt(row.dataset.idx));
        };

        // Tab Switching
        this.el.tabs.forEach(btn => {
            btn.onclick = () => {
                this.el.tabs.forEach(b => b.classList.remove('active'));
                this.el.tabContents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab).classList.add('active');
            };
        });

        // Trace Link Click
        if(this.el.detTrace) this.el.detTrace.onclick = () => {
            const tid = this.el.detTrace.innerText;
            if(tid && tid !== '-') {
                state.lockedTrace = tid;
                this.el.inpTrace.value = tid;
                this.el.inpTrace.dispatchEvent(new Event('input'));
            }
        };

        if(this.el.snifferToggle) {
            this.el.snifferToggle.onchange = (e) => {
                const act = e.target.checked ? 'enable' : 'disable';
                fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => this.updateSniffer(e.target.checked));
            };
        }
    },

    checkSniffer() {
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            if(this.el.snifferToggle) this.el.snifferToggle.checked = d.active;
            this.updateSniffer(d.active);
        }).catch(() => {});
    },

    updateSniffer(active) {
        if(!this.el.snifferStatus) return;
        this.el.snifferStatus.innerText = active ? "RECORDING" : "STANDBY";
        this.el.snifferStatus.style.color = active ? "#f14c4c" : "#858585";
    },

    // ----------------------------------------------------
    // DUAL EXPORT ENGINE
    // ----------------------------------------------------
    exportLogs(type) {
        const data = state.filtered;
        if(data.length === 0) return alert("No logs to export.");

        let content = "";
        let filename = "";

        if (type === 'raw') {
            // Tam döküm (Adli Kanıt)
            content = JSON.stringify(data, null, 2);
            filename = `sentiric_forensic_${Date.now()}.json`;
        } else {
            // AI Context (Sohbet Özeti)
            content = "SYSTEM EVENT LOG TIMELINE:\n";
            data.forEach(l => {
                content += `[${l.ts}] [${l.severity}] [${l.resource['service.name']}] ${l.event}: ${l.message}`;
                if (l.trace_id) content += ` (Trace: ${l.trace_id})`;
                content += "\n";
                // Eğer hata varsa detayı ekle
                if (l.severity === 'ERROR' || l.severity === 'WARN') {
                     content += `   Details: ${JSON.stringify(l.attributes)}\n`;
                }
            });
            filename = `sentiric_ai_context_${Date.now()}.txt`;
        }

        const blob = new Blob([content], {type: type === 'raw' ? 'application/json' : 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
    },

    filter() {
        const f = state.filters;
        state.filtered = state.logs.filter(l => {
            if (f.level === 'WARN' && (l.severity === 'INFO' || l.severity === 'DEBUG')) return false;
            if (f.level === 'ERROR' && l.severity !== 'ERROR') return false;
            
            if (f.svc && !l.resource['service.name'].includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;

            const traceTarget = state.lockedTrace || f.trace;
            if (traceTarget) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes && l.attributes['sip.call_id'] ? l.attributes['sip.call_id'] : '').toLowerCase();
                if (!tid.includes(traceTarget) && !cid.includes(traceTarget)) return false;
            }
            return true;
        });
    },

    loop() {
        if (state.hasNew && !state.paused) {
            this.filter();
            this.render();
            state.hasNew = false;
        }
        if (!state.paused && !state.selectedLog && this.el.scroller) {
            this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
        }
        requestAnimationFrame(() => this.loop());
    },

    render() {
        if (!this.el.content) return;
        // Performans için sadece son 500 satırı çiz
        const slice = state.filtered.slice(-500);
        
        this.el.content.innerHTML = slice.map(log => {
            const time = log.ts.split('T')[1].replace('Z','');
            const svc = log.resource['service.name'];
            const sel = state.selectedLog === log ? 'selected' : '';
            const sevClass = `lvl-${log.severity}`;
            const evtColor = log.event.includes('SIP') ? '#569cd6' : (log.event.includes('RTP') ? '#c586c0' : '#4ec9b0');
            
            return `
                <div class="log-row ${sel}" data-idx="${log._idx}">
                    <span style="color:#666">${time}</span>
                    <span class="${sevClass}">${log.severity}</span>
                    <span style="color:#dcdcaa">${svc}</span>
                    <span style="color:${evtColor}">${log.event}</span>
                    <span style="color:#9cdcfe; overflow:hidden; text-overflow:ellipsis;">${this.esc(log.message)}</span>
                </div>
            `;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if (!log) return;
        state.selectedLog = log;
        state.paused = true; // Auto-pause on inspect

        this.el.detailPane.classList.add('open');
        this.render(); // Highlight row

        // Meta Info
        if(this.el.detTs) this.el.detTs.innerText = log.ts;
        if(this.el.detSvc) this.el.detSvc.innerText = log.resource['service.name'];
        if(this.el.detTrace) {
            const tid = log.trace_id || log.attributes['sip.call_id'] || '-';
            this.el.detTrace.innerText = tid;
            this.el.detTrace.style.cursor = tid !== '-' ? 'pointer' : 'default';
        }

        // Formatted JSON
        if(this.el.jsonView) this.el.jsonView.innerHTML = this.syntaxHighlight(log.attributes);

        // Raw Payload Tab
        const rawPayload = log.attributes['payload'] || log.attributes['packet.summary'] || "No raw payload captured.";
        if(this.el.rawView) this.el.rawView.innerText = rawPayload;
    },

    closeDetail() {
        this.el.detailPane.classList.remove('open');
        state.selectedLog = null;
        state.paused = false;
        this.render();
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; },
    
    syntaxHighlight(json) {
        if (!json) return "{}";
        const str = JSON.stringify(json, undefined, 2);
        return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = '#9cdcfe';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    return `<span style="color:#dcdcaa">${match.replace(/:/,'')}</span>:`;
                } else {
                    return `<span style="color:#ce9178">${match}</span>`;
                }
            } else if (/true|false/.test(match)) {
                return `<span style="color:#569cd6">${match}</span>`;
            } else if (/null/.test(match)) {
                return `<span style="color:#569cd6">${match}</span>`;
            }
            return `<span style="color:#b5cea8">${match}</span>`;
        });
    }
};

// Start
let count = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = count++;
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        if(state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    (status) => {
        const txt = document.getElementById('ws-text');
        const dot = document.getElementById('ws-status');
        if(txt && dot) {
            txt.innerText = status ? "CONNECTED" : "DISCONNECTED";
            dot.className = `status-dot ${status ? 'online' : 'offline'}`;
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
// src/ui/js/app.js
import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],
    filteredLogs: [],
    pps: 0,
    isPaused: false,
    selectedLog: null,
    autoScroll: true,
    filters: { trace: '', svc: '', msg: '', level: 'ALL' }
};

const ui = {
    el: {
        wrapper: document.getElementById('console-wrapper'),
        content: document.getElementById('console-content'),
        inspector: document.getElementById('inspector-panel'),
        detail: document.getElementById('inspector-detail'),
        mediaModule: document.getElementById('media-player-module'),
        audioCodec: document.getElementById('audio-codec-info'),
        audioPt: document.getElementById('audio-pt-info'),
        
        // Sniffer
        snifferToggle: document.getElementById('sniffer-toggle'),
        snifferStatus: document.getElementById('sniffer-status'),
        snifferWidget: document.querySelector('.sniffer-widget'),
        
        // Inputs
        inpTrace: document.getElementById('filter-trace'),
        inpSvc: document.getElementById('filter-svc'),
        inpMsg: document.getElementById('filter-msg'),
        selLevel: document.getElementById('filter-level'),
    },

    init() {
        this.setupControls();
        this.setupFilters();
        this.setupSniffer();
        this.startLoop();

        // Stats Loop
        setInterval(() => {
            document.getElementById('pps-val').innerText = state.pps;
            document.getElementById('total-logs-val').innerText = state.logs.length;
            document.getElementById('buffer-usage').innerText = Math.round((state.logs.length / CONFIG.MAX_LOGS) * 100) + "%";
            visualizer.pushData(state.pps);
            state.pps = 0;
        }, 1000);
    },

    setupSniffer() {
        // İlk durum okuma
        fetch('/api/sniffer/status')
            .then(r => r.json())
            .then(d => {
                this.el.snifferToggle.checked = d.active;
                this.updateSnifferVisuals(d.active);
            }).catch(e => console.error("Sniffer API offline", e));

        this.el.snifferToggle.addEventListener('change', (e) => {
            const endpoint = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${endpoint}`, { method: 'POST' })
                .then(() => this.updateSnifferVisuals(e.target.checked));
        });
    },

    updateSnifferVisuals(isActive) {
        if (isActive) {
            this.el.snifferStatus.innerText = "RECORDING";
            this.el.snifferStatus.className = "val recording";
            this.el.snifferWidget.classList.add("active");
        } else {
            this.el.snifferStatus.innerText = "STANDBY";
            this.el.snifferStatus.className = "val standby";
            this.el.snifferWidget.classList.remove("active");
        }
    },

    setupControls() {
        document.getElementById('btn-pause').onclick = (e) => {
            state.isPaused = !state.isPaused;
            state.autoScroll = !state.isPaused;
            e.target.innerText = state.isPaused ? "▶ RESUME" : "⏸ PAUSE";
            e.target.style.color = state.isPaused ? "var(--warning)" : "#fff";
        };

        document.getElementById('btn-clear').onclick = () => {
            state.logs = [];
            this.render();
        };

        document.getElementById('btn-close-inspector').onclick = () => {
            this.el.inspector.classList.remove('open');
            state.selectedLog = null;
            this.render();
        };

        // WireShark "Follow Trace" Button
        document.getElementById('btn-follow-trace').onclick = () => {
            if (state.selectedLog && state.selectedLog.trace_id) {
                this.el.inpTrace.value = state.selectedLog.trace_id;
                state.filters.trace = state.selectedLog.trace_id.toLowerCase();
                this.filterLogs();
                this.render();
            } else if (state.selectedLog && state.selectedLog.attributes['sip.call_id']) {
                this.el.inpTrace.value = state.selectedLog.attributes['sip.call_id'];
                state.filters.trace = state.selectedLog.attributes['sip.call_id'].toLowerCase();
                this.filterLogs();
                this.render();
            }
        };

        // Copy JSON
        document.getElementById('btn-copy-json').onclick = (e) => {
            if (state.selectedLog) {
                navigator.clipboard.writeText(JSON.stringify(state.selectedLog, null, 2));
                const orig = e.target.innerText;
                e.target.innerText = "✅ COPIED";
                setTimeout(() => e.target.innerText = orig, 2000);
            }
        };

        // Click Event Delegation
        this.el.content.addEventListener('click', (e) => {
            const row = e.target.closest('.log-row');
            if (row) this.inspectLog(row.dataset.id);
        });
    },

    setupFilters() {
        const apply = () => { this.filterLogs(); this.render(); };
        this.el.inpTrace.oninput = (e) => { state.filters.trace = e.target.value.toLowerCase(); apply(); };
        this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        this.el.selLevel.onchange = (e) => { state.filters.level = e.target.value; apply(); };
    },

    filterLogs() {
        const f = state.filters;
        state.filteredLogs = state.logs.filter(l => {
            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            if (f.svc && !l.resource['service.name'].toLowerCase().includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
            if (f.trace) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(f.trace) && !cid.includes(f.trace)) return false;
            }
            return true;
        });
    },

    startLoop() {
        const loop = () => {
            if (state.hasNewLogs && !state.isPaused) {
                this.filterLogs();
                this.render();
                state.hasNewLogs = false;
            }
            if (state.autoScroll && !state.isPaused && !state.selectedLog) {
                this.el.wrapper.scrollTop = this.el.wrapper.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        const data = state.filteredLogs.slice(-250); // Son 250
        
        this.el.content.innerHTML = data.map(log => {
            const ts = log.ts.split('T')[1].slice(0, 12);
            const svc = log.resource['service.name'];
            const isSel = state.selectedLog === log ? 'selected' : '';
            
            let tagsHtml = '';
            if (log.smart_tags) {
                log.smart_tags.forEach(t => tagsHtml += `<span class="tag tag-${t}">${t}</span>`);
            }

            // SIP Packet Summary Extract
            let summary = this.escape(log.message);
            if (log.attributes['packet.summary']) {
                summary = `<span style="color:var(--info)">[${log.attributes['sip.method']}]</span> ${this.escape(log.attributes['packet.summary'])}`;
            }

            return `
                <div class="log-row ${isSel}" data-id="${log.ts}-${svc}">
                    <span style="color:#71717a">${ts}</span>
                    <span class="sev-badge sev-${log.severity}">${log.severity}</span>
                    <span style="color:#a855f7">${svc}</span>
                    <span style="color:#e2e8f0; font-weight:bold;">${log.event}</span>
                    <span class="col-msg">${tagsHtml} <span>${summary}</span></span>
                </div>
            `;
        }).join('');
    },

    inspectLog(id) {
        const log = state.filteredLogs.find(l => `${l.ts}-${l.resource['service.name']}` === id);
        if (!log) return;

        state.selectedLog = log;
        state.isPaused = true;
        document.getElementById('btn-pause').innerText = "▶ RESUME";
        document.getElementById('btn-pause').style.color = "var(--warning)";
        
        this.el.inspector.classList.add('open');
        this.render(); // Update selection color

        // Payload format
        let payloadView = "";
        if (log.attributes['payload']) {
            // SIP raw payload varsa onu ayrıca text olarak göster
            payloadView = `
            <div style="margin-bottom:10px; color:var(--info); font-weight:bold;">RAW PAYLOAD:</div>
            <pre style="color:#e2e8f0; margin-bottom:20px; border-left:2px solid var(--info); padding-left:10px;">${this.escape(log.attributes['payload'])}</pre>
            <div style="margin-bottom:10px; color:var(--accent); font-weight:bold;">ATTRIBUTES:</div>
            `;
            // Payload'ı attributes içinden sil ki JSON'da tekrar devasa çıkmasın
            delete log.attributes['payload'];
        }

        this.el.detail.innerHTML = `
            <div style="margin-bottom:20px;">
                <div style="font-size:16px; color:#fff; font-weight:800; margin-bottom:5px;">${log.event}</div>
                <div style="color:var(--text-muted); font-size:10px;">TIMESTAMP: ${log.ts}</div>
                <div style="color:var(--text-muted); font-size:10px;">TRACE ID: ${log.trace_id || 'N/A'}</div>
            </div>
            ${payloadView}
            <pre>${this.syntaxHighlight(log.attributes)}</pre>
        `;

        // FUTURE: MEDIA MODULE LOGIC
        if (log.smart_tags && (log.smart_tags.includes('RTP') || log.smart_tags.includes('DTMF'))) {
            this.el.mediaModule.style.display = 'block';
            let pt = log.attributes['rtp.payload_type'];
            this.el.audioPt.innerText = pt;
            this.el.audioCodec.innerText = pt === 0 ? "PCMU (G.711u)" : (pt === 8 ? "PCMA (G.711a)" : (pt === 101 ? "DTMF" : "Unknown"));
        } else {
            this.el.mediaModule.style.display = 'none';
        }
    },

    escape(str) {
        if (!str) return "";
        return str.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    },
    
    syntaxHighlight(json) {
        if (typeof json != 'string') json = JSON.stringify(json, undefined, 2);
        json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    return `<span style="color:#7dd3fc">${match.replace(/:/,'')}</span>:`;
                } else {
                    return `<span style="color:#fdba74">${match}</span>`;
                }
            }
            return `<span style="color:#86efac">${match}</span>`;
        });
    }
};

// WebSocket Init
const badge = document.getElementById('ws-status');
new LogStream(CONFIG.WS_URL, 
    (log) => {
        state.logs.push(log);
        state.pps++;
        state.hasNewLogs = true;
        if(state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    (status) => {
        if(status) {
            badge.innerText = "ONLINE";
            badge.className = "status-badge connected";
        } else {
            badge.innerText = "OFFLINE";
            badge.className = "status-badge disconnected";
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init();
    ui.init();
});
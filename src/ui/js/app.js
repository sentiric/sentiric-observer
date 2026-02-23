import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],
    filteredLogs: [],
    pps: 0,
    isPaused: false,
    autoScroll: true,
    selectedLog: null,
    filters: { svc: '', trace: '', level: 'ALL', msg: '' }
};

const ui = {
    // Cache Elements
    el: {
        pps: document.getElementById('pps-val'),
        total: document.getElementById('total-logs-val'),
        buffer: document.getElementById('buffer-usage'),
        status: document.getElementById('ws-status'),
        wrapper: document.getElementById('console-wrapper'),
        content: document.getElementById('console-content'),
        inspector: document.getElementById('inspector-panel'),
        inspectorDetail: document.getElementById('inspector-detail'),
        snifferStatus: document.getElementById('sniffer-status'),
        snifferToggle: document.getElementById('sniffer-toggle')
    },

    init() {
        this.setupFilters();
        this.setupControls();
        this.setupSniffer();
        this.startLoop();
        
        // 1 saniyelik istatistik döngüsü
        setInterval(() => {
            this.el.pps.innerText = state.pps;
            this.el.total.innerText = state.logs.length;
            this.el.buffer.innerText = Math.round((state.logs.length / CONFIG.MAX_LOGS) * 100) + "%";
            visualizer.pushData(state.pps);
            state.pps = 0;
        }, 1000);
    },

    setupSniffer() {
        // İlk durumu çek
        fetch('/api/sniffer/status')
            .then(r => r.json())
            .then(data => {
                this.el.snifferToggle.checked = data.active;
                this.updateSnifferUI(data.active);
            })
            .catch(e => console.error("API Error", e));

        // Toggle Event
        this.el.snifferToggle.addEventListener('change', (e) => {
            const endpoint = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${endpoint}`, { method: 'POST' })
                .then(r => r.json())
                .then(res => {
                    this.updateSnifferUI(e.target.checked);
                    // Loga bilgi düş
                    console.log(`Sniffer ${res.status}: ${res.message}`);
                });
        });
    },

    updateSnifferUI(isActive) {
        if (isActive) {
            this.el.snifferStatus.innerText = "RECORDING";
            this.el.snifferStatus.style.color = "var(--danger)";
            this.el.snifferStatus.classList.add("blink");
        } else {
            this.el.snifferStatus.innerText = "STANDBY";
            this.el.snifferStatus.style.color = "#555";
            this.el.snifferStatus.classList.remove("blink");
        }
    },

    setupControls() {
        // Pause Button
        document.getElementById('btn-pause').onclick = (e) => {
            state.isPaused = !state.isPaused;
            state.autoScroll = !state.isPaused;
            e.target.innerText = state.isPaused ? "RESUME" : "PAUSE";
            e.target.style.borderColor = state.isPaused ? "var(--danger)" : "var(--border)";
        };

        // Clear Button
        document.getElementById('btn-clear').onclick = () => {
            state.logs = [];
            state.filteredLogs = [];
            this.render();
        };

        // Inspector Close
        document.getElementById('btn-close-inspector').onclick = () => {
            this.el.inspector.classList.remove('open');
            state.selectedLog = null;
            this.render();
        };

        // Row Click (Delegation)
        this.el.content.addEventListener('click', (e) => {
            const row = e.target.closest('.log-row');
            if (row) this.inspectLog(row.dataset.id);
        });
    },

    setupFilters() {
        const apply = () => { this.filterLogs(); this.render(); };
        document.getElementById('filter-svc').oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        document.getElementById('filter-trace').oninput = (e) => { state.filters.trace = e.target.value.toLowerCase(); apply(); };
        document.getElementById('filter-msg').oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        document.getElementById('filter-level').onchange = (e) => { state.filters.level = e.target.value; apply(); };
    },

    filterLogs() {
        const f = state.filters;
        state.filteredLogs = state.logs.filter(l => {
            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            if (f.svc && !l.resource['service.name'].toLowerCase().includes(f.svc)) return false;
            if (f.trace) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(f.trace) && !cid.includes(f.trace)) return false;
            }
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
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
        const data = state.filteredLogs.slice(-200); // Sadece son 200'ü çiz (Performans)
        
        this.el.content.innerHTML = data.map(log => {
            const ts = log.ts.split('T')[1].slice(0, 8);
            const svc = log.resource['service.name'];
            const selClass = state.selectedLog === log ? 'selected' : '';
            const color = log.severity === 'ERROR' ? '#f87171' : (log.severity === 'WARN' ? '#facc15' : '#a1a1aa');
            
            return `
                <div class="log-row ${selClass}" data-id="${log.ts}-${log.resource['service.name']}">
                    <span style="color:#555">${ts}</span>
                    <span class="badge badge-${log.severity}">${log.severity}</span>
                    <span style="color:#d8b4fe">${svc}</span>
                    <span style="color:#818cf8">${log.event}</span>
                    <span style="color:${color}">${this.escape(log.message)}</span>
                </div>
            `;
        }).join('');
    },

    inspectLog(id) {
        // Basit ID eşleşmesi yerine referans bulma (Timestamp unique varsayımıyla riskli olabilir ama şimdilik yeterli)
        const log = state.filteredLogs.find(l => `${l.ts}-${l.resource['service.name']}` === id);
        if (!log) return;

        state.selectedLog = log;
        state.isPaused = true;
        this.el.inspector.classList.add('open');
        this.el.inspectorDetail.innerHTML = `<pre>${this.syntaxHighlight(log)}</pre>`;
        this.render(); // Highlight için
    },

    escape(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    
    syntaxHighlight(json) {
        if (typeof json != 'string') json = JSON.stringify(json, undefined, 2);
        json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = 'number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    return `<span style="color:#9cdcfe">${match.replace(/:/,'')}</span>:`;
                } else {
                    return `<span style="color:#ce9178">${match}</span>`;
                }
            }
            return `<span style="color:#b5cea8">${match}</span>`;
        });
    }
};

// WebSocket Init
new LogStream(CONFIG.WS_URL, 
    (log) => {
        state.logs.push(log);
        state.pps++;
        state.hasNewLogs = true;
        if(state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(status) {
            el.innerText = "● CONNECTED";
            el.classList.add('connected');
            el.classList.remove('disconnected');
        } else {
            el.innerText = "● DISCONNECTED";
            el.classList.add('disconnected');
            el.classList.remove('connected');
        }
    }
).connect();

// Global Access
window.ui = ui;
document.addEventListener('DOMContentLoaded', () => {
    visualizer.init();
    ui.init();
});
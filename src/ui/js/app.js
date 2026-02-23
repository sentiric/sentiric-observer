import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],          // Tüm hafıza (Ring Buffer mantığıyla)
    filteredLogs: [],  // Ekranda gösterilecekler
    pps: 0,
    isPaused: false,
    selectedLog: null, // Detay panelinde seçili olan
    autoScroll: true,
    isConnected: false,
    filters: {
        service: '',
        trace: '',
        level: 'ALL',
        msg: ''
    }
};

const ui = {
    wrapper: document.getElementById('console-wrapper'),
    content: document.getElementById('console-content'),
    inspector: document.getElementById('inspector-panel'),
    detailContent: document.getElementById('inspector-detail'),

    // Inputs
    inpService: document.getElementById('filter-svc'),
    inpTrace: document.getElementById('filter-trace'),
    inpMsg: document.getElementById('filter-msg'),
    selLevel: document.getElementById('filter-level'),

    init() {
        // Event Listeners
        const apply = () => { this.processLogs(); this.renderVirtual(); };

        this.inpService.addEventListener('input', apply);
        this.inpTrace.addEventListener('input', apply);
        this.inpMsg.addEventListener('input', apply);
        this.selLevel.addEventListener('change', apply);

        document.getElementById('btn-pause').onclick = () => {
            state.isPaused = !state.isPaused;
            state.autoScroll = !state.isPaused;
            document.getElementById('btn-pause').innerText = state.isPaused ? "RESUME" : "PAUSE";
            document.getElementById('btn-pause').style.borderColor = state.isPaused ? "#f85149" : "#30363d";
        };

        document.getElementById('btn-close-inspector').onclick = () => {
            this.inspector.classList.remove('open');
            state.selectedLog = null;
            this.renderVirtual(); // Highlight'ı kaldır
        };

        document.getElementById('btn-export').onclick = () => this.exportLogs();
        document.getElementById('btn-copy-llm').onclick = () => this.copyForLLM();

        // Render Loop
        requestAnimationFrame(() => this.loop());

        // Stats Interval
        setInterval(() => {
            document.getElementById('pps-val').innerText = state.pps;
            document.getElementById('total-logs-val').innerText = state.logs.length;
            document.getElementById('buffer-usage').innerText = Math.round((state.logs.length / CONFIG.MAX_LOGS) * 100) + "%";
            visualizer.pushData(state.pps);
            state.pps = 0;
        }, 1000);

        // ui.init() içine eklenecek:

        // Sniffer Toggle Logic
        const snifferToggle = document.getElementById('sniffer-toggle');
        const snifferStatus = document.getElementById('sniffer-status');

        // 1. Mevcut durumu çek
        fetch('/api/sniffer/status')
            .then(res => res.json())
            .then(data => {
                snifferToggle.checked = data.active;
                updateSnifferLabel(data.active);
            });

        snifferToggle.addEventListener('change', (e) => {
            const action = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${action}`, { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    updateSnifferLabel(e.target.checked);
                });
        });

        function updateSnifferLabel(active) {
            snifferStatus.innerText = active ? "RECORDING" : "STANDBY";
            snifferStatus.style.color = active ? "#ff7b72" : "#555"; // Kırmızı kayıt ışığı
            snifferStatus.className = active ? "blink" : "";
        }
    },

    loop() {
        if (!state.isPaused && state.newLogs) {
            this.processLogs();
            this.renderVirtual();
            state.newLogs = false;
        }

        if (state.autoScroll && !state.isPaused && !state.selectedLog) {
            this.wrapper.scrollTop = this.wrapper.scrollHeight;
        }
        requestAnimationFrame(() => this.loop());
    },

    processLogs() {
        // Filtreleme Motoru
        const f = state.filters;
        f.service = this.inpService.value.toLowerCase();
        f.trace = this.inpTrace.value.toLowerCase();
        f.level = this.selLevel.value;
        f.msg = this.inpMsg.value.toLowerCase();

        state.filteredLogs = state.logs.filter(log => {
            if (f.service && !log.resource['service.name'].toLowerCase().includes(f.service)) return false;

            if (f.trace) {
                const tid = (log.trace_id || '').toLowerCase();
                const cid = (log.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(f.trace) && !cid.includes(f.trace)) return false;
            }

            if (f.msg && !log.message.toLowerCase().includes(f.msg)) return false;

            if (f.level !== 'ALL') {
                const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
                if (levels.indexOf(log.severity) < levels.indexOf(f.level)) return false;
            }
            return true;
        });
    },

    renderVirtual() {
        if (!this.wrapper || !this.content) return;
        const data = state.filteredLogs;
        const total = data.length;
        const rowH = 26; // CSS ile eşleşmeli
        const visibleRows = Math.ceil(this.wrapper.clientHeight / rowH);
        const scrollTop = this.wrapper.scrollTop;
        const startIdx = Math.floor(scrollTop / rowH);

        const renderStart = Math.max(0, startIdx - 5);
        const renderEnd = Math.min(total, startIdx + visibleRows + 5);

        this.content.style.height = `${total * rowH}px`;

        let html = '';
        for (let i = renderStart; i < renderEnd; i++) {
            const log = data[i];
            const isSel = state.selectedLog === log;
            html += this.createRow(log, i * rowH, isSel);
        }

        // Event Delegation yerine string onclick kullanmıyoruz, 
        // wrapper üzerine listener ekliyoruz (daha performanslı).
        this.content.innerHTML = html;
    },

    createRow(log, top, isSelected) {
        const time = log.ts.split('T')[1].split('.')[0]; // HH:MM:SS
        const severity = log.severity || 'INFO';
        const svc = log.resource['service.name'] || 'sys';
        const evt = log.event || 'UNKNOWN';

        const host = log.resource['host.name'] || log.resource['net.host.ip'] || 'unknown';

        let tagsHtml = '';
        if (log.smart_tags) {
            log.smart_tags.forEach(tag => {
                tagsHtml += `<span class="tag tag-${tag}">${tag}</span>`;
            });
        }

        const rowClass = `log-row ${isSelected ? 'selected' : ''} ${severity === 'ERROR' ? 'row-error' : ''}`;

        // Data attribute ile indexi sakla
        return `<div class="${rowClass}" style="position:absolute; top:${top}px; width:100%;" data-id="${log.ts}">
            <span class="col-ts">${time}</span>
            <span class="col-lvl badge bg-${severity}">${severity}</span>
            <span class="col-svc" style="color:#d2a8ff;">${svc}</span>
            <span class="col-evt" style="color:#79c0ff;">${evt}</span>
            <span class="col-msg">${this.escapeHtml(log.message)} ${tagsHtml}</span>
        </div>`;
    },

    // Detay Paneli ve Focus Logic
    handleLogClick(ts) {
        const log = state.filteredLogs.find(l => l.ts === ts);
        if (!log) return;

        state.selectedLog = log;
        state.isPaused = true; // İnceleme yaparken akışı durdur
        document.getElementById('btn-pause').innerText = "RESUME";
        document.getElementById('btn-pause').style.borderColor = "#f85149";

        this.inspector.classList.add('open');
        this.renderVirtual(); // Selection highlight için tekrar çiz

        // JSON Pretty Print
        const jsonStr = JSON.stringify(log, null, 2);
        const syntaxHighlight = this.syntaxHighlight(jsonStr);

        this.detailContent.innerHTML = `
            <div style="margin-bottom:15px; border-bottom:1px solid #30363d; padding-bottom:10px;">
                <div style="font-size:14px; color:#fff; font-weight:bold;">${log.event}</div>
                <div style="color:#8b949e; font-size:10px;">${log.ts}</div>
            </div>
            
            <div style="display:flex; gap:5px; margin-bottom:15px;">
                <button onclick="filterByTrace('${log.trace_id}')" class="modern-input" style="flex:1; cursor:pointer;">🔍 Filter Trace</button>
                <button onclick="filterBySvc('${log.resource['service.name']}')" class="modern-input" style="flex:1; cursor:pointer;">🔍 Filter Service</button>
            </div>

            <pre style="white-space:pre-wrap; color:#c9d1d9;">${syntaxHighlight}</pre>
        `;
    },

    exportLogs() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const serviceName = state.filters.service || 'all-services';
        const serverId = state.filteredLogs[0]?.resource?.['host.name'] || 'unknown-host';

        const fileName = `logs_${serviceName}_${serverId}_${timestamp}.json`;

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.filteredLogs, null, 2));
        const node = document.createElement('a');
        node.setAttribute("href", dataStr);
        node.setAttribute("download", fileName);
        //
        document.body.appendChild(node);
        node.click();
        node.remove();
    },

    copyForLLM() {
        // Şu anki görünümdeki tüm logları al
        // Sadece kritik alanları seç (token tasarrufu)
        const context = state.filteredLogs.map(l =>
            `[${l.ts}] ${l.severity} | ${l.resource['service.name']} | ${l.event} | ${l.message} | TRACE:${l.trace_id || 'N/A'}`
        ).join('\n');

        const prompt = `Here are the system logs from Sentiric Observer. Analyze the sequence of events and identify the root cause of any errors:\n\n${context}`;

        navigator.clipboard.writeText(prompt).then(() => {
            const btn = document.getElementById('btn-copy-llm');
            const original = btn.innerText;
            btn.innerText = "✅ COPIED!";
            setTimeout(() => btn.innerText = original, 2000);
        });
    },

    escapeHtml(text) {
        if (!text) return "";
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },

    syntaxHighlight(json) {
        json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            var cls = 'number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'key';
                    match = match.replace(/"/g, '').replace(/:/g, ''); // Key tırnaklarını temizle (estetik)
                    return `<span style="color:#79c0ff">${match}</span>:`;
                } else {
                    cls = 'string';
                    return `<span style="color:#a5d6ff">${match}</span>`;
                }
            } else if (/true|false/.test(match)) {
                return `<span style="color:#ff7b72">${match}</span>`; // Bool
            } else if (/null/.test(match)) {
                return `<span style="color:#ff7b72">${match}</span>`;
            }
            return `<span style="color:#d2a8ff">${match}</span>`; // Number
        });
    }
};

// Global Helpers for Inspector Buttons
window.filterByTrace = (tid) => {
    if (!tid) return;
    ui.inpTrace.value = tid;
    ui.inpTrace.dispatchEvent(new Event('input'));
};
window.filterBySvc = (svc) => {
    ui.inpService.value = svc;
    ui.inpService.dispatchEvent(new Event('input'));
};

const stream = new LogStream(CONFIG.WS_URL,
    (log) => {
        state.logs.push(log);
        state.pps++;
        state.newLogs = true;
        if (state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    // [DÜZELTME]: Yeni onStatusChange callback'i burada kullanılıyor
    (status) => {
        state.isConnected = status;
        const el = document.getElementById('ws-status');
        if (el) { // Eleman mevcutsa güncelle
            el.innerText = status ? "CONNECTED" : "DISCONNECTED";
            el.style.color = status ? "#2ea043" : "#f85149";
        }
    }
);

// Click Handler (Event Delegation)
document.getElementById('console-content').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (row) {
        const ts = row.getAttribute('data-id');
        ui.handleLogClick(ts);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init();
    ui.init();
    stream.connect();
});
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
    // Cache Elements (Güvenli atama)
    el: {},

    init() {
        // [CRITICAL FIX]: DOM elementlerini güvenli bir şekilde cache'le.
        // Element bulunamazsa uygulama çökmesin diye null kontrolü yapacağız.
        this.el = {
            pps: document.getElementById('pps-val'),
            total: document.getElementById('total-logs-val'),
            buffer: document.getElementById('buffer-usage'),
            status: document.getElementById('ws-status'),
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
            
            // Buttons
            btnPause: document.getElementById('btn-pause'),
            btnClear: document.getElementById('btn-clear'),
            btnCloseInspector: document.getElementById('btn-close-inspector'),
            btnFollowTrace: document.getElementById('btn-follow-trace'),
            btnCopyJson: document.getElementById('btn-copy-json'),
        };

        this.setupFilters();
        this.setupControls();
        this.setupSniffer();
        this.startLoop();
        
        // 1 saniyelik istatistik döngüsü (Null check eklendi)
        setInterval(() => {
            if (this.el.pps) this.el.pps.innerText = state.pps;
            if (this.el.total) this.el.total.innerText = state.logs.length;
            if (this.el.buffer && typeof CONFIG !== 'undefined') {
                this.el.buffer.innerText = Math.round((state.logs.length / CONFIG.MAX_LOGS) * 100) + "%";
            }
            
            visualizer.pushData(state.pps);
            state.pps = 0;
        }, 1000);
    },

    setupSniffer() {
        if (!this.el.snifferToggle || !this.el.snifferStatus) return;

        // İlk durumu çek
        fetch('/api/sniffer/status')
            .then(r => r.json())
            .then(d => {
                this.el.snifferToggle.checked = d.active;
                this.updateSnifferVisuals(d.active);
            }).catch(e => console.error("Sniffer API offline", e));

        // Toggle Event
        this.el.snifferToggle.addEventListener('change', (e) => {
            const endpoint = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${endpoint}`, { method: 'POST' })
                .then(r => r.json())
                .then(res => {
                    this.updateSnifferVisuals(e.target.checked);
                    console.log(`Sniffer ${res.status}: ${res.message}`);
                }).catch(err => {
                    console.error("Sniffer command failed:", err);
                    // Hata olursa UI switch'ini geri al
                    e.target.checked = !e.target.checked;
                });
        });
    },

    updateSnifferVisuals(isActive) {
        if (!this.el.snifferStatus || !this.el.snifferWidget) return;

        if (isActive) {
            this.el.snifferStatus.innerText = "RECORDING";
            this.el.snifferStatus.className = "val recording blink"; // blink sınıfı direkt eklendi
            this.el.snifferWidget.classList.add("active");
        } else {
            this.el.snifferStatus.innerText = "STANDBY";
            this.el.snifferStatus.className = "val standby";
            this.el.snifferWidget.classList.remove("active");
        }
    },

    setupControls() {
        // Pause Button
        if (this.el.btnPause) {
            this.el.btnPause.onclick = (e) => {
                state.isPaused = !state.isPaused;
                state.autoScroll = !state.isPaused;
                e.target.innerText = state.isPaused ? "▶ RESUME" : "⏸ PAUSE";
                e.target.style.color = state.isPaused ? "var(--warning)" : "#fff";
            };
        }

        // Clear Button
        if (this.el.btnClear) {
            this.el.btnClear.onclick = () => {
                state.logs = [];
                state.filteredLogs = [];
                this.render();
            };
        }

        // Inspector Close
        if (this.el.btnCloseInspector && this.el.inspector) {
            this.el.btnCloseInspector.onclick = () => {
                this.el.inspector.classList.remove('open');
                state.selectedLog = null;
                this.render();
            };
        }

        // WireShark "Follow Trace" Button
        if (this.el.btnFollowTrace && this.el.inpTrace) {
            this.el.btnFollowTrace.onclick = () => {
                if (state.selectedLog && state.selectedLog.trace_id) {
                    this.el.inpTrace.value = state.selectedLog.trace_id;
                    state.filters.trace = state.selectedLog.trace_id.toLowerCase();
                    this.filterLogs();
                    this.render();
                } else if (state.selectedLog && state.selectedLog.attributes && state.selectedLog.attributes['sip.call_id']) {
                    this.el.inpTrace.value = state.selectedLog.attributes['sip.call_id'];
                    state.filters.trace = state.selectedLog.attributes['sip.call_id'].toLowerCase();
                    this.filterLogs();
                    this.render();
                }
            };
        }

        // Copy JSON
        if (this.el.btnCopyJson) {
            this.el.btnCopyJson.onclick = (e) => {
                if (state.selectedLog) {
                    navigator.clipboard.writeText(JSON.stringify(state.selectedLog, null, 2));
                    const orig = e.target.innerText;
                    e.target.innerText = "✅ COPIED";
                    setTimeout(() => e.target.innerText = orig, 2000);
                }
            };
        }

        // Click Event Delegation for Rows
        if (this.el.content) {
            this.el.content.addEventListener('click', (e) => {
                const row = e.target.closest('.log-row');
                if (row) this.inspectLog(row.dataset.id);
            });
        }
    },

    setupFilters() {
        const apply = () => { this.filterLogs(); this.render(); };
        
        if (this.el.inpTrace) this.el.inpTrace.oninput = (e) => { state.filters.trace = e.target.value.toLowerCase(); apply(); };
        if (this.el.inpSvc) this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        if (this.el.inpMsg) this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        if (this.el.selLevel) this.el.selLevel.onchange = (e) => { state.filters.level = e.target.value; apply(); };
    },

    filterLogs() {
        const f = state.filters;
        state.filteredLogs = state.logs.filter(l => {
            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            
            const svcName = l.resource && l.resource['service.name'] ? l.resource['service.name'].toLowerCase() : '';
            if (f.svc && !svcName.includes(f.svc)) return false;
            
            if (f.trace) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes && l.attributes['sip.call_id'] ? l.attributes['sip.call_id'] : '').toLowerCase();
                if (!tid.includes(f.trace) && !cid.includes(f.trace)) return false;
            }
            
            const msg = (l.message || '').toLowerCase();
            if (f.msg && !msg.includes(f.msg)) return false;
            
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
            if (state.autoScroll && !state.isPaused && !state.selectedLog && this.el.wrapper) {
                this.el.wrapper.scrollTop = this.el.wrapper.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        if (!this.el.content) return;

        const data = state.filteredLogs.slice(-250); // Son 250 logu çiz (Performans için)
        
        this.el.content.innerHTML = data.map(log => {
            // Güvenli erişim
            const tsParts = log.ts ? log.ts.split('T') : ['','00:00:00'];
            const timeStr = tsParts.length > 1 ? tsParts[1].slice(0, 12) : log.ts;
            const svc = log.resource && log.resource['service.name'] ? log.resource['service.name'] : 'sys';
            const evt = log.event || 'UNKNOWN';
            const severity = log.severity || 'INFO';
            
            const isSel = state.selectedLog === log ? 'selected' : '';
            const color = severity === 'ERROR' ? '#f87171' : (severity === 'WARN' ? '#facc15' : '#a1a1aa');
            
            let tagsHtml = '';
            if (log.smart_tags && Array.isArray(log.smart_tags)) {
                log.smart_tags.forEach(t => tagsHtml += `<span class="tag tag-${t}">${t}</span>`);
            }

            // SIP Packet Summary Extract
            let summary = this.escape(log.message);
            if (log.attributes && log.attributes['packet.summary']) {
                const method = log.attributes['sip.method'] || '';
                summary = `<span style="color:var(--info)">[${method}]</span> ${this.escape(log.attributes['packet.summary'])}`;
            }

            return `
                <div class="log-row ${isSel}" data-id="${log.ts}-${svc}">
                    <span style="color:#71717a">${timeStr}</span>
                    <span class="sev-badge sev-${severity}">${severity}</span>
                    <span style="color:#a855f7">${svc}</span>
                    <span style="color:#e2e8f0; font-weight:bold;">${evt}</span>
                    <span class="col-msg">${tagsHtml} <span>${summary}</span></span>
                </div>
            `;
        }).join('');
    },

    inspectLog(id) {
        if (!this.el.inspector || !this.el.detail) return;

        const log = state.filteredLogs.find(l => {
            const svc = l.resource && l.resource['service.name'] ? l.resource['service.name'] : 'sys';
            return `${l.ts}-${svc}` === id;
        });
        
        if (!log) return;

        state.selectedLog = log;
        state.isPaused = true;
        
        if (this.el.btnPause) {
            this.el.btnPause.innerText = "▶ RESUME";
            this.el.btnPause.style.color = "var(--warning)";
        }
        
        this.el.inspector.classList.add('open');
        this.render(); // Seçim rengini güncelle

        // Clone attributes to manipulate for display
        let displayAttrs = log.attributes ? JSON.parse(JSON.stringify(log.attributes)) : {};
        
        let payloadView = "";
        if (displayAttrs['payload']) {
            payloadView = `
            <div style="margin-bottom:10px; color:var(--info); font-weight:bold;">RAW PAYLOAD:</div>
            <pre style="color:#e2e8f0; margin-bottom:20px; border-left:2px solid var(--info); padding-left:10px; white-space:pre-wrap;">${this.escape(displayAttrs['payload'])}</pre>
            <div style="margin-bottom:10px; color:var(--accent); font-weight:bold;">ATTRIBUTES:</div>
            `;
            delete displayAttrs['payload']; // JSON tree'den çıkart
        }

        this.el.detail.innerHTML = `
            <div style="margin-bottom:20px;">
                <div style="font-size:16px; color:#fff; font-weight:800; margin-bottom:5px;">${log.event || 'UNKNOWN'}</div>
                <div style="color:var(--text-muted); font-size:10px;">TIMESTAMP: ${log.ts}</div>
                <div style="color:var(--text-muted); font-size:10px;">TRACE ID: ${log.trace_id || 'N/A'}</div>
            </div>
            ${payloadView}
            <pre>${this.syntaxHighlight(displayAttrs)}</pre>
        `;

        // MEDIA MODULE LOGIC
        if (this.el.mediaModule) {
            if (log.smart_tags && (log.smart_tags.includes('RTP') || log.smart_tags.includes('DTMF'))) {
                this.el.mediaModule.style.display = 'block';
                let pt = displayAttrs['rtp.payload_type'];
                
                if (this.el.audioPt) this.el.audioPt.innerText = pt;
                if (this.el.audioCodec) {
                    this.el.audioCodec.innerText = pt === 0 ? "PCMU (G.711u)" : (pt === 8 ? "PCMA (G.711a)" : (pt === 101 ? "DTMF" : "Unknown"));
                }
            } else {
                this.el.mediaModule.style.display = 'none';
            }
        }
    },

    escape(str) {
        if (!str) return "";
        return str.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    },
    
    syntaxHighlight(json) {
        if (!json) return "";
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
document.addEventListener('DOMContentLoaded', () => {
    // Config yüklenmiş mi kontrol et
    if (typeof CONFIG === 'undefined') {
        console.error("CRITICAL: config.js is missing or failed to load.");
        return;
    }

    visualizer.init();
    ui.init();

    const badge = document.getElementById('ws-status');
    
    new LogStream(CONFIG.WS_URL, 
        (log) => {
            state.logs.push(log);
            state.pps++;
            state.hasNewLogs = true;
            if(state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
        },
        (status) => {
            if (!badge) return;
            if(status) {
                badge.innerText = "ONLINE";
                badge.className = "status-badge connected";
            } else {
                badge.innerText = "OFFLINE";
                badge.className = "status-badge disconnected";
            }
        }
    ).connect();
    
    // Debug için window objesine bağla
    window.ui = ui;
});
import { LogStream } from './websocket.js';

const state = {
    logs: [],
    filtered: [],
    traces: new Map(), // TraceID -> {start, count, svc}
    pps: 0,
    paused: false,
    hideNoise: true,
    lockedTrace: null,
    selectedIdx: null,
    filters: { global: '', level: 'ALL' }
};

const ui = {
    el: {},

    init() {
        const get = id => document.getElementById(id);
        const getAll = cl => document.querySelectorAll(cl);

        // [SAFE BINDING]
        this.el = {
            // Panels
            workspace: get('workspace'),
            matrix: get('matrix-content'),
            scroller: get('matrix-scroller'),
            traceList: get('trace-list'),
            inspector: get('inspector'),
            
            // Views
            viewDetails: get('view-details'),
            viewTimeline: get('view-timeline'),
            inspPlaceholder: get('insp-placeholder'),
            inspContent: get('insp-content'),
            timelineFlow: get('timeline-flow'),
            
            // Metrics
            pps: get('pps-val'),
            buffer: get('buffer-val'),
            total: get('total-val'),
            status: get('ws-status'),
            nodeName: get('node-name'),
            
            // Controls
            inpGlobal: get('filter-global'),
            btnNoise: get('btn-toggle-noise'),
            btnPause: get('btn-pause'),
            btnExport: get('btn-export'),
            btnExpRaw: get('btn-export-raw'),
            btnExpAi: get('btn-export-ai'),
            btnUnlock: get('btn-unlock-trace'),
            btnClear: get('btn-clear'),
            btnClearTraces: get('btn-clear-traces'),
            btnCloseInsp: get('btn-close-insp'),
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            selLvl: get('filter-level'),
            
            // Details
            detTs: get('det-ts'),
            detTrace: get('det-trace'),
            detNode: get('det-node'),
            detJson: get('json-viewer'),
            detRaw: get('raw-viewer'),
            rawCard: get('raw-card'),
            
            // RTP
            rtpCard: get('rtp-analyzer'),
            rtpPt: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpLen: get('rtp-len'),
            rtpFlow: get('flow-bar'),
            
            // Tabs
            tabBtns: getAll('.tab-btn'),
            tabViews: getAll('.view-pane')
        };

        this.bindEvents();
        this.checkSniffer();
        this.mainLoop();

        // 1s Ticker
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = state.logs.length;
            if(this.el.buffer) this.el.buffer.innerText = Math.round(state.logs.length / 10000) + "%";
            this.renderTraces();
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };

        if(this.el.inpGlobal) this.el.inpGlobal.oninput = (e) => {
            state.filters.global = e.target.value.toLowerCase();
            apply();
        };

        if(this.el.selLvl) this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        if(this.el.btnNoise) this.el.btnNoise.onclick = (e) => {
            state.hideNoise = !state.hideNoise;
            e.target.innerText = state.hideNoise ? "🔇 HIDE RTP NOISE" : "🔊 SHOW RTP NOISE";
            e.target.classList.toggle('active', state.hideNoise);
            apply();
        };

        if(this.el.btnPause) this.el.btnPause.onclick = (e) => {
            state.paused = !state.paused;
            e.target.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
        };

        if(this.el.btnClear) this.el.btnClear.onclick = () => {
            state.logs = []; state.traces.clear(); state.filtered = []; this.render(); this.renderTraces();
        };
        
        if(this.el.btnClearTraces) this.el.btnClearTraces.onclick = () => {
            state.traces.clear(); this.renderTraces();
        };

        if(this.el.btnUnlock) this.el.btnUnlock.onclick = () => {
            state.lockedTrace = null;
            this.el.btnUnlock.style.display = 'none';
            apply();
        };
        
        if(this.el.btnCloseInsp) this.el.btnCloseInsp.onclick = () => {
            this.el.inspector.classList.remove('open');
            this.el.workspace.classList.remove('inspector-open');
        };

        // EXPORT
        if(this.el.btnExpRaw) this.el.btnExpRaw.onclick = () => this.exportData('raw');
        if(this.el.btnExpAi) this.el.btnExpAi.onclick = () => this.exportData('ai');

        // MATRIX CLICK
        if(this.el.matrix) this.el.matrix.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if(row) this.inspect(parseInt(row.dataset.idx));
        };

        // TRACE CLICK
        if(this.el.traceList) this.el.traceList.onclick = (e) => {
            const item = e.target.closest('.trace-item');
            if(item) {
                state.lockedTrace = item.dataset.tid;
                this.el.btnUnlock.style.display = 'block';
                apply();
                this.renderTraces();
            }
        };

        // SNIFFER TOGGLE
        if(this.el.snifferToggle) {
            this.el.snifferToggle.onchange = (e) => {
                const act = e.target.checked ? 'enable' : 'disable';
                fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => this.updateSniffer(e.target.checked));
            };
        }

        // TAB SWITCHING
        this.el.tabBtns.forEach(btn => {
            btn.onclick = () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                btn.classList.add('active');
                const target = document.getElementById(btn.dataset.tab);
                if(target) target.classList.add('active');
                
                // Timeline'ı oluştur
                if(btn.dataset.tab === 'view-timeline') this.renderTimeline();
            };
        });
    },

    extractTrace(log) {
        const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        if(!tid || tid === "unknown") return;
        if(!state.traces.has(tid)) state.traces.set(tid, {start: log.ts, count: 1});
        else state.traces.get(tid).count++;
    },

    filter() {
        const query = state.filters.global;
        const fLevel = state.filters.level;
        
        state.filtered = state.logs.filter(l => {
            // Level Filter
            if (fLevel === 'WARN' && l.severity !== 'WARN' && l.severity !== 'ERROR') return false;
            if (fLevel === 'ERROR' && l.severity !== 'ERROR') return false;

            // Trace Lock
            if(state.lockedTrace) {
                const tid = (l.trace_id || (l.attributes && l.attributes['sip.call_id']) || '').toLowerCase();
                if(tid !== state.lockedTrace.toLowerCase()) return false;
            } else {
                // Noise Filter (Sadece kilitli değilken çalışır)
                if(state.hideNoise && l.event === "RTP_PACKET") return false;
            }

            // Global Search
            if(query) {
                const msg = (l.message || '').toLowerCase();
                const evt = (l.event || '').toLowerCase();
                const tid = (l.trace_id || '').toLowerCase();
                if(!msg.includes(query) && !evt.includes(query) && !tid.includes(query)) return false;
            }
            return true;
        });
    },

    mainLoop() {
        const run = () => {
            if(state.hasNew && !state.paused) { this.filter(); this.render(); state.hasNew = false; }
            if(!state.paused && !state.selectedIdx && this.el.scroller) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(run);
        };
        run();
    },

    render() {
        if (!this.el.matrix) return;
        const data = state.filtered.slice(-300); // UI Performance Limit
        this.el.matrix.innerHTML = data.map(l => {
            const time = l.ts.split('T')[1].slice(0, 12);
            const sel = state.selectedIdx === l._idx ? 'selected' : '';
            return `<div class="log-row ${sel}" data-idx="${l._idx}">
                <span style="color:#555">${time}</span>
                <span class="sev-${l.severity}">${l.severity}</span>
                <span style="color:var(--purple)">${l.resource ? l.resource['service.name'] : 'sys'}</span>
                <span style="color:#fff; font-weight:bold">${l.event}</span>
                <span style="overflow:hidden; text-overflow:ellipsis; color:#888;">${this.esc(l.message)}</span>
            </div>`;
        }).join('');
    },

    renderTraces() {
        if(!this.el.traceList) return;
        const traces = Array.from(state.traces.entries()).reverse().slice(0, 50);
        this.el.traceList.innerHTML = traces.map(([tid, d]) => {
            const active = state.lockedTrace === tid ? 'active' : '';
            return `<div class="trace-item ${active}" data-tid="${tid}">
                <div class="tid">${tid.substring(0, 24)}...</div>
                <div class="t-meta"><span>${d.start.split('T')[1].slice(0,8)}</span><span>${d.count} events</span></div>
            </div>`;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if(!log) return;
        state.selectedIdx = idx;
        
        if(this.el.inspector) this.el.inspector.classList.add('open');
        if(this.el.workspace) this.el.workspace.classList.add('inspector-open');
        if(this.el.inspPlaceholder) this.el.inspPlaceholder.style.display = 'none';
        if(this.el.inspContent) this.el.inspContent.style.display = 'block';
        this.render();

        if(this.el.detTs) this.el.detTs.innerText = log.ts;
        if(this.el.detNode) this.el.detNode.innerText = (log.resource && log.resource['host.name']) || 'N/A';
        const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        if(this.el.detTrace) this.el.detTrace.innerText = tid || 'N/A';

        // Attributes
        let attrs = log.attributes ? {...log.attributes} : {};
        if(attrs.payload) {
            if(this.el.rawCard) this.el.rawCard.style.display = 'block';
            if(this.el.detRaw) this.el.detRaw.innerText = attrs.payload;
            delete attrs.payload;
        } else {
            if(this.el.rawCard) this.el.rawCard.style.display = 'none';
        }
        if(this.el.detJson) this.el.detJson.innerText = JSON.stringify(attrs, null, 2);

        // RTP Card
        const isRtp = log.event === "RTP_PACKET" || (log.smart_tags && log.smart_tags.includes('RTP'));
        if(this.el.rtpCard) {
            this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
            if(isRtp) {
                if(this.el.rtpPt) this.el.rtpPt.innerText = attrs['rtp.payload_type'] || '-';
                if(this.el.rtpSeq) this.el.rtpSeq.innerText = attrs['rtp.sequence'] || '-';
                if(this.el.rtpLen) this.el.rtpLen.innerText = attrs['net.packet_len'] + 'B';
            }
        }
    },

    // --- TIMELINE ENGINE (FIXED) ---
    renderTimeline() {
        // [FIX]: Timeline için ya kilitli trace'i kullan, ya da seçili logun trace'ini bul
        let targetTrace = state.lockedTrace;
        if(!targetTrace && state.selectedIdx !== null) {
            const log = state.logs.find(l => l._idx === state.selectedIdx);
            if(log) targetTrace = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        }

        if(!targetTrace || !this.el.timelineFlow) {
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">Lock a trace or select a packet to view timeline.</div>';
            return;
        }

        const journey = state.logs
            .filter(l => (l.trace_id || (l.attributes && l.attributes['sip.call_id'])) === targetTrace)
            .filter(l => l.event !== "RTP_PACKET") // Timeline'da RTP kirliliği istemiyoruz
            .sort((a,b) => a.ts.localeCompare(b.ts));

        if(!journey.length) { 
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">No timeline events found.</div>'; 
            return; 
        }

        const start = new Date(journey[0].ts);
        this.el.timelineFlow.innerHTML = journey.map(l => {
            const delta = new Date(l.ts) - start;
            let type = '';
            if(l.event.includes('SIP')) type = 'sip';
            else if(l.event.includes('RTP') || l.event.includes('MEDIA')) type = 'rtp';
            if(l.severity === 'ERROR') type = 'error';

            return `<div class="tl-item ${type}">
                <div class="tl-mark"></div>
                <div class="tl-content">
                    <div class="tl-head"><span class="tl-title">${l.event}</span><span class="tl-time">+${delta}ms</span></div>
                    <div class="tl-svc">${l.resource['service.name']}</div>
                    <div class="tl-msg">${this.esc(l.message)}</div>
                </div>
            </div>`;
        }).join('');
    },

    exportData(type) {
        const trace = state.lockedTrace;
        const data = trace ? state.logs.filter(l => (l.trace_id || l.attributes['sip.call_id']) === trace) : state.filtered;
        
        if(type === 'raw') {
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            this.download(blob, `forensic_${trace || 'dump'}.json`);
        } else {
            let r = `# SENTIRIC AI FORENSIC REPORT\nTrace: ${trace || 'GLOBAL'}\nGen: ${new Date().toISOString()}\n\n## TIMELINE\n`;
            if(data.length > 0) {
                const start = new Date(data[0].ts);
                data.forEach(l => {
                    if(l.event === 'RTP_PACKET') return;
                    r += `[+${new Date(l.ts)-start}ms] ${l.severity} | ${l.resource['service.name']} -> ${l.event}: ${l.message}\n`;
                    if(l.severity === 'ERROR') r += `   ERR_DETAILS: ${JSON.stringify(l.attributes)}\n`;
                });
            }
            const blob = new Blob([r], {type: 'text/markdown'});
            this.download(blob, `ai_report_${trace || 'dump'}.md`);
        }
    },

    download(b, n) { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = n; a.click(); },

    checkSniffer() {
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            if(this.el.snifferToggle) this.el.snifferToggle.checked = d.active;
            this.updateSniffer(d.active);
        }).catch(()=>{});
    },

    updateSniffer(active) {
        if(!this.el.snifferStatus) return;
        this.el.snifferStatus.innerText = active ? "INTERCEPTING" : "STANDBY";
        this.el.snifferStatus.className = `status-led ${active ? 'recording' : 'standby'}`;
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

let logIdx = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = logIdx++;
        state.logs.push(log); state.pps++; state.hasNew = true;
        ui.extractTrace(log);
        if(state.logs.length > 10000) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(el) {
            el.innerText = status ? "ONLINE" : "OFFLINE";
            el.className = `pill ${status ? 'online' : 'offline'}`;
        }
    }
).connect();
document.addEventListener('DOMContentLoaded', () => ui.init());
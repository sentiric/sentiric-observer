// src/ui/js/app.js
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
        this.el = {
            content: get('matrix-content'),
            scroller: get('matrix-scroller'),
            traceList: get('trace-list'),
            inspector: get('forensic-inspector'),
            inspPlaceholder: get('insp-placeholder'),
            inspContent: get('insp-content'),
            // Metrics
            pps: get('pps-val'),
            buffer: get('buffer-val'),
            total: get('total-val'),
            // Controls
            inpGlobal: get('filter-global'),
            selLvl: get('filter-level'),
            btnNoise: get('btn-toggle-noise'),
            btnPause: get('btn-pause'),
            btnExport: get('btn-export'),
            btnUnlock: get('btn-unlock-trace'),
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            // Details
            detTs: get('det-ts'),
            detNode: get('det-node'),
            detTrace: get('det-trace'),
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
            tabBtns: document.querySelectorAll('.tab-btn'),
            tabViews: document.querySelectorAll('.sidebar-view'),
            timelineFlow: get('timeline-flow')
        };

        this.bindEvents();
        this.checkSniffer();
        this.mainLoop();

        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = state.logs.length;
            if(this.el.buffer) this.el.buffer.innerText = Math.round(state.logs.length / 100) + "%";
            this.renderTraces();
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };

        this.el.inpGlobal.oninput = (e) => { state.filters.global = e.target.value.toLowerCase(); apply(); };
        this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };
        
        this.el.btnNoise.onclick = () => {
            state.hideNoise = !state.hideNoise;
            this.el.btnNoise.innerText = state.hideNoise ? "🔇 HIDE RTP NOISE" : "🔊 SHOW RTP NOISE";
            this.el.btnNoise.classList.toggle('active', state.hideNoise);
            apply();
        };

        this.el.btnPause.onclick = () => {
            state.paused = !state.paused;
            this.el.btnPause.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
            this.el.btnPause.classList.toggle('active', state.paused);
        };

        this.el.btnClear.onclick = () => { state.logs = []; state.traces.clear(); apply(); this.renderTraces(); };
        this.el.btnUnlock.onclick = () => { state.lockedTrace = null; this.el.btnUnlock.style.display = 'none'; apply(); };
        this.el.btnExport.onclick = () => this.exportForensic();
        this.el.btnCloseInsp.onclick = () => this.el.inspector.classList.remove('open');

        // Click Row
        this.el.content.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if(row) this.inspect(parseInt(row.dataset.idx));
        };

        // Click Trace
        this.el.traceList.onclick = (e) => {
            const item = e.target.closest('.trace-item');
            if(item) {
                state.lockedTrace = item.dataset.tid;
                this.el.btnUnlock.style.display = 'block';
                apply();
            }
        };

        // Tabs
        this.el.tabBtns.forEach(btn => {
            btn.onclick = () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab).classList.add('active');
                if(btn.dataset.tab === 'tab-timeline') this.renderTimeline();
            }
        });

        if(this.el.snifferToggle) {
            this.el.snifferToggle.onchange = (e) => {
                const act = e.target.checked ? 'enable' : 'disable';
                fetch(`/api/sniffer/${act}`, {method:'POST'});
            };
        }
    },

    extractTrace(log) {
        const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        if(!tid || tid === "unknown") return;
        if(!state.traces.has(tid)) state.traces.set(tid, {start: log.ts, count: 1});
        else state.traces.get(tid).count++;
    },

    filter() {
        const f = state.filters;
        state.filtered = state.logs.filter(l => {
            if(state.lockedTrace) {
                const tid = l.trace_id || (l.attributes && l.attributes['sip.call_id']);
                if(tid !== state.lockedTrace) return false;
            } else if(state.hideNoise && l.event === "RTP_PACKET") return false;

            if(f.level !== 'ALL' && l.severity !== f.level) return false;
            if(f.global) {
                const search = f.global;
                const msg = (l.message || '').toLowerCase();
                const evt = (l.event || '').toLowerCase();
                if(!msg.includes(search) && !evt.includes(search)) return false;
            }
            return true;
        });
    },

    mainLoop() {
        const loop = () => {
            if(state.hasNew && !state.paused) { this.filter(); this.render(); state.hasNew = false; }
            if(!state.paused && !state.selectedIdx && this.el.scroller) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        const data = state.filtered.slice(-300);
        this.el.content.innerHTML = data.map(l => {
            const time = l.ts.split('T')[1].slice(0, 12);
            const sel = state.selectedIdx === l._idx ? 'selected' : '';
            return `<div class="log-row ${sel}" data-idx="${l._idx}">
                <span>${time}</span><span class="sev-${l.severity}">${l.severity}</span>
                <span style="color:var(--purple)">${l.resource['service.name']}</span>
                <span style="color:#fff; font-weight:bold">${l.event}</span>
                <span style="overflow:hidden; text-overflow:ellipsis">${this.esc(l.message)}</span>
            </div>`;
        }).join('');
    },

    renderTraces() {
        const traces = Array.from(state.traces.entries()).reverse().slice(0, 30);
        this.el.traceList.innerHTML = traces.map(([tid, d]) => {
            const active = state.lockedTrace === tid ? 'active' : '';
            return `<div class="trace-item ${active}" data-tid="${tid}">
                <div class="tid">${tid}</div>
                <div class="t-meta"><span>${d.start.split('T')[1].slice(0,8)}</span><span>${d.count} pkts</span></div>
            </div>`;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if(!log) return;
        state.selectedIdx = idx;
        this.el.inspector.classList.add('open');
        this.el.inspPlaceholder.style.display = 'none';
        this.el.inspContent.style.display = 'block';
        this.render();

        this.el.detTs.innerText = log.ts;
        this.el.detNode.innerText = log.resource['host.name'] || 'local';
        this.el.detTrace.innerText = log.trace_id || 'N/A';

        let attrs = {...log.attributes};
        if(attrs.payload) {
            this.el.rawCard.style.display = 'block';
            this.el.detRaw.innerText = attrs.payload;
            delete attrs.payload;
        } else { this.el.rawCard.style.display = 'none'; }

        this.el.detJson.innerText = JSON.stringify(attrs, null, 2);

        const isRtp = log.event === "RTP_PACKET";
        this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
        if(isRtp) {
            this.el.rtpPt.innerText = attrs['rtp.payload_type'];
            this.el.rtpSeq.innerText = attrs['rtp.sequence'];
            this.el.rtpLen.innerText = attrs['net.packet_len'] + 'B';
            this.el.rtpFlow.style.width = "100%";
            setTimeout(() => { if(this.el.rtpFlow) this.el.rtpFlow.style.width = "0%"; }, 100);
        }
    },

    renderTimeline() {
        if(!state.lockedTrace) return;
        const timelineLogs = state.logs.filter(l => (l.trace_id || l.attributes['sip.call_id']) === state.lockedTrace).sort((a,b) => a.ts.localeCompare(b.ts));
        if(!timelineLogs.length) return;
        const start = new Date(timelineLogs[0].ts);

        this.el.timelineFlow.innerHTML = timelineLogs.map(l => {
            const delta = new Date(l.ts) - start;
            const isErr = l.severity === 'ERROR' ? 'error' : '';
            return `<div class="timeline-item ${isErr}">
                <div class="timeline-marker"></div>
                <div class="timeline-content">
                    <div class="timeline-title">${l.event}</div>
                    <div class="timeline-meta">${l.resource['service.name']} @ +${delta}ms</div>
                </div>
            </div>`;
        }).join('');
    },

    exportForensic() {
        const trace = state.lockedTrace;
        const logs = trace ? state.logs.filter(l => (l.trace_id || l.attributes['sip.call_id']) === trace) : state.filtered;
        
        let report = `=== SENTIRIC FORENSIC REPORT ===\nGenerated: ${new Date().toISOString()}\nTarget Trace: ${trace || 'GLOBAL DUMP'}\n\n`;
        logs.forEach(l => {
            report += `[${l.ts}] [${l.severity}] [${l.resource['service.name']}] ${l.event}: ${l.message}\n`;
            if(l.severity === 'ERROR') report += `   DETAILS: ${JSON.stringify(l.attributes)}\n`;
        });

        const blob = new Blob([report], {type: 'text/plain'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `forensic_${trace || 'dump'}.txt`;
        a.click();
    },

    checkSniffer() {
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            this.el.snifferToggle.checked = d.active;
            this.el.snifferStatus.innerText = d.active ? "LIVE" : "STANDBY";
            this.el.snifferStatus.className = `pod-status ${d.active ? 'recording' : 'standby'}`;
        });
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

let logCount = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = logCount++;
        state.logs.push(log); state.pps++; state.hasNew = true;
        ui.extractTrace(log);
        if(state.logs.length > 10000) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(el) {
            el.innerText = status ? "● ONLINE" : "● OFFLINE";
            el.className = `status-pill ${status ? 'online' : 'offline'}`;
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
// src/ui/js/app.js
import { LogStream } from './websocket.js';

const state = {
    logs: [],
    filtered: [],
    traces: new Map(),
    pps: 0,
    paused: false,
    hideNoise: true,
    lockedTrace: null,
    selectedIdx: null,
    filters: { global: '' }
};

const ui = {
    el: {},

    init() {
        const get = id => document.getElementById(id);
        // [SAFE BINDING]: JS çökmesini engelleyen seçici
        this.el = {
            workspace: get('workspace'),
            content: get('matrix-content'),
            scroller: get('matrix-scroller'),
            traceList: get('trace-list'),
            inspector: get('inspector'),
            inspPlaceholder: get('insp-placeholder'),
            inspContent: get('insp-content'),
            pps: get('pps-val'),
            total: get('total-val'),
            buffer: get('buffer-val'),
            inpGlobal: get('filter-global'),
            btnNoise: get('btn-toggle-noise'),
            btnPause: get('btn-pause'),
            btnExpRaw: get('btn-export-raw'),
            btnExpAi: get('btn-export-ai'),
            btnUnlock: get('btn-unlock-trace'),
            btnClear: get('btn-clear'),
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            detTs: get('det-ts'),
            detTrace: get('det-trace'),
            detJson: get('json-viewer'),
            detRaw: get('raw-viewer'),
            rawCard: get('raw-card'),
            rtpCard: get('rtp-diag'),
            rtpPt: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpLen: get('rtp-len'),
            tabBtns: document.querySelectorAll('.tab-btn'),
            tabViews: document.querySelectorAll('.view-pane'),
            timelineFlow: get('timeline-flow'),
            nodeName: get('node-name')
        };

        this.bindEvents();
        this.checkSniffer();
        this.mainLoop();

        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = `${state.logs.length} Events`;
            this.renderTraces();
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };

        // [SAFE ACCESS]: Sadece varsa bağla
        if(this.el.inpGlobal) this.el.inpGlobal.oninput = (e) => {
            state.filters.global = e.target.value.toLowerCase();
            apply();
        };

        if(this.el.btnNoise) this.el.btnNoise.onclick = (e) => {
            state.hideNoise = !state.hideNoise;
            e.target.innerText = state.hideNoise ? "🔇 NOISE: HIDDEN" : "🔊 NOISE: VISIBLE";
            apply();
        };

        if(this.el.btnPause) this.el.btnPause.onclick = (e) => {
            state.paused = !state.paused;
            e.target.innerText = state.paused ? "▶ RESUME" : "PAUSE";
        };

        if(this.el.btnClear) this.el.btnClear.onclick = () => {
            state.logs = []; state.traces.clear(); apply(); this.renderTraces();
        };

        if(this.el.btnUnlock) this.el.btnUnlock.onclick = () => {
            state.lockedTrace = null;
            this.el.btnUnlock.style.display = 'none';
            apply();
        };

        if(this.el.btnExpRaw) this.el.btnExpRaw.onclick = () => this.exportData('raw');
        if(this.el.btnExpAi) this.el.btnExpAi.onclick = () => this.exportData('ai');

        if(this.el.content) {
            this.el.content.onclick = (e) => {
                const row = e.target.closest('.log-row');
                if(row) this.inspect(parseInt(row.dataset.idx));
            };
        }

        if(this.el.traceList) {
            this.el.traceList.onclick = (e) => {
                const item = e.target.closest('.trace-item');
                if(item) {
                    state.lockedTrace = item.dataset.tid;
                    if(this.el.btnUnlock) this.el.btnUnlock.style.display = 'block';
                    apply();
                    this.renderTraces();
                }
            };
        }

        this.el.tabBtns.forEach(btn => {
            btn.onclick = () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                btn.classList.add('active');
                const target = document.getElementById(btn.dataset.tab);
                if(target) target.classList.add('active');
                if(btn.dataset.tab === 'tab-timeline') this.renderTimeline();
            };
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
        const query = state.filters.global;
        state.filtered = state.logs.filter(l => {
            const tid = l.trace_id || (l.attributes && l.attributes['sip.call_id']);
            if(state.lockedTrace) {
                if(tid !== state.lockedTrace) return false;
            } else {
                if(state.hideNoise && l.event === "RTP_PACKET") return false;
            }
            if(query) {
                const msg = (l.message || '').toLowerCase();
                const evt = (l.event || '').toLowerCase();
                if(!msg.includes(query) && !evt.includes(query) && !(tid && tid.toLowerCase().includes(query))) return false;
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
        if (!this.el.content) return;
        const data = state.filtered.slice(-300);
        this.el.content.innerHTML = data.map(l => {
            const time = l.ts ? l.ts.split('T')[1].slice(0, 12) : '--:--';
            const isSel = state.selectedIdx === l._idx ? 'selected' : '';
            return `<div class="log-row ${isSel}" data-idx="${l._idx}">
                <span>${time}</span><span class="sev-${l.severity}">${l.severity}</span>
                <span style="color:var(--purple)">${l.resource ? l.resource['service.name'] : 'sys'}</span>
                <span style="color:#fff; font-weight:bold">${l.event}</span>
                <span style="overflow:hidden; text-overflow:ellipsis; color:#888;">${this.esc(l.message)}</span>
            </div>`;
        }).join('');
    },

    renderTraces() {
        if(!this.el.traceList) return;
        const traces = Array.from(state.traces.entries()).reverse().slice(0, 30);
        this.el.traceList.innerHTML = traces.map(([tid, d]) => {
            const active = state.lockedTrace === tid ? 'active' : '';
            return `<div class="trace-item ${active}" data-tid="${tid}">
                <div class="tid">${tid}</div>
                <div class="t-meta"><span>${d.start.split('T')[1].slice(0,8)}</span><span>${d.count} events</span></div>
            </div>`;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if(!log) return;
        state.selectedIdx = idx;

        // [SAFE ACCESS]: style ve display kontrolleri
        if(this.el.inspector) this.el.inspector.classList.add('open');
        if(this.el.workspace) this.el.workspace.classList.add('inspector-open');
        if(this.el.inspPlaceholder) this.el.inspPlaceholder.style.display = 'none';
        if(this.el.inspContent) this.el.inspContent.style.display = 'block';
        
        this.render();

        if(this.el.detTs) this.el.detTs.innerText = log.ts;
        if(this.el.detTrace) this.el.detTrace.innerText = log.trace_id || 'N/A';
        
        let attrs = {...log.attributes};
        const rawPayload = attrs.payload || null;
        
        if(this.el.rawCard) {
            if(rawPayload) {
                this.el.rawCard.style.display = 'block';
                if(this.el.detRaw) this.el.detRaw.innerText = rawPayload;
                delete attrs.payload;
            } else {
                this.el.rawCard.style.display = 'none';
            }
        }
        
        if(this.el.detJson) this.el.detJson.innerText = JSON.stringify(attrs, null, 2);

        const isRtp = log.event === "RTP_PACKET" || log.smart_tags.includes('RTP');
        if(this.el.rtpCard) {
            this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
            if(isRtp) {
                if(this.el.rtpPt) this.el.rtpPt.innerText = log.attributes['rtp.payload_type'] || '-';
                if(this.el.rtpSeq) this.el.rtpSeq.innerText = log.attributes['rtp.sequence'] || '-';
                if(this.el.rtpLen) this.el.rtpLen.innerText = (log.attributes['net.packet_len'] || 0) + 'B';
            }
        }
    },

    renderTimeline() {
        const log = state.logs.find(l => l._idx === state.selectedIdx);
        const currentTrace = state.lockedTrace || (log ? (log.trace_id || log.attributes['sip.call_id']) : null);
        
        if(!currentTrace || !this.el.timelineFlow) {
            this.el.timelineFlow.innerHTML = '<div class="empty-msg">Lock a trace to see journey.</div>';
            return;
        }

        const journey = state.logs
            .filter(l => (l.trace_id || l.attributes['sip.call_id']) === currentTrace)
            .filter(l => l.event !== "RTP_PACKET")
            .sort((a,b) => a.ts.localeCompare(b.ts));

        const start = new Date(journey[0].ts);
        this.el.timelineFlow.innerHTML = journey.map(l => {
            const delta = new Date(l.ts) - start;
            let type = l.event.includes('SIP') ? 'sip' : (l.event.includes('DECISION') ? 'decision' : '');
            if(l.severity === 'ERROR') type = 'error';
            return `<div class="tl-item ${type}">
                <div class="tl-icon"></div>
                <div class="tl-content">
                    <div class="tl-header"><span class="tl-title">${l.event}</span><span class="tl-time">+${delta}ms</span></div>
                    <div class="tl-svc">${l.resource['service.name']}</div>
                    <div class="tl-msg">${this.esc(l.message)}</div>
                </div>
            </div>`;
        }).join('');
    },

    exportData(type) {
        const log = state.logs.find(l => l._idx === state.selectedIdx);
        const trace = state.lockedTrace || (log ? (log.trace_id || log.attributes['sip.call_id']) : null);
        const data = trace ? state.logs.filter(l => (l.trace_id || l.attributes['sip.call_id']) === trace) : state.filtered;
        
        if(type === 'raw') {
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            this.download(blob, `forensic_${trace || 'dump'}.json`);
        } else {
            let r = `# SENTIRIC AI FORENSIC REPORT\nTrace: ${trace}\n\n## TIMELINE\n`;
            const start = new Date(data[0].ts);
            data.forEach(l => {
                if(l.event === 'RTP_PACKET') return;
                r += `[+${new Date(l.ts)-start}ms] ${l.resource['service.name']} -> ${l.event}: ${l.message}\n`;
            });
            const blob = new Blob([r], {type: 'text/markdown'});
            this.download(blob, `ai_report_${trace}.md`);
        }
    },

    download(b, n) { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = n; a.click(); },

    checkSniffer() {
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            if(this.el.snifferToggle) this.el.snifferToggle.checked = d.active;
            if(this.el.snifferStatus) {
                this.el.snifferStatus.innerText = d.active ? "LIVE" : "STANDBY";
                this.el.snifferStatus.className = `status-led ${d.active ? 'recording' : 'standby'}`;
            }
        }).catch(()=>{});
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
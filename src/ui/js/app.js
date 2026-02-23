import { LogStream } from './websocket.js';

const state = {
    logs: [],
    filtered: [],
    pps: 0,
    paused: false,
    selectedLog: null,
    lockedTrace: null,
    hideNoise: true, // Varsayılan olarak RTP gürültüsü kapalı
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
            inspector: get('inspector'),
            
            // Metrics
            pps: get('pps-val'),
            buffer: get('buffer-val'),
            total: get('total-logs-val'),
            status: get('ws-status'),
            nodeName: get('node-name'),
            
            // Sniffer
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            
            // Inputs
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLvl: get('filter-level'),
            
            // Buttons
            btnPause: get('btn-pause'),
            btnClear: get('btn-clear'),
            btnExport: get('btn-export'),
            btnCloseInsp: get('btn-close-insp'),
            btnLockCurrent: get('btn-lock-current'),
            btnToggleNoise: get('btn-toggle-noise'),
            
            // Views
            viewDetails: get('view-details'),
            viewTimeline: get('view-timeline'),
            timelineContent: get('timeline-content'),
            
            // Details
            jsonView: get('json-viewer'),
            rawPayload: get('raw-payload'),
            rtpCard: get('rtp-card'),
            rtpPt: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpLen: get('rtp-len'),
            rtpFlow: get('flow-bar'),
            
            // Tabs
            tabBtns: document.querySelectorAll('.tab-btn'),
            tabViews: document.querySelectorAll('.insp-view')
        };

        this.bindEvents();
        this.checkSniffer();
        this.loop();
        
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = state.logs.length;
            if(this.el.buffer) this.el.buffer.innerText = Math.round((state.logs.length / 10000) * 100) + "%";
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };

        // Inputs
        if(this.el.inpTrace) this.el.inpTrace.oninput = (e) => { 
            state.filters.trace = e.target.value.trim().toLowerCase(); 
            if(!state.filters.trace) state.lockedTrace = null;
            apply(); 
        };
        if(this.el.inpSvc) this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        if(this.el.inpMsg) this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        if(this.el.selLvl) this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        // Buttons
        if(this.el.btnPause) this.el.btnPause.onclick = (e) => {
            state.paused = !state.paused;
            e.target.innerText = state.paused ? "▶ RESUME" : "PAUSE";
            e.target.classList.toggle('active');
        };
        
        if(this.el.btnClear) this.el.btnClear.onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        if(this.el.btnCloseInsp) this.el.btnCloseInsp.onclick = () => this.closeInspector();
        
        if(this.el.btnLockCurrent) this.el.btnLockCurrent.onclick = () => this.toggleTraceLock();
        
        // NOISE TOGGLE LOGIC
        if(this.el.btnToggleNoise) this.el.btnToggleNoise.onclick = (e) => {
            state.hideNoise = !state.hideNoise;
            const btn = e.currentTarget;
            const txt = document.getElementById('noise-text');
            if(state.hideNoise) {
                btn.classList.add('active');
                txt.innerText = "NOISE: HIDDEN";
            } else {
                btn.classList.remove('active');
                txt.innerText = "NOISE: VISIBLE";
            }
            apply();
        };

        if(this.el.btnExport) this.el.btnExport.onclick = () => this.exportForAI();

        // Row Selection
        if(this.el.content) this.el.content.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if (row) this.inspect(parseInt(row.dataset.idx));
        };

        // Tabs
        this.el.tabBtns.forEach(btn => {
            btn.onclick = () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.target).classList.add('active');
                
                // If timeline selected, generate it
                if(btn.dataset.target === 'view-timeline') this.renderTimeline();
            };
        });

        // Sniffer Toggle
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
        if(this.el.snifferStatus) {
            this.el.snifferStatus.innerText = active ? "RECORDING" : "STANDBY";
            this.el.snifferStatus.className = `led ${active ? 'recording' : 'standby'}`;
        }
    },

    toggleTraceLock() {
        if(!state.selectedLog) return;
        const log = state.selectedLog;
        const tid = log.trace_id || log.attributes['sip.call_id'];
        
        if(!tid) return alert("No Trace ID found to lock.");
        
        state.lockedTrace = (state.lockedTrace === tid) ? null : tid;
        this.el.inpTrace.value = state.lockedTrace || "";
        this.el.btnLockCurrent.innerText = state.lockedTrace ? "🔓 UNLOCK TRACE" : "🔗 LOCK THIS TRACE";
        
        // Filtreyi tetikle
        state.filters.trace = (state.lockedTrace || "").toLowerCase();
        this.filter();
        this.render();
        if(state.lockedTrace) this.renderTimeline();
    },

    // --- TIMELINE ENGINE ---
    renderTimeline() {
        if(!state.lockedTrace) {
            this.el.timelineContent.innerHTML = '<div class="empty-state">Please LOCK a trace ID to generate timeline.</div>';
            return;
        }

        // Kilitli trace'e ait tüm logları al, zamana göre sırala
        const traceLogs = state.logs
            .filter(l => {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                const lock = state.lockedTrace.toLowerCase();
                return tid.includes(lock) || cid.includes(lock);
            })
            .sort((a,b) => a.ts.localeCompare(b.ts));

        let html = '';
        let startTs = null;

        traceLogs.forEach(log => {
            const date = new Date(log.ts);
            if(!startTs) startTs = date;
            const deltaMs = date - startTs;
            const isErr = log.severity === 'ERROR' || log.severity === 'FATAL';
            
            html += `
                <div class="tl-item ${isErr ? 'error' : ''}">
                    <div class="tl-time">+${deltaMs}ms</div>
                    <div class="tl-marker"></div>
                    <div class="tl-content">
                        <div class="tl-svc">${log.resource['service.name']}</div>
                        <div class="tl-msg">${this.esc(log.message)}</div>
                    </div>
                </div>
            `;
        });

        this.el.timelineContent.innerHTML = html;
    },

    // --- FILTER ENGINE ---
    filter() {
        const f = state.filters;
        const lock = state.lockedTrace ? state.lockedTrace.toLowerCase() : f.trace;

        state.filtered = state.logs.filter(l => {
            // NOISE SUPPRESSION RULE
            if (state.hideNoise && l.event === 'RTP_PACKET') return false;

            if (lock) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(lock) && !cid.includes(lock)) return false;
            }

            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            if (f.svc && !l.resource['service.name'].includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;

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
        const data = state.filtered.slice(-300); // Son 300 (Performans)
        
        this.el.content.innerHTML = data.map(log => {
            const time = log.ts.split('T')[1].slice(0, 12);
            const isSel = state.selectedLog === log ? 'selected' : '';
            const svc = log.resource['service.name'];
            const sevClass = `sev-${log.severity}`;
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            return `
                <div class="row ${isSel}" data-idx="${log._idx}">
                    <span style="color:#555">${time}</span>
                    <span class="${sevClass}">${log.severity}</span>
                    <span style="color:#c084fc">${svc}</span>
                    <span style="color:#fff; font-weight:bold">${log.event}</span>
                    <span class="m-msg">${tags} ${this.esc(log.message)}</span>
                </div>
            `;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if (!log) return;
        
        state.selectedLog = log;
        state.paused = true;
        this.el.inspector.classList.add('open');
        this.render(); // Highlight

        // JSON View
        this.el.jsonView.innerText = JSON.stringify(log.attributes, null, 2);
        
        // Raw Payload
        const raw = log.attributes['payload'] || log.attributes['packet.summary'] || "N/A";
        this.el.rawPayload.innerText = raw;

        // RTP Diagnostics
        const isRtp = log.event === 'RTP_PACKET';
        if (this.el.rtpCard) {
            this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
            if (isRtp) {
                const pt = log.attributes['rtp.payload_type'];
                const len = log.attributes['net.packet_len'] || 0;
                this.el.rtpPt.innerText = pt;
                this.el.rtpLen.innerText = len + 'B';
                
                // Flow Bar Animation
                this.el.rtpFlow.style.width = Math.min((len / 200) * 100, 100) + "%";
            }
        }
    },

    closeInspector() {
        this.el.inspector.classList.remove('open');
        state.selectedLog = null;
        state.paused = false;
        this.render();
    },

    exportForAI() {
        const trace = state.lockedTrace || state.filters.trace;
        // AI Export için filtrelenmemiş (tüm) loglardan o trace'i bul
        const data = state.logs.filter(l => {
             if(!trace) return true; // Trace yoksa o anki görünümü al
             const tid = (l.trace_id || '').toLowerCase();
             const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
             return tid.includes(trace.toLowerCase()) || cid.includes(trace.toLowerCase());
        }).map(l => ({
            t: l.ts, s: l.resource['service.name'], e: l.event, m: l.message, d: l.attributes
        }));

        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sentiric_forensic_${trace || 'dump'}.json`;
        a.click();
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

// Start
let idx = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = idx++;
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        if(state.logs.length > CONFIG.MAX_LOGS) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(el) {
            el.innerText = status ? "ONLINE" : "OFFLINE";
            el.className = `status-pill ${status ? 'online' : 'offline'}`;
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
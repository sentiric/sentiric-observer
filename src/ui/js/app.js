// src/ui/js/app.js
import { LogStream } from './websocket.js';

const state = {
    logs: [],
    filtered: [],
    pps: 0,
    paused: false,
    selectedIdx: null,
    lockedTrace: null,
    filters: { trace: '', svc: '', msg: '', level: 'ALL' }
};

const ui = {
    el: {},

    init() {
        // [ZORUNLU]: Tüm elementleri güvenli bir şekilde cache'le
        const get = (id) => document.getElementById(id);
        
        this.el = {
            content: get('log-content'),
            scroller: get('log-scroller'),
            inspector: get('inspector'),
            inspBody: get('insp-body'),
            pps: get('pps-val'),
            buffer: get('buffer-usage'),
            total: get('total-logs-val'),
            status: get('ws-status'),
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
            btnExport: get('btn-export'),
            btnClear: get('btn-clear'),
            btnCloseInsp: get('btn-close-insp'),
            btnLockCurrent: get('btn-lock-current'),
            // Forensics
            rtpUnit: get('rtp-unit'),
            rtpPT: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpFlow: get('flow-bar')
        };

        this.bindEvents();
        this.startHealthCheck();
        this.mainLoop();

        // 1s Statistics
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.buffer) this.el.buffer.innerText = Math.round((state.logs.length / 10000) * 100) + "%";
            if(this.el.total) this.el.total.innerText = `${state.logs.length} Events Processed`;
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        // [SAFE BINDING]: Sadece element varsa event bağla
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
            e.target.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
            e.target.classList.toggle('active');
        };

        if(this.el.btnExport) this.el.btnExport.onclick = () => this.exportForAI();
        if(this.el.btnClear) this.el.btnClear.onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        if(this.el.btnCloseInsp) this.el.btnCloseInsp.onclick = () => this.el.inspector.classList.remove('open');
        
        if(this.el.btnLockCurrent) this.el.btnLockCurrent.onclick = () => this.toggleTraceLock();

        if(this.el.content) this.el.content.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if (row) this.inspect(parseInt(row.dataset.idx));
        };

        if(this.el.snifferToggle) {
            this.el.snifferToggle.onchange = (e) => {
                const act = e.target.checked ? 'enable' : 'disable';
                fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => this.updateSnifferUI(e.target.checked));
            };
        }
    },

    startHealthCheck() {
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            if(this.el.snifferToggle) this.el.snifferToggle.checked = d.active;
            this.updateSnifferUI(d.active);
        }).catch(() => {});
    },

    updateSnifferUI(active) {
        if(!this.el.snifferStatus) return;
        this.el.snifferStatus.innerText = active ? "INTERCEPTING" : "STANDBY";
        this.el.snifferStatus.className = `led ${active ? 'recording' : 'standby'}`;
    },

    // AI-OPTIMIZED FORENSIC EXPORT
    exportForAI() {
        const trace = state.lockedTrace || state.filters.trace;
        const data = state.filtered.map(l => ({
            ts: l.ts,
            svc: l.resource['service.name'],
            evt: l.event,
            msg: l.message,
            trace: l.trace_id,
            details: l.attributes
        }));

        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sentiric_forensic_${trace || 'global'}_${Date.now()}.json`;
        a.click();
    },

    toggleTraceLock() {
        const log = state.logs.find(l => l._idx === state.selectedIdx);
        if(!log) return;
        const tid = log.trace_id || log.attributes['sip.call_id'];
        if(!tid) return alert("Packet has no Trace ID to lock.");

        state.lockedTrace = (state.lockedTrace === tid) ? null : tid;
        this.el.inpTrace.value = state.lockedTrace || "";
        this.el.btnLockCurrent.innerText = state.lockedTrace ? "🔓 UNLOCK STREAM" : "🔗 LOCK THIS TRACE";
        this.filter();
        this.render();
    },

    filter() {
        const f = state.filters;
        const lock = state.lockedTrace ? state.lockedTrace.toLowerCase() : f.trace;

        state.filtered = state.logs.filter(l => {
            if (lock) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes && l.attributes['sip.call_id'] ? l.attributes['sip.call_id'] : '').toLowerCase();
                if (!tid.includes(lock) && !cid.includes(lock)) return false;
            }
            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            if (f.svc && !l.resource['service.name'].toLowerCase().includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
            return true;
        });
    },

    mainLoop() {
        const loop = () => {
            if (state.hasNew && !state.paused) {
                this.filter();
                this.render();
                state.hasNew = false;
            }
            if (!state.paused && this.el.scroller && !this.el.inspector.classList.contains('open')) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        if (!this.el.content) return;
        const data = state.filtered.slice(-250); 
        this.el.content.innerHTML = data.map(log => {
            const time = log.ts ? log.ts.split('T')[1].slice(0, 12) : '--:--';
            const isSel = state.selectedIdx === log._idx ? 'selected' : '';
            const svc = log.resource['service.name'];
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            return `
                <div class="log-row ${isSel}" data-idx="${log._idx}">
                    <span style="color:#555">${time}</span>
                    <span class="sev-${log.severity}">${log.severity}</span>
                    <span style="color:#c084fc">${svc}</span>
                    <span style="color:#fff; font-weight:bold">${log.event}</span>
                    <span style="color:#aaa; overflow:hidden; text-overflow:ellipsis;">${tags} ${this.escape(log.message)}</span>
                </div>
            `;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if (!log) return;
        state.selectedIdx = idx;
        this.el.inspector.classList.add('open');
        this.render();

        // RTP Diagnostics
        const isRtp = log.smart_tags && log.smart_tags.includes('RTP');
        if(this.el.rtpUnit) {
            this.el.rtpUnit.style.display = isRtp ? 'block' : 'none';
            if (isRtp) {
                this.el.rtpPT.innerText = log.attributes['rtp.payload_type'] || '0';
                this.el.rtpSeq.innerText = log.attributes['rtp.sequence'] || 'N/A';
                const size = log.attributes['net.packet_len'] || 0;
                this.el.rtpFlow.style.width = Math.min((size / 200) * 100, 100) + "%";
            }
        }

        if(this.el.inspBody) {
            this.el.inspBody.innerHTML = `
                <div style="margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:15px;">
                    <div style="font-size:18px; font-weight:900; color:var(--accent);">${log.event}</div>
                    <div style="font-size:10px; color:#555; margin-top:5px;">TIMESTAMP: ${log.ts}</div>
                    <div style="font-size:10px; color:var(--accent)">TRACE: ${log.trace_id || 'N/A'}</div>
                </div>
                <pre style="color:#a5d6ff; background:#000; padding:15px; border-radius:4px; border:1px solid #222;">${JSON.stringify(log.attributes, null, 2)}</pre>
            `;
        }
    },

    escape(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

// --- INIT ---
let count = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = count++;
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        if(state.logs.length > 10000) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(!el) return;
        el.innerText = status ? "ONLINE" : "OFFLINE";
        el.className = `status-pill ${status ? 'connected' : 'offline'}`;
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
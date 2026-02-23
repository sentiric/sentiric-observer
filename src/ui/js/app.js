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
        const get = (id) => document.getElementById(id);
        this.el = {
            content: get('matrix-content'),
            scroller: get('matrix-scroller'),
            inspector: get('inspector'),
            inspBody: get('insp-body'),
            pps: get('pps-val'),
            total: get('total-logs-val'),
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLvl: get('filter-level'),
            rtpUnit: get('rtp-unit'),
            rtpPT: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpFlow: get('flow-bar')
        };

        this.bindEvents();
        this.startSnifferLogic();
        this.mainLoop();

        // 1s Update Metrics
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = `${state.logs.length} EVENTS`;
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };
        
        this.el.inpTrace.oninput = (e) => { 
            state.filters.trace = e.target.value.trim().toLowerCase(); 
            if(state.filters.trace === '') state.lockedTrace = null;
            apply(); 
        };
        this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        document.getElementById('btn-pause').onclick = (e) => {
            state.paused = !state.paused;
            e.target.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
            e.target.classList.toggle('active');
        };

        document.getElementById('btn-export').onclick = () => this.exportForAI();
        document.getElementById('btn-clear').onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        document.getElementById('btn-close-insp').onclick = () => this.el.inspector.classList.remove('open');
        document.getElementById('btn-lock-trace').onclick = () => this.toggleTraceLock();

        // Row Selection
        this.el.content.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if (row) this.inspect(parseInt(row.dataset.idx));
        };
    },

    startSnifferLogic() {
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            this.el.snifferToggle.checked = d.active;
            this.updateSnifferUI(d.active);
        });

        this.el.snifferToggle.onchange = (e) => {
            const act = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => this.updateSnifferUI(e.target.checked));
        };
    },

    updateSnifferUI(active) {
        this.el.snifferStatus.innerText = active ? "INTERCEPTING" : "STANDBY";
        this.el.snifferStatus.className = `status-led ${active ? 'recording' : 'standby'}`;
    },

    // [CRITICAL]: AI-Optimized Forensic Export
    exportForAI() {
        const traceToExport = state.lockedTrace || state.filters.trace;
        let dataToSave = state.filtered;

        if (traceToExport) {
            console.log("AI EXPORT: Isolating trace journey for", traceToExport);
        }

        // Bloat Removal: AI'ın ihtiyacı olmayan meta verileri temizle
        const cleanData = dataToSave.map(l => ({
            ts: l.ts,
            svc: l.resource['service.name'],
            event: l.event,
            msg: l.message,
            trace: l.trace_id,
            details: l.attributes
        }));

        const blob = new Blob([JSON.stringify(cleanData, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sentiric_forensic_${traceToExport || 'global'}_${Date.now()}.json`;
        a.click();
    },

    toggleTraceLock() {
        const log = state.logs.find(l => l._idx === state.selectedIdx);
        if(!log) return;
        const tid = log.trace_id || log.attributes['sip.call_id'];
        if(!tid) return alert("Packet has no unique Trace ID to lock.");

        state.lockedTrace = (state.lockedTrace === tid) ? null : tid;
        this.el.inpTrace.value = state.lockedTrace || "";
        this.el.btnLock.innerText = state.lockedTrace ? "🔓 UNLOCK STREAM" : "🔒 LOCK STREAM";
        this.filter();
        this.render();
    },

    filter() {
        const f = state.filters;
        const lock = state.lockedTrace ? state.lockedTrace.toLowerCase() : f.trace;

        state.filtered = state.logs.filter(l => {
            if (lock) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
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
            if (!state.paused && !this.el.inspector.classList.contains('open')) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        const data = state.filtered.slice(-200); // UI Performance
        this.el.content.innerHTML = data.map(log => {
            const time = log.ts.split('T')[1].slice(0, 12);
            const isSel = state.selectedIdx === log._idx ? 'selected' : '';
            const svc = log.resource['service.name'];
            
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            return `
                <div class="log-row ${isSel}" data-idx="${log._idx}">
                    <span style="color:#555">${time}</span>
                    <span class="sev-${log.severity}">${log.severity}</span>
                    <span style="color:#a855f7">${svc}</span>
                    <span style="color:#fff; font-weight:bold">${log.event}</span>
                    <span class="m-msg">${tags} ${this.escape(log.message)}</span>
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

        // RTP Forensics (Real Evidence)
        const isRtp = log.smart_tags && log.smart_tags.includes('RTP');
        this.el.rtpUnit.style.display = isRtp ? 'block' : 'none';
        if (isRtp) {
            this.el.rtpPT.innerText = log.attributes['rtp.payload_type'] || '0';
            this.el.rtpSeq.innerText = log.attributes['rtp.sequence'] || 'N/A';
            // Packet size indicator
            const size = log.attributes['net.packet_len'] || 0;
            this.el.rtpFlow.style.width = Math.min((size / 200) * 100, 100) + "%";
        }

        this.el.inspBody.innerHTML = `
            <div style="margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:15px;">
                <div style="font-size:18px; font-weight:900; color:var(--accent);">${log.event}</div>
                <div style="font-size:10px; color:#555; margin-top:5px;">${log.ts}</div>
            </div>
            <pre style="color:#a5d6ff; background:#000; padding:15px; border-radius:4px; border:1px solid #222; line-height:1.5;">${JSON.stringify(log.attributes, null, 2)}</pre>
        `;
    },

    escape(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

// --- WEBSOCKET BRIDGE ---
let logIdx = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = logIdx++;
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        if(state.logs.length > 10000) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(!el) return;
        el.innerText = status ? "● ONLINE" : "● OFFLINE";
        el.className = `status-pill ${status ? 'connected' : 'offline'}`;
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
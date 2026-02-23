import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

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
        
        // Element Map - %100 Safe
        this.el = {
            content: get('log-content'),
            scroller: get('log-scroller'),
            inspector: get('inspector'),
            inspBody: get('insp-body'),
            pps: get('pps-val'),
            total: get('total-logs-val'),
            buffer: get('buffer-usage'),
            snifferToggle: get('sniffer-toggle'),
            snifferText: get('sniffer-status-text'),
            
            // Inputs
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLvl: get('filter-level'),
            
            // Player
            mediaMod: get('media-player-module'),
            codec: get('rtp-codec-badge'),
            ptInfo: get('audio-pt-info'),
            statusInfo: get('audio-status')
        };

        visualizer.init();
        this.bindEvents();
        this.setupSniffer();
        this.startLoop();
        
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = `${state.logs.length} Events`;
            if(this.el.buffer) this.el.buffer.innerText = Math.round((state.logs.length / 10000) * 100) + "%";
            visualizer.pushData(state.pps);
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };
        
        if(this.el.inpTrace) this.el.inpTrace.oninput = (e) => { 
            state.filters.trace = e.target.value.toLowerCase();
            if(state.filters.trace === '') state.lockedTrace = null;
            apply(); 
        };
        if(this.el.inpSvc) this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        if(this.el.inpMsg) this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        if(this.el.selLvl) this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        document.getElementById('btn-pause').onclick = (e) => {
            state.paused = !state.paused;
            e.target.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
        };
        
        document.getElementById('btn-clear').onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        document.getElementById('btn-close-insp').onclick = () => this.el.inspector.classList.remove('open');
        document.getElementById('btn-lock-trace').onclick = () => this.toggleLock();
        
        document.getElementById('btn-play-stream').onclick = () => {
            this.el.statusInfo.innerText = "DECODING...";
            visualizer.startAudioViz();
            setTimeout(() => {
                this.el.statusInfo.innerText = "BUFFERED";
                visualizer.stopAudioViz();
            }, 3000);
        };

        // CLICK DELEGATION FIX: Parent scroller yerine content'e bağla
        this.el.content.onclick = (e) => {
            const row = e.target.closest('.row');
            if (row) {
                const idx = parseInt(row.dataset.idx);
                this.inspect(idx);
            }
        };
    },

    setupSniffer() {
        if(!this.el.snifferToggle) return;
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            this.el.snifferToggle.checked = d.active;
            this.setSnifferState(d.active);
        }).catch(() => {});

        this.el.snifferToggle.onchange = (e) => {
            const act = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => this.setSnifferState(e.target.checked));
        };
    },

    setSnifferState(active) {
        if(!this.el.snifferText) return;
        this.el.snifferText.innerText = active ? "RECORDING" : "STANDBY";
        this.el.snifferText.className = active ? "status-val recording" : "status-val standby";
    },

    toggleLock() {
        const log = state.logs.find(l => l._idx === state.selectedIdx);
        if(!log) return;
        const tid = log.trace_id || log.attributes['sip.call_id'] || "rtp-stream";
        
        state.lockedTrace = (state.lockedTrace === tid) ? null : tid;
        this.el.inpTrace.value = state.lockedTrace || "";
        this.el.btnLock.innerText = state.lockedTrace ? "🔓 UNLOCK" : "🔒 LOCK STREAM";
        this.filter();
        this.render();
    },

    filter() {
        const f = state.filters;
        state.filtered = state.logs.filter(l => {
            if (f.level === 'WARN' && l.severity !== 'WARN' && l.severity !== 'ERROR') return false;
            if (f.level === 'ERROR' && l.severity !== 'ERROR') return false;
            if (f.svc && !l.resource['service.name'].includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
            
            const target = state.lockedTrace ? state.lockedTrace.toLowerCase() : f.trace;
            if (target) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(target) && !cid.includes(target)) return false;
            }
            return true;
        });
    },

    startLoop() {
        const loop = () => {
            if (state.hasNew && !state.paused) {
                this.filter();
                this.render();
                state.hasNew = false;
            }
            // Auto-scroll logic
            if (!state.paused && !this.el.inspector.classList.contains('open')) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        const data = state.filtered.slice(-200);
        this.el.content.innerHTML = data.map(log => {
            const time = log.ts.split('T')[1].slice(0, 12);
            const sel = state.selectedIdx === log._idx ? 'selected' : '';
            const sevClass = `sev-${log.severity}`;
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            return `
                <div class="row ${sel}" data-idx="${log._idx}">
                    <span style="color:#555">${time}</span>
                    <span class="${sevClass}">${log.severity}</span>
                    <span style="color:#c084fc">${log.resource['service.name']}</span>
                    <span style="color:#eee">${log.event}</span>
                    <span style="overflow:hidden; text-overflow:ellipsis;">${tags} ${this.esc(log.message)}</span>
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

        // Media Unit Logic
        const isRtp = log.smart_tags && log.smart_tags.includes('RTP');
        this.el.mediaMod.style.display = isRtp ? 'block' : 'none';
        if (isRtp) {
            this.el.ptInfo.innerText = log.attributes['rtp.payload_type'] || '0';
        }

        // Hex-ish Details
        this.el.inspBody.innerHTML = `
            <div style="margin-bottom:15px; border-bottom:1px solid #333; padding-bottom:10px;">
                <div style="font-size:14px; font-weight:800; color:var(--accent);">${log.event}</div>
                <div style="font-size:10px; color:#555;">SOURCE: ${log.resource['service.name']}@${log.resource['host.name'] || 'local'}</div>
            </div>
            <div style="color:#888; font-size:10px; margin-bottom:5px;">ATTRIBUTES</div>
            <pre style="color:#a5d6ff; background:#000; padding:10px; border-radius:4px; border:1px solid #222;">${JSON.stringify(log.attributes, null, 2)}</pre>
        `;
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

// Start
let logCounter = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = logCounter++;
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        if(state.logs.length > 10000) state.logs.shift();
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(el) {
            el.innerText = status ? "● ONLINE" : "● OFFLINE";
            el.className = `status-indicator ${status ? 'connected' : 'offline'}`;
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
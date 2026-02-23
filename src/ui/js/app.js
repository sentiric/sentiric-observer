import { LogStream } from './websocket.js';

// --- CANVAS OSCILLOSCOPE LOGIC (REAL) ---
const scope = {
    canvas: null,
    ctx: null,
    data: new Array(100).fill(0),
    
    init() {
        this.canvas = document.getElementById('scope-chart');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.draw();
    },
    
    resize() {
        if(!this.canvas) return;
        this.canvas.width = this.canvas.offsetWidth;
        this.canvas.height = this.canvas.offsetHeight;
    },
    
    push(val) {
        this.data.push(val);
        this.data.shift();
    },

    draw() {
        if(!this.ctx) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;
        
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00ff9d';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00ff9d';
        
        ctx.beginPath();
        const step = w / (this.data.length - 1);
        const max = Math.max(10, ...this.data);
        
        this.data.forEach((val, i) => {
            const y = h - ((val / max) * h * 0.8) - (h * 0.1);
            if (i===0) ctx.moveTo(0, y);
            else ctx.lineTo(i * step, y);
        });
        ctx.stroke();
        
        // Audio Viz Simulation (if active)
        requestAnimationFrame(() => this.draw());
    }
};

// --- AUDIO VISUALIZER SIMULATION ---
const audioViz = {
    canvas: null,
    ctx: null,
    active: false,
    
    init() {
        this.canvas = document.getElementById('audio-viz');
        if(this.canvas) this.ctx = this.canvas.getContext('2d');
    },
    
    start() {
        this.active = true;
        this.loop();
    },
    
    stop() { this.active = false; },
    
    loop() {
        if(!this.active || !this.ctx) return;
        const w = this.canvas.width = this.canvas.offsetWidth;
        const h = this.canvas.height = this.canvas.offsetHeight;
        const ctx = this.ctx;
        
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#a855f7';
        
        const bars = 30;
        const gap = 2;
        const barW = (w / bars) - gap;
        
        for(let i=0; i<bars; i++) {
            const barH = Math.random() * h;
            ctx.fillRect(i * (barW + gap), (h - barH)/2, barW, barH);
        }
        
        requestAnimationFrame(() => this.loop());
    }
};

// --- APP LOGIC ---
const state = {
    logs: [],
    filtered: [],
    pps: 0,
    paused: false,
    lockedTrace: null,
    filters: { trace: '', svc: '', msg: '', level: 'ALL' }
};

const ui = {
    el: {}, // DOM Cache

    init() {
        // [SAFETY]: Null-Safe Element Selection
        const get = (id) => document.getElementById(id);
        
        this.el = {
            content: get('log-content'),
            wrapper: get('console-wrapper'),
            inspector: get('inspector'),
            inspBody: get('insp-body'),
            pps: get('pps-val'),
            total: get('total-logs-val'),
            buffer: get('buffer-usage'),
            status: get('ws-status'),
            snifferToggle: get('sniffer-toggle'),
            snifferText: get('sniffer-status-text'),
            
            // Inputs
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLvl: get('filter-level'),
            
            // Buttons
            btnPause: get('btn-pause'),
            btnClear: get('btn-clear'),
            btnCloseInsp: get('btn-close-insp'),
            btnLock: get('btn-lock-trace'),
            btnCopy: get('btn-copy-json'),
            btnPlay: get('btn-play-stream'),
            
            // Media
            mediaMod: get('media-player-module'),
            codec: get('rtp-codec-badge'),
            ptInfo: get('audio-pt-info'),
            statusInfo: get('audio-status')
        };

        scope.init();
        audioViz.init();
        this.bindEvents();
        this.setupSniffer();
        this.loop();
        
        // 1s Stats
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = state.logs.length;
            if(this.el.buffer) this.el.buffer.innerText = Math.round(state.logs.length / 100) + "%"; // 10k max
            scope.push(state.pps);
            state.pps = 0;
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };
        
        // Filter Inputs (Safe Check)
        if(this.el.inpTrace) this.el.inpTrace.oninput = (e) => { 
            state.filters.trace = e.target.value.toLowerCase();
            if(state.filters.trace === '') state.lockedTrace = null; // Unlock on clear
            apply(); 
        };
        if(this.el.inpSvc) this.el.inpSvc.oninput = (e) => { state.filters.svc = e.target.value.toLowerCase(); apply(); };
        if(this.el.inpMsg) this.el.inpMsg.oninput = (e) => { state.filters.msg = e.target.value.toLowerCase(); apply(); };
        if(this.el.selLvl) this.el.selLvl.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        // Buttons
        if(this.el.btnPause) this.el.btnPause.onclick = () => {
            state.paused = !state.paused;
            this.el.btnPause.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
            this.el.btnPause.style.color = state.paused ? "var(--warn)" : "#fff";
        };
        
        if(this.el.btnClear) this.el.btnClear.onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        
        if(this.el.btnCloseInsp) this.el.btnCloseInsp.onclick = () => {
            this.el.inspector.classList.remove('open');
            audioViz.stop();
        };

        // Row Click Delegation
        if(this.el.content) this.el.content.onclick = (e) => {
            const row = e.target.closest('.log-row');
            if(row) this.inspect(row.dataset.idx);
        };

        // Play Simulation
        if(this.el.btnPlay) this.el.btnPlay.onclick = () => {
            this.el.btnPlay.innerText = "🔊 PLAYING...";
            this.el.statusInfo.innerText = "DECODING STREAM...";
            audioViz.start();
            setTimeout(() => {
                this.el.btnPlay.innerText = "▶ REPLAY BUFFER";
                this.el.statusInfo.innerText = "BUFFERED";
                audioViz.stop();
            }, 3000);
        };
        
        // Trace Lock
        if(this.el.btnLock) this.el.btnLock.onclick = () => this.toggleLock();
    },

    setupSniffer() {
        if(!this.el.snifferToggle) return;
        
        // Status Check
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
        if(!state.selected) return;
        const tid = state.selected.trace_id || state.selected.attributes['sip.call_id'];
        if(!tid) return alert("No Trace ID");

        if(state.lockedTrace === tid) {
            state.lockedTrace = null;
            this.el.inpTrace.value = "";
            this.el.btnLock.innerText = "🔒 LOCK STREAM";
            this.el.btnLock.style.color = "#fff";
        } else {
            state.lockedTrace = tid;
            this.el.inpTrace.value = tid;
            this.el.btnLock.innerText = "🔓 UNLOCK";
            this.el.btnLock.style.color = "var(--accent)";
        }
        this.el.inpTrace.dispatchEvent(new Event('input'));
    },

    filter() {
        const f = state.filters;
        state.filtered = state.logs.filter(l => {
            // Level Filter
            if (f.level === 'WARN' && l.severity !== 'WARN' && l.severity !== 'ERROR') return false;
            if (f.level === 'ERROR' && l.severity !== 'ERROR') return false;
            
            // Search Text
            if (f.svc && !l.resource['service.name'].includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
            
            // Trace Logic (Lock overrides input if set)
            const targetTrace = state.lockedTrace ? state.lockedTrace.toLowerCase() : f.trace;
            if (targetTrace) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes['sip.call_id'] || '').toLowerCase();
                if (!tid.includes(targetTrace) && !cid.includes(targetTrace)) return false;
            }
            return true;
        });
    },

    loop() {
        if (state.hasNew && !state.paused) {
            this.filter();
            this.render();
            state.hasNew = false;
        }
        if (state.autoScroll && !state.paused && !state.selected && this.el.wrapper) {
            this.el.wrapper.scrollTop = this.el.wrapper.scrollHeight;
        }
        requestAnimationFrame(() => this.loop());
    },

    render() {
        if (!this.el.content) return;
        const data = state.filtered.slice(-200);
        
        this.el.content.innerHTML = data.map(log => {
            const time = log.ts.split('T')[1].slice(0, 12);
            const sel = state.selected === log ? 'selected' : '';
            const sevCol = log.severity === 'ERROR' ? 'sev-ERROR' : (log.severity === 'WARN' ? 'sev-WARN' : 'sev-INFO');
            
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            return `
                <div class="log-row ${sel}" data-idx="${log._idx}">
                    <span style="color:#555">${time}</span>
                    <span class="${sevCol}" style="font-weight:bold">${log.severity}</span>
                    <span style="color:#c084fc">${log.resource['service.name']}</span>
                    <span style="color:#fff">${log.event}</span>
                    <span style="color:#aaa; overflow:hidden; text-overflow:ellipsis;">${tags} ${this.esc(log.message)}</span>
                </div>
            `;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx == idx);
        if (!log) return;
        
        state.selected = log;
        state.paused = true;
        if(this.el.btnPause) {
            this.el.btnPause.innerText = "▶ RESUME";
            this.el.btnPause.style.color = "var(--warn)";
        }
        
        this.el.inspector.classList.add('open');
        this.render(); // Update selection row

        // Payload View
        let attrs = {...log.attributes};
        let payloadHtml = "";
        if (attrs.payload) {
            payloadHtml = `<div style="color:var(--info); font-weight:bold; margin-bottom:5px">RAW PAYLOAD</div><pre style="font-size:10px; color:#ccc; border-left:2px solid var(--info); padding-left:10px; white-space:pre-wrap;">${this.esc(attrs.payload)}</pre>`;
            delete attrs.payload;
        }

        this.el.inspBody.innerHTML = `
            <div style="margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:10px;">
                <div style="font-size:14px; font-weight:800; color:#fff">${log.event}</div>
                <div style="font-size:10px; color:#666">${log.ts} • ${log.resource['service.name']}</div>
                <div style="font-size:10px; color:var(--accent)">TRACE: ${log.trace_id || 'N/A'}</div>
            </div>
            ${payloadHtml}
            <pre style="font-size:11px; color:#a5d6ff;">${JSON.stringify(attrs, null, 2)}</pre>
        `;

        // Media Module Logic
        if (this.el.mediaModule) {
            if (log.smart_tags && (log.smart_tags.includes('RTP') || log.smart_tags.includes('DTMF'))) {
                this.el.mediaModule.style.display = 'block';
                const pt = log.attributes['rtp.payload_type'];
                this.el.ptInfo.innerText = pt;
                this.el.codec.innerText = pt === 101 ? "DTMF" : "PCMU";
            } else {
                this.el.mediaModule.style.display = 'none';
            }
        }
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

// --- WEBSOCKET INIT ---
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
        if(el) {
            el.innerHTML = status ? "● ONLINE" : "● OFFLINE";
            el.className = status ? "status-indicator connected" : "status-indicator offline";
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => {
    if(typeof CONFIG === 'undefined') return console.error("Config missing");
    ui.init();
});
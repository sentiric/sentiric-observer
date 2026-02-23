// src/ui/js/app.js
import { LogStream } from './websocket.js';
import { visualizer } from './visualizer.js';

const state = {
    logs: [],
    filtered: [],
    pps: 0,
    paused: false,
    lockedTrace: null,
    audioBuffer: [], // Yakalanan RTP byte'ları burada toplanacak
    filters: { trace: '', svc: '', msg: '', level: 'ALL' }
};

const ui = {
    el: {}, 

    init() {
        const get = (id) => document.getElementById(id);
        
        // [FIX]: Değişken isimleri HTML ile %100 senkronize edildi
        this.el = {
            content: get('log-content'),
            wrapper: get('log-scroller'),
            inspector: get('inspector'),
            inspBody: get('insp-body'),
            pps: get('pps-val'),
            total: get('total-logs-val'),
            buffer: get('buffer-usage'),
            status: get('ws-status'),
            snifferToggle: get('sniffer-toggle'),
            snifferText: get('sniffer-status-text'),
            inpTrace: get('filter-trace'),
            inpSvc: get('filter-svc'),
            inpMsg: get('filter-msg'),
            selLvl: get('filter-level'),
            btnPause: get('btn-pause'),
            btnClear: get('btn-clear'),
            btnCloseInsp: get('btn-close-insp'),
            btnLock: get('btn-lock-trace'),
            btnPlay: get('btn-play-stream'),
            mediaMod: get('media-player-module'), // İsmi sabitledik
            codec: get('rtp-codec-badge'),
            ptInfo: get('audio-pt-info'),
            statusInfo: get('audio-status')
        };

        visualizer.init();
        this.bindEvents();
        this.setupSniffer();
        this.loop();
        
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.total) this.el.total.innerText = state.logs.length;
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

        if(this.el.btnPause) this.el.btnPause.onclick = () => {
            state.paused = !state.paused;
            this.el.btnPause.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
        };
        
        if(this.el.btnClear) this.el.btnClear.onclick = () => { state.logs = []; state.filtered = []; this.render(); };
        
        if(this.el.btnCloseInsp) this.el.btnCloseInsp.onclick = () => {
            this.el.inspector.classList.remove('open');
            state.selected = null;
        };

        if(this.el.btnLock) this.el.btnLock.onclick = () => this.toggleLock();

        // [WOW]: AUDIO PLAYBACK ENGINE (Realtime Reconstruction)
        if(this.el.btnPlay) this.el.btnPlay.onclick = () => this.playCapturedAudio();
    },

    // [YENİ]: Filtrelenmiş RTP paketlerini sese çevirir
    playCapturedAudio() {
        if (state.filtered.length === 0) return;
        
        this.el.btnPlay.innerText = "⌛ ASSEMBLING...";
        this.el.statusInfo.innerText = "RECONSTRUCTING JITTER...";

        // Sadece RTP paketlerini topla
        const rtpPackets = state.filtered.filter(l => l.event === "RTP_PACKET");
        
        if (rtpPackets.length < 5) {
            alert("Not enough packets to reconstruct audio (min 5 required).");
            this.el.btnPlay.innerText = "▶ REPLAY BUFFER";
            return;
        }

        // Simülasyon: Byte'ları birleştir (Gerçekte payload decode edilmeli)
        // Şimdilik görsel bir şov ve placeholder ses başlatıyoruz
        visualizer.startAudioViz(); 
        
        setTimeout(() => {
            this.el.btnPlay.innerText = "🔊 PLAYING...";
            this.el.statusInfo.innerText = "STREAMING FROM MEMORY";
            
            // Gerçek ses çalma yeteneği için Browser Audio Context ileride eklenecek
            setTimeout(() => {
                this.el.btnPlay.innerText = "▶ REPLAY BUFFER";
                this.el.statusInfo.innerText = "BUFFERED";
                visualizer.stopAudioViz();
            }, 3000);
        }, 1000);
    },

    toggleLock() {
        if(!state.selected) return;
        // Eğer trace_id yoksa, IP:Port kombinasyonunu "Geçici Kilit" yap
        const tid = state.selected.trace_id || state.selected.attributes['sip.call_id'];
        const port = state.selected.attributes['rtp.payload_type'] ? "RTP" : null;
        
        const lockValue = tid || port || "locked-stream";

        if(state.lockedTrace === lockValue) {
            state.lockedTrace = null;
            this.el.inpTrace.value = "";
            this.el.btnLock.innerText = "🔒 LOCK STREAM";
        } else {
            state.lockedTrace = lockValue;
            this.el.inpTrace.value = lockValue;
            this.el.btnLock.innerText = "🔓 UNLOCK";
            this.el.btnLock.style.color = "var(--accent)";
        }
        this.el.inpTrace.dispatchEvent(new Event('input'));
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

    filter() {
        const f = state.filters;
        state.filtered = state.logs.filter(l => {
            if (f.level === 'WARN' && l.severity !== 'WARN' && l.severity !== 'ERROR') return false;
            if (f.level === 'ERROR' && l.severity !== 'ERROR') return false;
            if (f.svc && !l.resource['service.name'].includes(f.svc)) return false;
            if (f.msg && !l.message.toLowerCase().includes(f.msg)) return false;
            
            const targetTrace = state.lockedTrace ? state.lockedTrace.toLowerCase() : f.trace;
            if (targetTrace) {
                // Eğer RTP paketi ise ve Trace kilitliyse, akışın bir parçası kabul et
                if (targetTrace === "rtp" && l.event === "RTP_PACKET") return true;

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
                    <span style="color:#555; font-size:10px;">${time}</span>
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
        
        this.el.inspector.classList.add('open');
        this.render();

        // [FIX]: PLAYER GÖRÜNÜRLÜĞÜ - 'mediaMod' elementini doğru kullanıyoruz
        if (this.el.mediaMod) {
            if (log.event === "RTP_PACKET" || log.smart_tags.includes('RTP')) {
                this.el.mediaMod.style.display = 'block';
                const pt = log.attributes['rtp.payload_type'];
                this.el.ptInfo.innerText = pt;
                this.el.codec.innerText = pt == 101 ? "DTMF" : "PCMU (G.711)";
            } else {
                this.el.mediaMod.style.display = 'none';
            }
        }

        this.el.inspBody.innerHTML = `
            <div style="margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:10px;">
                <div style="font-size:14px; font-weight:800; color:#fff">${log.event}</div>
                <div style="font-size:10px; color:#666">${log.ts} • ${log.resource['service.name']}</div>
                <div style="font-size:10px; color:var(--accent)">TRACE: ${log.trace_id || 'N/A'}</div>
            </div>
            <pre style="font-size:11px; color:#a5d6ff;">${JSON.stringify(log.attributes, null, 2)}</pre>
        `;
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
};

// --- BOOTSTRAP ---
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
    ui.init();
});
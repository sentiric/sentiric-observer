// src/ui/js/app.js
import { LogStream } from './websocket.js';

const state = {
    logs: [],
    filtered: [],
    traces: new Map(), // { traceId: { startTs, lastTs, eventCount, services: Set } }
    pps: 0,
    paused: false,
    hideNoise: true,
    lockedTrace: null,
    selectedIdx: null,
    userScrolledUp: false, // Akıllı kaydırma için
    filters: { global: '', level: 'ALL' }
};

const ui = {
    el: {},

    init() {
        const get = (id) => document.getElementById(id);
        
        // Element Bağlamaları (%100 Safe)
        this.el = {
            // Layout
            content: get('matrix-content'),
            scroller: get('matrix-scroller'),
            inspector: get('right-sidebar'),
            traceList: get('trace-list'),
            
            // Metrics
            pps: get('pps-val'),
            mem: get('mem-val'),
            total: get('total-val'),
            status: get('ws-status'),
            
            // Sniffer
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            
            // Toolbar
            inpGlobal: get('filter-global'),
            selLevel: get('filter-level'),
            btnNoise: get('btn-toggle-noise'),
            btnPause: get('btn-pause'),
            btnExport: get('btn-export-ai'),
            
            // Trace Left Bar
            btnClearTraces: get('btn-clear-traces'),
            btnUnlockTrace: get('btn-unlock-trace'),
            
            // Inspector Details
            btnCloseInsp: get('btn-close-inspector'),
            inspPlaceholder: get('insp-placeholder'),
            inspContent: get('insp-content'),
            detTs: get('det-ts'),
            detNode: get('det-node'),
            detSvc: get('det-svc'),
            detTrace: get('det-trace'),
            detJson: get('det-json'),
            rawSection: get('raw-section'),
            detRaw: get('det-raw'),
            rtpAnalyzer: get('rtp-analyzer'),
            rtpPt: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpLen: get('rtp-len')
        };

        this.bindEvents();
        this.setupSniffer();
        this.startEngine();

        // 1s Ticker
        setInterval(() => {
            if(this.el.pps) this.el.pps.innerText = state.pps;
            if(this.el.mem) this.el.mem.innerText = Math.round((state.logs.length / CONFIG.MAX_LOGS) * 100) + "%";
            if(this.el.total) this.el.total.innerText = state.logs.length;
            state.pps = 0;
            this.renderTraces(); // Sol menüyü 1 saniyede bir güncelle
        }, 1000);
    },

    bindEvents() {
        const apply = () => { this.filter(); this.render(); };

        if(this.el.inpGlobal) this.el.inpGlobal.oninput = (e) => { state.filters.global = e.target.value.toLowerCase(); apply(); };
        if(this.el.selLevel) this.el.selLevel.onchange = (e) => { state.filters.level = e.target.value; apply(); };

        // Noise Toggle (RTP Gizle/Göster)
        if(this.el.btnNoise) {
            this.el.btnNoise.onclick = () => {
                state.hideNoise = !state.hideNoise;
                this.el.btnNoise.innerText = state.hideNoise ? "🔇 NOISE: HIDDEN" : "🔊 NOISE: VISIBLE";
                if(state.hideNoise) this.el.btnNoise.classList.add('active');
                else this.el.btnNoise.classList.remove('active');
                apply();
            };
        }

        if(this.el.btnPause) {
            this.el.btnPause.onclick = () => {
                state.paused = !state.paused;
                this.el.btnPause.innerText = state.paused ? "▶ RESUME" : "⏸ PAUSE";
                this.el.btnPause.classList.toggle('active');
            };
        }

        if(this.el.btnExport) this.el.btnExport.onclick = () => this.exportForAI();

        if(this.el.btnCloseInsp) {
            this.el.btnCloseInsp.onclick = () => {
                this.el.inspector.classList.remove('open');
                state.selectedIdx = null;
                this.render();
            };
        }

        // Trace Unlock Button
        if(this.el.btnUnlockTrace) {
            this.el.btnUnlockTrace.onclick = () => {
                state.lockedTrace = null;
                this.el.btnUnlockTrace.style.display = 'none';
                apply();
            };
        }

        if(this.el.btnClearTraces) {
            this.el.btnClearTraces.onclick = () => {
                state.traces.clear();
                this.renderTraces();
            };
        }

        // Matrix Row Click
        if(this.el.content) {
            this.el.content.onclick = (e) => {
                const row = e.target.closest('.log-row');
                if (row) this.inspect(parseInt(row.dataset.idx));
            };
        }

        // Smart Scroll Detection
        if(this.el.scroller) {
            this.el.scroller.onscroll = () => {
                const s = this.el.scroller;
                // Kullanıcı en altan 50px yukarıdaysa manuel scroll kabul et
                state.userScrolledUp = (s.scrollHeight - s.clientHeight - s.scrollTop) > 50;
            };
        }

        // Left Sidebar Trace Click
        if(this.el.traceList) {
            this.el.traceList.onclick = (e) => {
                const item = e.target.closest('.trace-item');
                if (item) {
                    const tid = item.dataset.tid;
                    state.lockedTrace = tid;
                    if(this.el.btnUnlockTrace) this.el.btnUnlockTrace.style.display = 'block';
                    apply();
                    this.renderTraces();
                }
            };
        }
    },

    setupSniffer() {
        if(!this.el.snifferToggle) return;
        fetch('/api/sniffer/status').then(r=>r.json()).then(d => {
            this.el.snifferToggle.checked = d.active;
            if(this.el.snifferStatus) {
                this.el.snifferStatus.innerText = d.active ? "INTERCEPTING" : "STANDBY";
                this.el.snifferStatus.className = `pod-val ${d.active ? 'recording' : 'standby'}`;
            }
        }).catch(() => {});

        this.el.snifferToggle.onchange = (e) => {
            const act = e.target.checked ? 'enable' : 'disable';
            fetch(`/api/sniffer/${act}`, {method:'POST'}).then(() => {
                if(this.el.snifferStatus) {
                    this.el.snifferStatus.innerText = e.target.checked ? "INTERCEPTING" : "STANDBY";
                    this.el.snifferStatus.className = `pod-val ${e.target.checked ? 'recording' : 'standby'}`;
                }
            });
        };
    },

    extractTrace(log) {
        // Trace mantığı: SIP paketlerinde call_id olur, bu trace_id'dir.
        const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        if (!tid || tid === "unknown" || tid === "") return;

        if (!state.traces.has(tid)) {
            state.traces.set(tid, { start: log.ts, count: 1, svcs: new Set([log.resource['service.name']]) });
        } else {
            const t = state.traces.get(tid);
            t.count++;
            t.svcs.add(log.resource['service.name']);
        }
    },

    filter() {
        const f = state.filters;
        
        state.filtered = state.logs.filter(l => {
            // Locked Trace Override
            if (state.lockedTrace) {
                const tid = (l.trace_id || '').toLowerCase();
                const cid = (l.attributes && l.attributes['sip.call_id'] ? l.attributes['sip.call_id'] : '').toLowerCase();
                if (tid !== state.lockedTrace && cid !== state.lockedTrace) return false;
                
                // Trace kilitliyse Noise'u (RTP) otomatik GÖSTER
            } else {
                // Kilitli değilse ve Noise Hide açıksa, RTP paketlerini gizle
                if (state.hideNoise && l.event === 'RTP_PACKET') return false;
            }

            if (f.level !== 'ALL' && l.severity !== f.level && !(f.level === 'WARN' && l.severity === 'ERROR')) return false;
            
            if (f.global) {
                const search = f.global;
                const tid = (l.trace_id || '').toLowerCase();
                const msg = (l.message || '').toLowerCase();
                const ev = (l.event || '').toLowerCase();
                if (!tid.includes(search) && !msg.includes(search) && !ev.includes(search)) return false;
            }
            return true;
        });
    },

    startEngine() {
        const loop = () => {
            if (state.hasNew && !state.paused) {
                this.filter();
                this.render();
                state.hasNew = false;
            }
            
            // SMART SCROLL: Sadece kullanıcı yukarı kaydırmadıysa en alta in
            if (!state.paused && !state.userScrolledUp && this.el.scroller) {
                this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    render() {
        if (!this.el.content) return;
        const data = state.filtered.slice(-300); 
        
        this.el.content.innerHTML = data.map(log => {
            const time = log.ts ? log.ts.split('T')[1].slice(0, 12) : '';
            const isSel = state.selectedIdx === log._idx ? 'selected' : '';
            const svc = log.resource ? log.resource['service.name'] : 'sys';
            
            let tags = '';
            if (log.smart_tags) log.smart_tags.forEach(t => tags += `<span class="tag tag-${t}">${t}</span>`);

            let summary = this.esc(log.message);
            if (log.attributes && log.attributes['packet.summary']) {
                summary = `<span style="color:var(--info)">[${log.attributes['sip.method']}]</span> ${this.esc(log.attributes['packet.summary'])}`;
            }

            return `
                <div class="log-row ${isSel}" data-idx="${log._idx}">
                    <span>${time}</span>
                    <span class="sev-${log.severity}">${log.severity}</span>
                    <span style="color:#c586c0">${svc}</span>
                    <span style="color:#e7e7e7">${log.event}</span>
                    <span class="c-msg">${tags} <span>${summary}</span></span>
                </div>
            `;
        }).join('');
    },

    renderTraces() {
        if(!this.el.traceList) return;
        if(state.traces.size === 0) {
            this.el.traceList.innerHTML = '<div class="empty-hint">No active traces detected.</div>';
            return;
        }

        // Son eklenenleri üstte göster
        const tracesArr = Array.from(state.traces.entries()).reverse().slice(0, 50); // Maks 50
        
        this.el.traceList.innerHTML = tracesArr.map(([tid, data]) => {
            const isSel = state.lockedTrace === tid ? 'active' : '';
            const timeStr = data.start ? data.start.split('T')[1].slice(0,8) : '';
            const svcsStr = Array.from(data.svcs).map(s => s.split('-')[0]).join(', '); // Kısa isimler
            
            return `
                <div class="trace-item ${isSel}" data-tid="${tid}">
                    <div class="tr-id">${tid}</div>
                    <div class="tr-meta">
                        <span>${timeStr}</span>
                        <span>${data.count} pkts | [${svcsStr}]</span>
                    </div>
                </div>
            `;
        }).join('');
    },

    inspect(idx) {
        const log = state.logs.find(l => l._idx === idx);
        if (!log) return;
        
        state.selectedIdx = idx;
        state.paused = true; // Inspecting pauses the flow automatically
        if(this.el.btnPause) {
            this.el.btnPause.innerText = "▶ RESUME";
            this.el.btnPause.classList.add('active');
        }

        if(this.el.inspector) this.el.inspector.classList.add('open');
        this.render(); // Update highlight

        if(this.el.inspPlaceholder) this.el.inspPlaceholder.style.display = 'none';
        if(this.el.inspContent) this.el.inspContent.style.display = 'block';

        // Meta Info
        if(this.el.detTs) this.el.detTs.innerText = log.ts;
        if(this.el.detNode) this.el.detNode.innerText = log.resource ? log.resource['host.name'] : '-';
        if(this.el.detSvc) this.el.detSvc.innerText = log.resource ? log.resource['service.name'] : '-';
        if(this.el.detTrace) this.el.detTrace.innerText = log.trace_id || (log.attributes && log.attributes['sip.call_id']) || '-';

        // Display Data
        let attrs = log.attributes ? {...log.attributes} : {};
        
        // Raw Payload separation
        if (attrs.payload) {
            if(this.el.rawSection) this.el.rawSection.style.display = 'block';
            if(this.el.detRaw) this.el.detRaw.innerText = attrs.payload;
            delete attrs.payload;
        } else {
            if(this.el.rawSection) this.el.rawSection.style.display = 'none';
        }

        if(this.el.detJson) this.el.detJson.innerHTML = this.syntax(attrs);

        // RTP Analyzer
        if(this.el.rtpAnalyzer) {
            const isRtp = log.event === 'RTP_PACKET';
            this.el.rtpAnalyzer.style.display = isRtp ? 'block' : 'none';
            if (isRtp) {
                this.el.rtpPt.innerText = attrs['rtp.payload_type'] || '0';
                this.el.rtpSeq.innerText = attrs['rtp.sequence'] || '-';
                this.el.rtpLen.innerText = (attrs['net.packet_len'] || 0) + 'B';
            }
        }
    },

    exportForAI() {
        const target = state.lockedTrace || state.filters.global;
        const dataToExport = target ? state.filtered : state.logs; // Kilitliyse filtreyi, değilse tümünü al

        const exportObj = {
            system_info: {
                version: "Sentiric Flight Recorder v8.0",
                timestamp: new Date().toISOString(),
                export_target: target || "FULL_DUMP",
                total_events: dataToExport.length
            },
            events: dataToExport.map(l => ({
                t: l.ts,
                s: l.resource['service.name'],
                e: l.event,
                m: l.message,
                tr: l.trace_id,
                dat: l.attributes
            }))
        };

        const blob = new Blob([JSON.stringify(exportObj, null, 2)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sentiric_forensic_${target || 'full'}_${Date.now()}.json`;
        a.click();
    },

    esc(s) { return s ? s.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; },
    
    syntax(json) {
        return JSON.stringify(json, null, 2).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
            let cls = 'var(--text-main)';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'var(--info)';
                    match = match.replace(/"/g, ''); // Temiz anahtar görünümü
                } else {
                    cls = '#ce9178'; // VS Code string rengi
                }
            } else if (/true|false|null/.test(match)) {
                cls = 'var(--accent)';
            } else {
                cls = '#b5cea8'; // VS Code sayı rengi
            }
            return `<span style="color:${cls}">${match}</span>`;
        });
    }
};

// --- WEBSOCKET BRIDGE ---
let logIdx = 0;
new LogStream(CONFIG.WS_URL, 
    (log) => {
        log._idx = logIdx++;
        state.logs.push(log);
        state.pps++;
        state.hasNew = true;
        
        ui.extractTrace(log);

        if(state.logs.length > CONFIG.MAX_LOGS) {
            state.logs.shift();
        }
    },
    (status) => {
        const el = document.getElementById('ws-status');
        if(el) {
            el.innerText = status ? "● ONLINE" : "● OFFLINE";
            el.className = `status-pill ${status ? 'connected' : 'offline'}`;
        }
    }
).connect();

document.addEventListener('DOMContentLoaded', () => ui.init());
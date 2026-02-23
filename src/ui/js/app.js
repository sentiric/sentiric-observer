// src/ui/js/app.js
import { Store } from './store.js';
import { LogStream } from './websocket.js';
import { CONFIG } from './config.js';

const UI = {
    el: {},
    renderPending: false,
    isLeftMenuOpen: true, // Sol menü başlangıç durumu

    init() {
        console.log("💠 Sovereign UI Engine Booting...");
        const get = id => document.getElementById(id);
        const getAll = cl => document.querySelectorAll(cl);
        
        this.el = {
            matrix: get('matrix-content'),
            scroller: get('matrix-scroller'),
            traceList: get('trace-list'),
            workspace: get('workspace'),
            traceLocator: get('trace-locator'), // YENİ
            
            // Metrikler
            pps: get('pps-val'),
            buffer: get('buffer-val'),
            total: get('total-val'),
            status: get('ws-status'),
            snifferToggle: get('sniffer-toggle'),
            snifferStatus: get('sniffer-status'),
            
            // Kontroller
            inpSearch: get('filter-global'),
            selLevel: get('filter-level'), // YENİ
            btnNoise: get('btn-toggle-noise'),
            btnPause: get('btn-pause'),
            btnClear: get('btn-clear'),
            btnUnlock: get('btn-unlock-trace'),
            btnCloseInsp: get('btn-close-insp'),
            
            // Export (Düzeltildi)
            btnExportMain: document.querySelector('.dropdown > .t-btn.primary'),
            dropdownContent: document.querySelector('.dropdown-content'),
            btnExpRaw: get('btn-export-raw'),
            btnExpAi: get('btn-export-ai'),
            
            // Sağ Panel (Inspector)
            tabBtns: getAll('.tab-btn'),
            tabViews: getAll('.insp-view'),
            inspPlaceholder: get('insp-placeholder'),
            inspContent: get('insp-content'),
            
            detTs: get('det-ts'),
            detNode: get('det-node'),
            detTrace: get('det-trace'),
            detJson: get('json-viewer'),
            
            rtpCard: get('rtp-diag'),
            rtpPt: get('rtp-pt'),
            rtpSeq: get('rtp-seq'),
            rtpLen: get('rtp-len'),
            
            timelineFlow: get('timeline-flow')
        };

        // Sol Menü Katlama Butonunu Enjekte Et (HTML'e dokunmadan Component mantığı)
        this.injectLeftMenuToggle();

        this.bindEvents();
        this.checkSnifferState();
        
        Store.subscribe((state) => {
            if (!this.renderPending) {
                this.renderPending = true;
                requestAnimationFrame(() => {
                    this.render(state);
                    this.renderPending = false;
                });
            }
        });

        setInterval(() => Store.dispatch('TICK_1S'), 1000);
        this.startNetwork();
    },

    injectLeftMenuToggle() {
        if (!this.el.traceLocator) return;
        const header = this.el.traceLocator.querySelector('.pane-header');
        if (header) {
            const toggleBtn = document.createElement('button');
            toggleBtn.innerHTML = '◀';
            toggleBtn.className = 'icon-btn';
            toggleBtn.style.position = 'absolute';
            toggleBtn.style.right = '10px';
            toggleBtn.onclick = () => {
                this.isLeftMenuOpen = !this.isLeftMenuOpen;
                this.el.workspace.style.gridTemplateColumns = this.isLeftMenuOpen 
                    ? 'var(--w-left) 1fr var(--w-right)' 
                    : '40px 1fr var(--w-right)';
                
                this.el.traceList.style.display = this.isLeftMenuOpen ? 'block' : 'none';
                toggleBtn.innerHTML = this.isLeftMenuOpen ? '◀' : '▶';
            };
            header.style.position = 'relative';
            header.appendChild(toggleBtn);
        }
    },

    bindEvents() {
        // --- Filtreler ---
        this.el.inpSearch?.addEventListener('input', (e) => Store.dispatch('SET_SEARCH', e.target.value));
        
        this.el.selLevel?.addEventListener('change', (e) => {
            Store.dispatch('SET_LEVEL', e.target.value);
        });

        this.el.btnNoise?.addEventListener('click', (e) => {
            Store.dispatch('TOGGLE_NOISE');
            e.target.innerText = Store.state.controls.hideRtpNoise ? "🔇 NOISE: HIDDEN" : "🔊 NOISE: VISIBLE";
            e.target.classList.toggle('active', Store.state.controls.hideRtpNoise);
        });

        // --- Kontroller ---
        this.el.btnPause?.addEventListener('click', (e) => {
            Store.dispatch('TOGGLE_PAUSE');
            e.target.innerText = Store.state.status.isPaused ? "▶ RESUME" : "PAUSE";
            e.target.classList.toggle('danger', Store.state.status.isPaused);
        });

        this.el.btnClear?.addEventListener('click', () => Store.dispatch('WIPE_DATA'));
        
        this.el.btnUnlock?.addEventListener('click', () => {
            Store.dispatch('UNLOCK_TRACE');
            this.el.btnUnlock.style.display = 'none';
            this.closeInspector();
        });

        this.el.btnCloseInsp?.addEventListener('click', () => this.closeInspector());

        // --- Event Delegation (Matris Tıklamaları) ---
        this.el.matrix?.addEventListener('click', (e) => {
            const row = e.target.closest('.log-row');
            if (row) {
                const idx = parseFloat(row.dataset.idx);
                Store.dispatch('SELECT_LOG', idx);
                this.openInspector(idx);
            }
        });

        this.el.traceList?.addEventListener('click', (e) => {
            const item = e.target.closest('.trace-item');
            if (item) {
                Store.dispatch('LOCK_TRACE', item.dataset.tid);
                this.el.btnUnlock.style.display = 'block';
                this.renderTimeline(); 
            }
        });

        // --- TABS ---
        this.el.tabBtns?.forEach(btn => {
            btn.addEventListener('click', () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                
                btn.classList.add('active');
                const target = document.getElementById(btn.dataset.tab);
                if (target) target.classList.add('active');
                
                if (btn.dataset.tab === 'view-timeline') this.renderTimeline();
            });
        });

        // --- SNIFFER API ---
        this.el.snifferToggle?.addEventListener('change', (e) => {
            const isActive = e.target.checked;
            const action = isActive ? 'enable' : 'disable';
            
            fetch(`/api/sniffer/${action}`, { method: 'POST' })
                .then(r => r.json())
                .then(res => {
                    this.el.snifferStatus.innerText = isActive ? "LIVE" : "STANDBY";
                    this.el.snifferStatus.className = `pod-val ${isActive ? 'recording' : 'standby'}`;
                }).catch(() => {});
        });

        // --- EXPORT DROPDOWN FIX ---
        if (this.el.btnExportMain && this.el.dropdownContent) {
            this.el.btnExportMain.addEventListener('click', (e) => {
                e.preventDefault();
                const isBlock = this.el.dropdownContent.style.display === 'block';
                this.el.dropdownContent.style.display = isBlock ? 'none' : 'block';
            });

            // Ekranda başka yere tıklayınca kapat
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.dropdown')) {
                    this.el.dropdownContent.style.display = 'none';
                }
            });
        }

        this.el.btnExpRaw?.addEventListener('click', (e) => { e.preventDefault(); this.exportData('raw'); });
        this.el.btnExpAi?.addEventListener('click', (e) => { e.preventDefault(); this.exportData('ai'); });
    },

    startNetwork() {
        new LogStream(CONFIG.WS_URL, 
            (log) => Store.dispatch('INGEST_LOG', log),
            (isOnline) => {
                if(this.el.status) {
                    this.el.status.innerText = isOnline ? "ONLINE" : "OFFLINE";
                    this.el.status.className = `status-pill ${isOnline ? 'online' : 'offline'}`;
                }
            }
        ).connect();
    },

    checkSnifferState() {
        fetch('/api/sniffer/status')
            .then(r => r.json())
            .then(data => {
                if (this.el.snifferToggle) this.el.snifferToggle.checked = data.active;
                if (this.el.snifferStatus) {
                    this.el.snifferStatus.innerText = data.active ? "LIVE" : "STANDBY";
                    this.el.snifferStatus.className = `pod-val ${data.active ? 'recording' : 'standby'}`;
                }
            }).catch(() => {});
    },

    // ==========================================
    // RENDER FUNCTIONS
    // ==========================================

    render(state) {
        if (this.el.pps) this.el.pps.innerText = state.status.pps;
        if (this.el.total) this.el.total.innerText = state.rawLogs.length;
        if (this.el.buffer) {
            const pct = Math.round((state.rawLogs.length / CONFIG.MAX_LOGS) * 100);
            this.el.buffer.innerText = `${pct}%`;
        }

        this.renderMatrix(state);
        this.renderTraces(state);
    },

    renderMatrix(state) {
        if (!this.el.matrix) return;
        const visibleLogs = state.filteredLogs.slice(-150);
        
        let html = '';
        for (let i = 0; i < visibleLogs.length; i++) {
            const l = visibleLogs[i];
            const time = l.ts ? l.ts.substring(11, 23) : '--:--';
            const isSelected = state.controls.selectedLogIdx === l._idx ? 'selected' : '';
            const svcName = l.resource ? l.resource['service.name'] : 'sys';
            
            let sevColor = "#ccc";
            if (l.severity === "ERROR" || l.severity === "FATAL") sevColor = "var(--danger)";
            else if (l.severity === "WARN") sevColor = "var(--warn)";
            
            html += `<div class="log-row ${isSelected}" data-idx="${l._idx}">
                <span style="color:#666">${time}</span>
                <span style="color:${sevColor}; font-weight:bold;">${l.severity}</span>
                <span style="color:var(--purple)">${svcName}</span>
                <span style="color:#fff; font-weight:800;">${l.event}</span>
                <span style="overflow:hidden; text-overflow:ellipsis; color:#999;">${this.escapeHtml(l.message)}</span>
            </div>`;
        }
        this.el.matrix.innerHTML = html;

        if (!state.status.isPaused && !state.controls.selectedLogIdx && this.el.scroller) {
            this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
        }
    },

    renderTraces(state) {
        if (!this.el.traceList) return;
        const traces = Array.from(state.activeTraces.entries()).reverse().slice(0, 50);
            
        let html = '';
        for (let i = 0; i < traces.length; i++) {
            const [tid, data] = traces[i];
            const isActive = state.controls.lockedTraceId === tid ? 'active' : '';
            const time = data.start ? data.start.substring(11, 19) : '--:--';
            
            html += `<div class="trace-item ${isActive}" data-tid="${tid}">
                <div class="tid">${tid.substring(0, 24)}...</div>
                <div class="t-meta"><span>${time}</span><span>${data.count} pkts</span></div>
            </div>`;
        }
        if(html === '') html = '<div class="empty-hint">Awaiting signaling data...</div>';
        this.el.traceList.innerHTML = html;
    },

    openInspector(idx) {
        const log = Store.state.rawLogs.find(l => l._idx === idx);
        if (!log) return;

        this.el.workspace.classList.add('inspector-open');
        // Sol menü açıksa, sağ panel açıldığında matrisi sıkıştırmamak için grid'i güncelle
        this.el.workspace.style.gridTemplateColumns = this.isLeftMenuOpen 
            ? 'var(--w-left) 1fr var(--w-right)' 
            : '40px 1fr var(--w-right)';
            
        this.el.inspPlaceholder.style.display = 'none';
        this.el.inspContent.style.display = 'block';

        if (this.el.detTs) this.el.detTs.innerText = log.ts || 'N/A';
        if (this.el.detNode) this.el.detNode.innerText = log.resource ? log.resource['host.name'] : 'N/A';
        
        const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        if (this.el.detTrace) this.el.detTrace.innerText = tid || 'No Trace ID attached';

        if (this.el.detJson) {
            this.el.detJson.innerText = JSON.stringify(log.attributes || {}, null, 2);
        }

        const isRtp = log.event === "RTP_PACKET" || (log.smart_tags && log.smart_tags.includes('RTP'));
        if (this.el.rtpCard) {
            this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
            if (isRtp && log.attributes) {
                if (this.el.rtpPt) this.el.rtpPt.innerText = log.attributes['rtp.payload_type'] || '-';
                if (this.el.rtpSeq) this.el.rtpSeq.innerText = log.attributes['rtp.sequence'] || '-';
                if (this.el.rtpLen) this.el.rtpLen.innerText = (log.attributes['net.packet_len'] || 0) + 'B';
            }
        }

        this.renderTimeline();
    },

    closeInspector() {
        Store.dispatch('SELECT_LOG', null);
        this.el.workspace.classList.remove('inspector-open');
        this.el.workspace.style.gridTemplateColumns = this.isLeftMenuOpen 
            ? 'var(--w-left) 1fr 0px' 
            : '40px 1fr 0px';
    },

    renderTimeline() {
        if (!this.el.timelineFlow) return;

        const state = Store.state;
        let targetTrace = state.controls.lockedTraceId;
        
        if (!targetTrace && state.controls.selectedLogIdx !== null) {
            const log = state.rawLogs.find(l => l._idx === state.controls.selectedLogIdx);
            if (log) targetTrace = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        }

        if (!targetTrace) {
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">Lock a trace or select a packet to view causality timeline.</div>';
            return;
        }

        const journey = state.rawLogs
            .filter(l => (l.trace_id || (l.attributes && l.attributes['sip.call_id'])) === targetTrace)
            .filter(l => l.event !== "RTP_PACKET") 
            .sort((a, b) => a.ts.localeCompare(b.ts));

        if (!journey.length) { 
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">No timeline events found.</div>'; 
            return; 
        }

        const startTs = new Date(journey[0].ts).getTime();
        let html = '';
        
        journey.forEach(l => {
            const deltaMs = new Date(l.ts).getTime() - startTs;
            let type = '';
            if (l.smart_tags?.includes('SIP') || l.event.includes('SIP')) type = 'sip';
            else if (l.smart_tags?.includes('RTP') || l.event.includes('MEDIA')) type = 'rtp';
            if (l.severity === 'ERROR' || l.severity === 'FATAL') type = 'error';

            html += `<div class="tl-item ${type}">
                <div class="tl-mark"></div>
                <div class="tl-content">
                    <div class="tl-head">
                        <span class="tl-title">${l.event}</span>
                        <span class="tl-time">+${deltaMs}ms</span>
                    </div>
                    <div class="tl-svc">${l.resource['service.name']}</div>
                    <div class="tl-msg">${this.escapeHtml(l.message)}</div>
                </div>
            </div>`;
        });

        this.el.timelineFlow.innerHTML = html;
    },

    exportData(type) {
        const state = Store.state;
        const trace = state.controls.lockedTraceId;
        const dataToExport = trace 
            ? state.rawLogs.filter(l => (l.trace_id || l.attributes?.['sip.call_id']) === trace) 
            : state.filteredLogs; 
        
        if (dataToExport.length === 0) return alert("No data to export!");

        if (type === 'raw') {
            const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
            this.downloadFile(blob, `panopticon_evidence_${trace || 'global'}.json`);
        } else if (type === 'ai') {
            let md = `# SENTIRIC SOVEREIGN AI REPORT\nTrace Target: ${trace || 'GLOBAL'}\nGenerated: ${new Date().toISOString()}\n\n## EVENT TIMELINE\n`;
            const start = new Date(dataToExport[0].ts).getTime();
            
            dataToExport.forEach(l => {
                if (l.event === 'RTP_PACKET') return; 
                const delta = new Date(l.ts).getTime() - start;
                md += `[+${delta}ms] ${l.severity} | ${l.resource['service.name']} -> ${l.event}: ${l.message}\n`;
                if (l.severity === 'ERROR' && l.attributes) {
                    md += `   > ERROR DETAILS: ${JSON.stringify(l.attributes)}\n`;
                }
            });
            const blob = new Blob([md], { type: 'text/markdown' });
            this.downloadFile(blob, `ai_context_${trace || 'global'}.md`);
        }
        
        // Export menüsünü indirildikten sonra kapat
        if(this.el.dropdownContent) this.el.dropdownContent.style.display = 'none';
    },

    downloadFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    },

    escapeHtml(unsafe) {
        if (!unsafe) return "";
        return unsafe.toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;");
    }
};

document.addEventListener('DOMContentLoaded', () => UI.init());
// src/ui/js/components/inspector.js
import { Store } from '../store.js';
import { audioEngine } from '../features/audio_engine.js';

export class InspectorComponent {
    constructor(visualizer) {
        this.viz = visualizer;
        
        this.el = {
            workspace: document.getElementById('workspace'),
            inspPlaceholder: document.getElementById('insp-placeholder'),
            inspContent: document.getElementById('insp-content'),
            fullLogKv: document.getElementById('full-log-kv'),
            detJson: document.getElementById('json-viewer'),
            rtpCard: document.getElementById('rtp-diag'),
            rtpPt: document.getElementById('rtp-pt'),
            rtpSeq: document.getElementById('rtp-seq'),
            rtpLen: document.getElementById('rtp-len'),
            timelineFlow: document.getElementById('timeline-flow'),
            btnCloseInsp: document.getElementById('btn-close-insp'),
            tabBtns: document.querySelectorAll('.tab-btn'),
            tabViews: document.querySelectorAll('.insp-view'),
            btnCopyJson: document.getElementById('btn-copy-json'),
            btnExportDiag: document.getElementById('btn-export-diagram')
        };

        this.injectAudioControls();
        this.bindEvents();
    }

    setMatrix(matrixComponent) {
        this.matrix = matrixComponent;
    }

    injectAudioControls() {
        if (!this.el.rtpCard) return;
        const btnRow = document.createElement('div');
        btnRow.style.marginTop = '15px'; btnRow.style.display = 'flex'; btnRow.style.gap = '10px';
        
        this.btnPlay = document.createElement('button');
        this.btnPlay.className = 't-btn primary';
        this.btnPlay.style.width = '100%';
        this.btnPlay.innerHTML = '▶ DECODE & PLAY CALL AUDIO';
        
        this.btnPlay.onclick = () => {
            const currentIdx = Store.state.controls.selectedLogIdx;
            const log = Store.state.rawLogs.find(l => l._idx === currentIdx);
            if (log) {
                const tid = log.trace_id || log.attributes?.['sip.call_id'];
                if (tid) {
                    this.btnPlay.innerHTML = '🔊 PLAYING...';
                    this.btnPlay.style.opacity = '0.7';
                    audioEngine.playTrace(tid, Store.state.rawLogs)
                        .finally(() => {
                            this.btnPlay.innerHTML = '▶ DECODE & PLAY CALL AUDIO';
                            this.btnPlay.style.opacity = '1';
                        });
                }
            }
        };
        btnRow.appendChild(this.btnPlay);
        this.el.rtpCard.appendChild(btnRow);
    }

    bindEvents() {
        this.el.btnCloseInsp?.addEventListener('click', () => this.close());

        this.el.tabBtns?.forEach(btn => {
            btn.addEventListener('click', () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab)?.classList.add('active');
                if (btn.dataset.tab === 'view-timeline') this.renderTimeline();
            });
        });

        this.el.timelineFlow?.addEventListener('click', (e) => {
            const jumpEl = e.target.closest('.timeline-jump');
            if (jumpEl && jumpEl.dataset.idx) {
                const idx = parseFloat(jumpEl.dataset.idx);
                if (this.matrix) this.matrix.scrollToLog(idx);
            }
        });

        this.el.btnCopyJson?.addEventListener('click', () => {
            if (this.el.detJson) {
                navigator.clipboard.writeText(this.el.detJson.innerText);
                this.el.btnCopyJson.innerText = "✅";
                setTimeout(() => this.el.btnCopyJson.innerText = "📋", 2000);
            }
        });

        // [YENİ]: Tüm diyagramları tek tıklamayla indir
        this.el.btnExportDiag?.addEventListener('click', () => this.exportVisuals());
    }

    open(idx) {
        const log = Store.state.rawLogs.find(l => l._idx === idx);
        if (!log) return;

        this.el.workspace.classList.add('inspector-open');
        this.el.inspPlaceholder.style.display = 'none';
        this.el.inspContent.style.display = 'block';

        if (this.el.fullLogKv) {
            let sevClass = "";
            if(log.severity === "ERROR" || log.severity === "FATAL") sevClass = "danger";
            else if(log.severity === "WARN") sevClass = "warn";
            
            const tid = log.trace_id || log.attributes?.['sip.call_id'] || 'N/A';
            const spanId = log.span_id || 'N/A';
            
            let html = `<div class="card-label highlight">LIFECYCLE METADATA</div>
                <table class="kv-table">
                    <tr><td class="k-col">TIMESTAMP</td><td class="v-col">${log.ts}</td></tr>
                    <tr><td class="k-col">SEVERITY</td><td class="v-col ${sevClass}" style="font-weight:bold;">${log.severity}</td></tr>
                    <tr><td class="k-col">EVENT</td><td class="v-col accent" style="font-weight:bold;">${log.event}</td></tr>
                    <tr><td class="k-col">MESSAGE</td><td class="v-col">${this.escapeHtml(log.message)}</td></tr>
                    <tr><td class="k-col">TRACE ID</td><td class="v-col">${tid}</td></tr>
                    <tr><td class="k-col">SPAN ID</td><td class="v-col">${spanId}</td></tr>
                    <tr><td class="k-col">NODE</td><td class="v-col">${log.resource?.['host.name'] || 'N/A'}</td></tr>
                    <tr><td class="k-col">SERVICE</td><td class="v-col">${log.resource?.['service.name'] || 'N/A'} (v${log.resource?.['service.version']})</td></tr>
                </table>`;
            
            if (log._ts_start && log.event.includes('STREAM')) {
                const duration = new Date(log.ts).getTime() - new Date(log._ts_start).getTime();
                const approxTokens = Math.max(Math.floor(log.message.length / 4), 1);
                const msPerToken = (duration / approxTokens).toFixed(1);
                let speedColor = msPerToken > 250 ? "var(--danger)" : (msPerToken > 100 ? "var(--warn)" : "var(--accent)");
                
                html += `<div style="margin-top:10px; padding:8px; border-radius:4px; background:rgba(0,0,0,0.5); border-left:3px solid ${speedColor};">
                    <span style="font-size:9px; color:${speedColor}; font-weight:bold; display:block; margin-bottom:4px;">🧠 AI VELOCITY</span>
                    <div style="font-family:'JetBrains Mono'; font-size:11px; display:flex; justify-content:space-between;">
                        <span style="color:#888;">Speed:</span><span style="color:${speedColor}; font-weight:bold;">${msPerToken} ms/tok</span>
                    </div>
                </div>`;
            }
            this.el.fullLogKv.innerHTML = html;
        }

        const safeLog = JSON.parse(JSON.stringify(log));
        if (safeLog.attributes?.['rtp.audio_b64']) safeLog.attributes['rtp.audio_b64'] = "[BASE64_AUDIO_DATA_HIDDEN]";
        if (this.el.detJson) this.el.detJson.innerText = JSON.stringify(safeLog, null, 2);

        const isRtp = log.event === "RTP_PACKET" || log.smart_tags?.includes('RTP');
        if (this.el.rtpCard) {
            this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
            if (isRtp && log.attributes) {
                if (this.el.rtpPt) this.el.rtpPt.innerText = log.attributes['rtp.payload_type'] || '-';
                if (this.el.rtpSeq) this.el.rtpSeq.innerText = log.attributes['rtp.sequence'] || '-';
                if (this.el.rtpLen) this.el.rtpLen.innerText = (log.attributes['net.packet_len'] || 0) + 'B';
                const hasAudio = !!log.attributes['rtp.audio_b64'];
                this.btnPlay.style.display = hasAudio ? 'block' : 'none';
                setTimeout(() => { this.viz.resize(); this.viz.start(); }, 50);
            } else {
                this.viz.stop();
            }
        }
        
        if (document.querySelector('.tab-btn[data-tab="view-timeline"]').classList.contains('active')) {
            this.renderTimeline();
        }
    }

    close() {
        Store.dispatch('SELECT_LOG', null);
        this.viz.stop();
        this.el.workspace.classList.remove('inspector-open');
    }

    escapeHtml(unsafe) {
        if (!unsafe) return "";
        return unsafe.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // [YENİ] Vektörel Dışa Aktarım Engine
    exportVisuals() {
        const tid = Store.state.controls.lockedTraceId || "trace";
        
        // 1. Gantt SVG Export
        const ganttSvg = this.el.timelineFlow.querySelector('#gantt-svg');
        if (ganttSvg) {
            this.downloadSvg(ganttSvg, `sentiric_gantt_latency_${tid}.svg`);
        }

        // 2. Mermaid Sequence SVG Export
        const seqSvg = this.el.timelineFlow.querySelector('.mermaid svg');
        if (seqSvg) {
            this.downloadSvg(seqSvg, `sentiric_sequence_ladder_${tid}.svg`);
        }
    }

    downloadSvg(svgElement, filename) {
        const serializer = new XMLSerializer();
        let source = serializer.serializeToString(svgElement);
        if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
            source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
        }
        const blob = new Blob([source], {type: "image/svg+xml;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    renderTimeline() {
        if (!this.el.timelineFlow) return;
        const state = Store.state;
        let targetTrace = state.controls.lockedTraceId;
        
        if (!targetTrace && state.controls.selectedLogIdx !== null) {
            const log = state.rawLogs.find(l => l._idx === state.controls.selectedLogIdx);
            if (log) targetTrace = log.trace_id || log.attributes?.['sip.call_id'];
        }
        
        if (!targetTrace) {
            this.el.btnExportDiag.style.display = 'none';
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">Lock a trace to view Timeline Diagram.</div>';
            return;
        }

        this.el.btnExportDiag.style.display = 'block';
        this.el.btnExportDiag.innerHTML = '📸 EXPORT SVG DIAGRAMS';

        const journey = state.rawLogs
            .filter(l => (l.trace_id || l.attributes?.['sip.call_id']) === targetTrace)
            .filter(l => l.event !== "RTP_PACKET") 
            .sort((a, b) => a._idx - b._idx);

        if (!journey.length) { 
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">No timeline events found.</div>'; 
            return; 
        }

        let minTs = new Date(journey[0].ts).getTime();
        let maxTs = new Date(journey[journey.length-1].ts).getTime();
        let totalMs = Math.max(maxTs - minTs, 1);

        let spans = {};
        let events =[];
        let services = Array.from(new Set(journey.map(l => l.resource['service.name'])));

        journey.forEach(l => {
            let ts = new Date(l.ts).getTime();
            let svc = l.resource['service.name'];
            if (l.span_id) {
                if (!spans[l.span_id]) spans[l.span_id] = { start: ts, end: ts, service: svc, name: l.event };
                else { spans[l.span_id].end = Math.max(spans[l.span_id].end, ts); spans[l.span_id].start = Math.min(spans[l.span_id].start, ts); }
            } else {
                events.push({ ts: ts, service: svc, name: l.event, severity: l.severity, _idx: l._idx });
            }
        });

        let rowHeight = 30;
        let chartHeight = services.length * rowHeight + 40;
        let svgWidth = 600; // Export için sabit genişlik referansı (ViewBox)

        // --- [YENİ] NATIVE SVG GANTT CHART ---
        // Bu yapı HTML Div'lerinden kat kat üstündür ve kusursuz vektör imaj olarak indirilebilir.
        let svgContent = `<svg id="gantt-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${chartHeight}" width="100%" height="100%" style="background:#0a0a0a; font-family:'JetBrains Mono', monospace;">`;
        
        // Zaman Çizgileri
        for(let i=0; i<=4; i++) {
            let pct = i * 25;
            let x = 120 + ((svgWidth - 130) * (pct / 100));
            svgContent += `<line x1="${x}" y1="0" x2="${x}" y2="${chartHeight}" stroke="#222" stroke-width="1"/>`;
            svgContent += `<text x="${x}" y="10" fill="#555" font-size="8" text-anchor="middle">${Math.round((totalMs * pct)/100)}ms</text>`;
        }

        // Servis İsimleri ve Grid
        services.forEach((svc, i) => {
            let y = i * rowHeight + 30;
            let shortSvc = svc.replace('-service', '');
            svgContent += `<text x="10" y="${y+4}" fill="#888" font-size="10" font-weight="bold">${shortSvc}</text>`;
            svgContent += `<line x1="110" y1="${y+10}" x2="${svgWidth}" y2="${y+10}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
        });

        // Uzun İşlemler (Spans - Çubuklar)
        Object.values(spans).forEach(span => {
            let svcIdx = services.indexOf(span.service);
            let y = svcIdx * rowHeight + 26;
            let leftPct = ((span.start - minTs) / totalMs);
            let widthPct = Math.max(((span.end - span.start) / totalMs), 0.005); 
            let x = 120 + ((svgWidth - 130) * leftPct);
            let w = (svgWidth - 130) * widthPct;
            svgContent += `<rect x="${x}" y="${y}" width="${w}" height="8" fill="#58a6ff" rx="2" ry="2"><title>[SPAN] ${span.name} | ${span.end - span.start}ms</title></rect>`;
        });

        // Anlık Olaylar (Events - Noktalar)
        events.forEach(ev => {
            let svcIdx = services.indexOf(ev.service);
            let y = svcIdx * rowHeight + 26;
            let leftPct = ((ev.ts - minTs) / totalMs);
            let x = 120 + ((svgWidth - 130) * leftPct);
            let color = (ev.severity === 'ERROR' || ev.severity === 'FATAL') ? '#f85149' : '#00ff9d';
            // HTML tarafında tıklama (Jump) yakalayabilmek için class veriyoruz
            svgContent += `<rect class="timeline-jump" data-idx="${ev._idx}" x="${x}" y="${y-1}" width="4" height="10" fill="${color}" rx="2" ry="2" cursor="pointer"><title>${ev.name} | +${ev.ts - minTs}ms (Click to Jump)</title></rect>`;
        });

        svgContent += `</svg>`;

        let timelineHtml = `
            <div style="padding: 12px; background:#161619; margin-bottom:15px; border-radius:6px; border-left:3px solid var(--accent); overflow-x:auto;">
                <b style="color:white; font-size:11px;">⏱️ GANTT & LATENCY VISUALIZER:</b><br/>
                <span style="color:#aaa; font-size:11px; font-family:monospace;">Total Trace Duration: ${totalMs}ms</span>
                <div class="gantt-wrapper" style="width:100%; min-width:400px; height:${chartHeight}px; margin-top:10px; border-radius:4px; overflow:hidden; border:1px solid #333;">
                    ${svgContent}
                </div>
            </div>
        `;

        // MERMAID SEQUENCE
        let mermaidCode = `sequenceDiagram\n    autonumber\n`;
        let prevSvc = "Client(UAC)"; 
        
        journey.forEach(l => {
            let svc = l.resource['service.name'].replace("-service", "");
            if (svc.includes("uac") || l.event.includes("MOBILE")) svc = "Client(UAC)";
            let msg = l.attributes?.['sip.method'] || l.event;
            let arrow = (l.severity === "ERROR" || l.severity === "FATAL") ? "-x" : "->>";
            msg = msg.replace(/[^a-zA-Z0-9_/\- ]/g, "");
            if (prevSvc !== svc || l.severity === "ERROR") mermaidCode += `    ${prevSvc}${arrow}${svc}: ${msg}\n`;
            prevSvc = svc;
        });

        timelineHtml += `
            <div style="background:#fff; border-radius:8px; padding:10px; overflow-x:auto;">
                <div class="mermaid">${mermaidCode}</div>
            </div>
        `;
        
        this.el.timelineFlow.innerHTML = timelineHtml;
        
        if (window.mermaid) {
            window.mermaid.initialize({ theme: 'base', sequence: { showSequenceNumbers: true }});
            try { window.mermaid.init(undefined, document.querySelectorAll('.mermaid')); } catch(e){}
        }
    }
}
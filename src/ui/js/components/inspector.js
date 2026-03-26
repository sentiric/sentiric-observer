import { Store } from '../store.js';
import { audioEngine } from '../features/audio_engine.js';

export class InspectorComponent {
    constructor(visualizer) {
        this.viz = visualizer;
        
        this.el = {
            workspace: document.getElementById('workspace'),
            inspPlaceholder: document.getElementById('insp-placeholder'),
            inspContent: document.getElementById('insp-content'),
            detTs: document.getElementById('det-ts'),
            detNode: document.getElementById('det-node'),
            detTrace: document.getElementById('det-trace'),
            detJson: document.getElementById('json-viewer'),
            rtpCard: document.getElementById('rtp-diag'),
            rtpPt: document.getElementById('rtp-pt'),
            rtpSeq: document.getElementById('rtp-seq'),
            rtpLen: document.getElementById('rtp-len'),
            timelineFlow: document.getElementById('timeline-flow'),
            btnCloseInsp: document.getElementById('btn-close-insp'),
            tabBtns: document.querySelectorAll('.tab-btn'),
            tabViews: document.querySelectorAll('.insp-view')
        };

        this.injectAudioControls();
        this.bindEvents();
    }

    injectAudioControls() {
        if (!this.el.rtpCard) return;
        
        const btnRow = document.createElement('div');
        btnRow.style.marginTop = '15px';
        btnRow.style.display = 'flex';
        btnRow.style.gap = '10px';
        
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
                        .then(() => {
                            this.btnPlay.innerHTML = '▶ DECODE & PLAY CALL AUDIO';
                            this.btnPlay.style.opacity = '1';
                        })
                        .catch(() => {
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
        this.el.btnCloseInsp?.addEventListener('click', () => {
            // Sağ menü kapanırken workspace'i doğru konuma getirmeli. 
            // Bunun için app.js veya trace_list üzerinden durumu almalıyız.
            const isLeftOpen = document.getElementById('trace-list').style.display !== 'none';
            this.close(isLeftOpen);
        });

        this.el.tabBtns?.forEach(btn => {
            btn.addEventListener('click', () => {
                this.el.tabBtns.forEach(b => b.classList.remove('active'));
                this.el.tabViews.forEach(v => v.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.tab)?.classList.add('active');
                if (btn.dataset.tab === 'view-timeline') this.renderTimeline();
            });
        });
    }

open(idx) {
        const log = Store.state.rawLogs.find(l => l._idx === idx);
        if (!log) return;

        // JS ile grid ölçüsü vermek yok, sadece CSS Class ekliyoruz!
        this.el.workspace.classList.add('inspector-open');
            
        this.el.inspPlaceholder.style.display = 'none';
        this.el.inspContent.style.display = 'block';

        if (this.el.detTs) this.el.detTs.innerText = log.ts || 'N/A';
        if (this.el.detNode) this.el.detNode.innerText = log.resource?.['host.name'] || 'N/A';
        const tid = log.trace_id || log.attributes?.['sip.call_id'];
        if (this.el.detTrace) this.el.detTrace.innerText = tid || 'No Trace ID attached';
        
        const safeAttrs = { ...log.attributes };
        if (safeAttrs['rtp.audio_b64']) safeAttrs['rtp.audio_b64'] = "[BASE64_AUDIO_DATA_HIDDEN]";
        if (this.el.detJson) this.el.detJson.innerText = JSON.stringify(safeAttrs, null, 2);

        const isRtp = log.event === "RTP_PACKET" || log.smart_tags?.includes('RTP');
        if (this.el.rtpCard) {
            this.el.rtpCard.style.display = isRtp ? 'block' : 'none';
            if (isRtp && log.attributes) {
                if (this.el.rtpPt) this.el.rtpPt.innerText = log.attributes['rtp.payload_type'] || '-';
                if (this.el.rtpSeq) this.el.rtpSeq.innerText = log.attributes['rtp.sequence'] || '-';
                if (this.el.rtpLen) this.el.rtpLen.innerText = (log.attributes['net.packet_len'] || 0) + 'B';
                
                const hasAudio = !!log.attributes['rtp.audio_b64'];
                this.btnPlay.style.display = hasAudio ? 'block' : 'none';

                setTimeout(() => {
                    this.viz.resize(); 
                    this.viz.start();
                }, 50);
            } else {
                this.viz.stop();
            }
        }
        this.renderTimeline();
    }

    close() {
        Store.dispatch('SELECT_LOG', null);
        this.viz.stop();
        // JS ile grid ölçüsü vermek yok, sadece CSS Class siliyoruz!
        this.el.workspace.classList.remove('inspector-open');
    }

    // [ARCH-COMPLIANCE] V13.0 Observer - Mermaid.js SIP Ladder & Causality Timeline
    renderTimeline() {
        if (!this.el.timelineFlow) return;
        const state = Store.state;
        let targetTrace = state.controls.lockedTraceId;
        
        if (!targetTrace && state.controls.selectedLogIdx !== null) {
            const log = state.rawLogs.find(l => l._idx === state.controls.selectedLogIdx);
            if (log) targetTrace = log.trace_id || log.attributes?.['sip.call_id'];
        }
        
        if (!targetTrace) {
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">Lock a trace to view SIP Ladder & Causality.</div>';
            return;
        }

        const journey = state.rawLogs
            .filter(l => (l.trace_id || l.attributes?.['sip.call_id']) === targetTrace)
            .filter(l => l.event !== "RTP_PACKET") 
            .sort((a, b) => a._idx - b._idx);

        if (!journey.length) { 
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">No timeline events found.</div>'; 
            return; 
        }

        // 1. SMART RTP DIAGNOSTICS (Kayıp/Timeout Tespiti)
        let rtpLogs = state.rawLogs.filter(l => (l.trace_id === targetTrace) && l.event === "RTP_PACKET");
        let rtpWarning = "";
        
        if (journey.some(l => l.event === "RTP_TIMEOUT" || l.event === "HW_MIC_ERROR")) {
            rtpWarning = `<div class="tag tag-dtmf" style="font-size:11px; margin-top:8px; display:inline-block; padding:4px 8px;">[SILENT_CALL] CRITICAL: Client stopped sending RTP. Check Device MIC / Network!</div>`;
        }

        // 2. MERMAID.JS SEQUENCE DIAGRAM (SIP LADDER)
        let mermaidCode = `sequenceDiagram\n    autonumber\n`;
        let prevSvc = "Client(UAC)"; // Başlangıç noktası
        
        journey.forEach(l => {
            let svc = l.resource['service.name'].replace("-service", "");
            
            // Eğer log mobil veya desktop UAC'den geliyorsa, adını Client yap
            if (svc.includes("uac") || l.event.includes("MOBILE")) {
                svc = "Client(UAC)";
            }

            let msg = l.event;
            // SIP Metodlarını daha şık göster
            if (l.attributes && l.attributes['sip.method']) {
                msg = l.attributes['sip.method'];
            }
            
            // Hata ise kesik kırmızı ok, normal ise düz mavi ok
            let arrow = (l.severity === "ERROR" || l.severity === "FATAL") ? "-x" : "->>";
            
            // Mermaid'in kırılmaması için mesajı temizle
            msg = msg.replace(/[^a-zA-Z0-9_/\- ]/g, "");
            
            if (prevSvc !== svc || l.severity === "ERROR") {
                mermaidCode += `    ${prevSvc}${arrow}${svc}: ${msg}\n`;
            }
            prevSvc = svc;
        });

        // 3. HTML RENDER
        let html = `
            <div style="padding: 12px; background:#161619; margin-bottom:15px; border-radius:6px; border-left:3px solid var(--purple);">
                <b style="color:white; font-size:11px;">📡 SIGNALING & RTP DIAGNOSTICS:</b><br/>
                <span style="color:#aaa; font-size:11px; font-family:monospace;">Processed Media Packets: ${rtpLogs.length}</span><br/>
                ${rtpWarning}
            </div>
            <div class="mermaid" style="background:#fff; border-radius:8px; padding:10px;">
                ${mermaidCode}
            </div>
        `;
        
        this.el.timelineFlow.innerHTML = html;
        
        // Mermaid.js'i tetikle
        if (window.mermaid) {
            window.mermaid.initialize({ theme: 'base', sequence: { showSequenceNumbers: true }});
            // Küçük bir gecikme ile renderla ki DOM'a oturmuş olsun
            setTimeout(() => {
                window.mermaid.init(undefined, document.querySelectorAll('.mermaid'));
            }, 50);
        }
    }
}
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

    renderTimeline() {
        if (!this.el.timelineFlow) return;
        const state = Store.state;
        let targetTrace = state.controls.lockedTraceId;
        if (!targetTrace && state.controls.selectedLogIdx !== null) {
            const log = state.rawLogs.find(l => l._idx === state.controls.selectedLogIdx);
            if (log) targetTrace = log.trace_id || log.attributes?.['sip.call_id'];
        }
        
        if (!targetTrace) {
            this.el.timelineFlow.innerHTML = '<div class="empty-hint">Lock a trace or select a packet to view causality timeline.</div>';
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

        const startTs = new Date(journey[0].ts).getTime();
        let html = '';
        journey.forEach(l => {
            const deltaMs = new Date(l.ts).getTime() - startTs;
            let type = '';
            if (l.smart_tags?.includes('SIP') || l.event.includes('SIP')) type = 'sip';
            else if (l.smart_tags?.includes('RTP') || l.event.includes('MEDIA')) type = 'rtp';
            if (l.severity === 'ERROR' || l.severity === 'FATAL') type = 'error';
            
            const escapedMsg = l.message.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            
            html += `<div class="tl-item ${type}">
                <div class="tl-mark"></div>
                <div class="tl-content">
                    <div class="tl-head">
                        <span class="tl-title">${l.event}</span>
                        <span class="tl-time">+${deltaMs}ms</span>
                    </div>
                    <div class="tl-svc">${l.resource['service.name']}</div>
                    <div class="tl-msg">${escapedMsg}</div>
                </div>
            </div>`;
        });
        this.el.timelineFlow.innerHTML = html;
    }
}
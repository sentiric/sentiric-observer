// src/ui/js/components/trace_list.js
import { Store } from '../store.js';
import { audioEngine } from '../features/audio_engine.js';

export class TraceListComponent {
    constructor(inspectorComponent) {
        this.inspector = inspectorComponent;
        
        this.el = {
            workspace: document.getElementById('workspace'),
            list: document.getElementById('trace-list'),
            locatorHeader: document.querySelector('#trace-locator .pane-header'),
            headerTitle: document.querySelector('#trace-locator .pane-header > span'),
        };

        this.injectHeaderControls();
        this.bindEvents();
    }

    // ... (injectHeaderControls aynı kalabilir)
    injectHeaderControls() {
        if (!this.el.locatorHeader) return;
        
        const controls = document.createElement('div');
        controls.className = 'header-controls';
        controls.style.display = 'flex';
        controls.style.gap = '8px';
        controls.style.alignItems = 'center';

        this.unlockBtn = document.createElement('button');
        this.unlockBtn.innerHTML = '✕';
        this.unlockBtn.className = 'icon-btn';
        this.unlockBtn.title = "Unlock Stream (Show All)";
        this.unlockBtn.style.color = 'var(--accent)';
        this.unlockBtn.style.display = 'none'; 
        
        this.unlockBtn.onclick = (e) => {
            e.stopPropagation();
            Store.dispatch('UNLOCK_TRACE');
        };
        controls.appendChild(this.unlockBtn);

        let trashBtn = this.el.locatorHeader.querySelector('#btn-clear-traces');
        if (!trashBtn) {
            trashBtn = document.createElement('button');
            trashBtn.id = 'btn-clear-traces';
            trashBtn.className = 'icon-btn';
            trashBtn.innerHTML = '🗑';
            trashBtn.title = "Clear All Traces";
        }
        trashBtn.onclick = (e) => {
            e.stopPropagation();
            if(confirm("Clear all logs and traces?")) {
                Store.dispatch('WIPE_DATA');
            }
        };
        controls.appendChild(trashBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.innerHTML = '◀';
        toggleBtn.className = 'icon-btn';
        toggleBtn.style.minWidth = '24px';
        
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            const isCollapsed = this.el.workspace.classList.toggle('left-collapsed');
            toggleBtn.innerHTML = isCollapsed ? '▶' : '◀';
            if(this.inspector) this.inspector.isLeftMenuOpen = !isCollapsed;
        };
        controls.appendChild(toggleBtn);

        this.el.locatorHeader.appendChild(controls);
    }

    bindEvents() {
        if (!this.el.list) return;

        this.el.list.addEventListener('click', (e) => {
            const playBtn = e.target.closest('.btn-play-trace');
            if (playBtn) {
                e.stopPropagation();
                const tid = playBtn.dataset.tid;
                const originalHTML = playBtn.innerHTML;
                
                playBtn.innerHTML = '🔊';
                playBtn.style.color = 'var(--purple)';

                audioEngine.playTrace(tid, Store.state.rawLogs)
                    .then(() => {
                        playBtn.innerHTML = originalHTML;
                        playBtn.style.color = 'var(--accent)';
                    })
                    .catch((err) => {
                        playBtn.innerHTML = '❌'; 
                        playBtn.title = "Audio not found for this trace";
                        setTimeout(() => {
                             playBtn.innerHTML = originalHTML;
                             playBtn.style.color = 'var(--accent)';
                        }, 2000);
                    });
                return;
            }

            const item = e.target.closest('.trace-item');
            if (item) {
                Store.dispatch('LOCK_TRACE', item.dataset.tid);
                if(this.inspector) this.inspector.renderTimeline(); 
            }
        });
    }

    render(state) {
        if (!this.el.list) return;

        const lockedId = state.controls.lockedTraceId;
        if (lockedId) {
            if (this.el.headerTitle) {
                this.el.headerTitle.innerText = `LOCKED: ${lockedId.substring(0, 8)}...`;
                this.el.headerTitle.style.color = 'var(--accent)';
            }
            if (this.unlockBtn) this.unlockBtn.style.display = 'block';
        } else {
            if (this.el.headerTitle) {
                this.el.headerTitle.innerText = 'CALL JOURNEYS';
                this.el.headerTitle.style.color = '#888';
            }
            if (this.unlockBtn) this.unlockBtn.style.display = 'none';
        }
        
        // --- V14.0 HEALTH RADAR SORTING ---
        // Sadece son eklenenlere göre değil, Urgency Score (Hata sayısı) olanları üste çıkar.
        const traces = Array.from(state.activeTraces.entries())
            .sort((a, b) => {
                // Eğer urgency skorları farklıysa, yüksek olan üste
                if (b[1].urgencyScore !== a[1].urgencyScore) {
                    return b[1].urgencyScore - a[1].urgencyScore;
                }
                // Eşitse en son gelen üste
                return new Date(b[1].start) - new Date(a[1].start);
            })
            .slice(0, 50);

        let html = '';
        
        for (let i = 0; i < traces.length; i++) {
            const [tid, data] = traces[i];
            const isActive = lockedId === tid ? 'active' : '';
            const time = data.start ? data.start.substring(11, 19) : '--:--';
            
            const audioBtnHtml = data.hasAudio 
                ? `<button class="icon-btn btn-play-trace" style="color:var(--accent); font-size:14px; padding:0 6px; margin-right:5px; border:1px solid #333;" title="Play Audio (Media Logs Only)">▶</button>` 
                : '';

            // Aciliyet (Health) Göstergeleri
            const errorBadge = data.errorCount > 0 
                ? `<span style="background:var(--danger); color:#fff; padding:2px 4px; border-radius:3px; font-size:8px; margin-right:5px; font-weight:bold;">${data.errorCount} ERR</span>` 
                : '';
                
            const warnBadge = data.warnCount > 0 
                ? `<span style="background:var(--warn); color:#000; padding:2px 4px; border-radius:3px; font-size:8px; margin-right:5px; font-weight:bold;">${data.warnCount} WRN</span>` 
                : '';

            // Hata varsa arkaplana hafif kırmızı bir glow verelim
            const errorGlow = data.errorCount > 0 ? 'background: rgba(248, 81, 73, 0.05); border-left: 2px solid var(--danger);' : '';

            html += `<div class="trace-item ${isActive}" data-tid="${tid}" style="${errorGlow}">
                <div class="tid">${tid.substring(0, 24)}...</div>
                <div class="t-meta">
                    <span>${time}</span>
                    <span style="display:flex; align-items:center;">
                        ${errorBadge}
                        ${warnBadge}
                        ${audioBtnHtml}
                        <span>${data.count} pkts</span>
                    </span>
                </div>
            </div>`;
        }
        
        if (html === '') html = '<div class="empty-hint">Awaiting signaling data...</div>';
        this.el.list.innerHTML = html;
    }
}
// src/ui/js/components/trace_list.js
import { Store } from '../store.js';
import { audioEngine } from '../features/audio_engine.js';

export class TraceListComponent {
    constructor(inspectorComponent) {
        this.inspector = inspectorComponent;
        
        this.el = {
            workspace: document.getElementById('workspace'),
            list: document.getElementById('trace-list'),
            // Footer'daki butonu artık kullanmıyoruz, silebilirsin
            locatorHeader: document.querySelector('#trace-locator .pane-header'),
            headerTitle: document.querySelector('#trace-locator .pane-header > span'), // Başlık alanı
            footer: document.querySelector('#trace-locator .pane-footer') // Footer alanı
        };

        // Footer'ı tamamen gizle (CSS ile de yapılabilir ama garanti olsun)
        if (this.el.footer) this.el.footer.style.display = 'none';

        this.injectHeaderControls();
        this.bindEvents();
    }

    injectHeaderControls() {
        if (!this.el.locatorHeader) return;
        
        // 1. Sağ taraf kontrol grubu
        const controls = document.createElement('div');
        controls.className = 'header-controls';
        controls.style.display = 'flex';
        controls.style.gap = '8px';
        controls.style.alignItems = 'center';

        // 2. UNLOCK (Geri Dön) Butonu - Başlangıçta gizli
        this.unlockBtn = document.createElement('button');
        this.unlockBtn.innerHTML = '✕';
        this.unlockBtn.className = 'icon-btn';
        this.unlockBtn.title = "Unlock Stream (Show All)";
        this.unlockBtn.style.color = 'var(--accent)';
        this.unlockBtn.style.display = 'none'; // Sadece kilitliyken görünür
        
        this.unlockBtn.onclick = (e) => {
            e.stopPropagation();
            Store.dispatch('UNLOCK_TRACE');
        };
        controls.appendChild(this.unlockBtn);

        // 3. TRASH (Temizle) Butonu - Mevcut butonu bul ve onar
        // Eğer HTML'de varsa onu al, yoksa yeni yarat
        let trashBtn = this.el.locatorHeader.querySelector('#btn-clear-traces');
        if (!trashBtn) {
            trashBtn = document.createElement('button');
            trashBtn.id = 'btn-clear-traces';
            trashBtn.className = 'icon-btn';
            trashBtn.innerHTML = '🗑';
            trashBtn.title = "Clear All Traces";
        }
        // Event Listener'ı burada ekle (Garanti çalışır)
        trashBtn.onclick = (e) => {
            e.stopPropagation();
            if(confirm("Clear all logs and traces?")) {
                Store.dispatch('WIPE_DATA');
            }
        };
        controls.appendChild(trashBtn);

        // 4. TOGGLE (Sidebar Aç/Kapa) Butonu
        const toggleBtn = document.createElement('button');
        toggleBtn.innerHTML = '◀';
        toggleBtn.className = 'icon-btn';
        toggleBtn.style.minWidth = '24px';
        
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            const isCollapsed = this.el.workspace.classList.toggle('left-collapsed');
            toggleBtn.innerHTML = isCollapsed ? '▶' : '◀';
            
            // Başlık ve butonları gizle/göster mantığı CSS'te (layout.css) var zaten
            if(this.inspector) this.inspector.isLeftMenuOpen = !isCollapsed;
        };
        controls.appendChild(toggleBtn);

        this.el.locatorHeader.appendChild(controls);
    }

    bindEvents() {
        if (!this.el.list) return;

        this.el.list.addEventListener('click', (e) => {
            // A. PLAY BUTONU (Sadece media-service logları için çalışır)
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
                        console.warn("Audio Play Error:", err);
                        // Kullanıcıya görsel geri bildirim ver
                        playBtn.innerHTML = '❌'; 
                        playBtn.title = "Audio not found for this trace (Check Raw Packets)";
                        setTimeout(() => {
                             playBtn.innerHTML = originalHTML;
                             playBtn.style.color = 'var(--accent)';
                        }, 2000);
                    });
                return;
            }

            // B. TRACE SEÇİMİ
            const item = e.target.closest('.trace-item');
            if (item) {
                Store.dispatch('LOCK_TRACE', item.dataset.tid);
                // Inspector'ı tetikle
                if(this.inspector) this.inspector.renderTimeline(); 
            }
        });
    }

    render(state) {
        if (!this.el.list) return;

        // --- HEADER YÖNETİMİ ---
        // Eğer bir trace kilitliyse başlığı değiştir ve X butonunu göster
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
        
        // --- LİSTE RENDER ---
        const traces = Array.from(state.activeTraces.entries()).reverse().slice(0, 50);
        let html = '';
        
        for (let i = 0; i < traces.length; i++) {
            const [tid, data] = traces[i];
            const isActive = lockedId === tid ? 'active' : '';
            const time = data.start ? data.start.substring(11, 19) : '--:--';
            
            const audioBtnHtml = data.hasAudio 
                ? `<button class="icon-btn btn-play-trace" style="color:var(--accent); font-size:14px; padding:0 6px; margin-right:5px; border:1px solid #333;" title="Play Audio (Media Logs Only)">▶</button>` 
                : '';

            html += `<div class="trace-item ${isActive}" data-tid="${tid}">
                <div class="tid">${tid.substring(0, 24)}...</div>
                <div class="t-meta">
                    <span>${time}</span>
                    <span style="display:flex; align-items:center;">
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
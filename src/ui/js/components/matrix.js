// src/ui/js/components/matrix.js
import { Store } from '../store.js';

export class MatrixComponent {
    constructor(inspectorComponent, traceListComponent) {
        this.inspector = inspectorComponent;
        this.traceList = traceListComponent;
        
        this.lastRenderedIdx = -1;
        this.selectionChanged = false;
        this.shouldScroll = true; 
        
        this.el = {
            matrix: document.getElementById('matrix-content'),
            scroller: document.getElementById('matrix-scroller')
        };

        this.bindEvents();
    }

    bindEvents() {
        if (!this.el.matrix) return;

        this.el.scroller?.addEventListener('scroll', () => {
            const el = this.el.scroller;
            const isAtBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 10;
            this.shouldScroll = isAtBottom;
        });

        this.el.matrix.addEventListener('click', (e) => {
            const row = e.target.closest('.log-row');
            if (row) {
                const idx = parseFloat(row.dataset.idx);
                Store.dispatch('SELECT_LOG', idx);
                this.selectionChanged = true; 
                this.shouldScroll = false; 
                
                this.inspector.open(idx);
            }
        });
    }

    escapeHtml(unsafe) {
        if (!unsafe) return "";
        return unsafe.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    render(state) {
        if (!this.el.matrix) return;

        // 1. SURGICAL UPDATE (Noktasal Güncelleme - LLM Streaming için)
        if (state.controls.dirtyLogs.size > 0 && !state.controls.forceRender) {
            state.controls.dirtyLogs.forEach(idx => {
                const rowEl = this.el.matrix.querySelector(`.log-row[data-idx="${idx}"]`);
                if (rowEl) {
                    const log = state.rawLogs.find(l => l._idx === idx);
                    if (log) {
                        const msgCell = rowEl.querySelector('.message-text');
                        if (msgCell) msgCell.innerHTML = this.escapeHtml(log.message);
                        
                        // İsteğe bağlı: Token aktığını göstermek için hafif bir flash efekti eklenebilir.
                        msgCell.style.color = "var(--accent)";
                        setTimeout(() => msgCell.style.color = "#999", 50);
                    }
                }
            });
            return; // Sadece dirty update yapıldıysa yeni render'a gerek yok.
        }

        // 2. FULL RENDER veya YENİ SATIR EKLENMESİ
        if (state.controls.forceRender) {
            this.wipe();
            state.controls.forceRender = false;
        }

        const newLogs = state.filteredLogs.filter(l => l._idx > this.lastRenderedIdx);
        if (newLogs.length === 0 && !this.selectionChanged) return;

        const fragment = document.createDocumentFragment();
        
        newLogs.forEach(l => {
            const div = document.createElement('div');
            div.className = `log-row`;
            div.dataset.idx = l._idx;
            
            const time = l.ts ? l.ts.substring(11, 23) : '--:--';
            const svcName = l.resource ? l.resource['service.name'] : 'sys';
            let nodeName = l.resource?.['host.name'] || 'local';
            if (nodeName.length > 15) nodeName = nodeName.substring(0, 12) + '..';
            
            let sevColor = "#ccc";
            if (l.severity === "ERROR" || l.severity === "FATAL") sevColor = "var(--danger)";
            else if (l.severity === "WARN") sevColor = "var(--warn)";

            const tagsHtml = (l.smart_tags || [])
                .map(tag => `<span class="tag tag-${tag.toLowerCase()}">${tag}</span>`)
                .join('');

            div.innerHTML = `
                <span style="color:#666">${time}</span>
                <span style="color:${sevColor}; font-weight:bold;">${l.severity}</span>
                <span style="color:var(--info); font-size:10px;">${nodeName}</span>
                <span style="color:var(--purple)">${svcName}</span>
                <span style="color:#fff; font-weight:800;">${l.event}</span>
                <span class="message-cell">
                    <span class="message-text">${this.escapeHtml(l.message)}</span>
                    <span class="tags-container">${tagsHtml}</span>
                </span>
            `;
            
            fragment.appendChild(div);
            this.lastRenderedIdx = l._idx;
        });

        this.el.matrix.appendChild(fragment);

        // VDOM Limit - DOM'un şişmesini engeller
        while (this.el.matrix.children.length > 500) {
            this.el.matrix.removeChild(this.el.matrix.firstChild);
        }

        // Selection Management
        const prevSelected = this.el.matrix.querySelector('.log-row.selected');
        if (prevSelected && prevSelected.dataset.idx != state.controls.selectedLogIdx) {
            prevSelected.classList.remove('selected');
        }
        if (state.controls.selectedLogIdx) {
            const newSelected = this.el.matrix.querySelector(`.log-row[data-idx="${state.controls.selectedLogIdx}"]`);
            if (newSelected) newSelected.classList.add('selected');
        }
        this.selectionChanged = false;

        // Auto Scroll
        if (!state.status.isPaused && this.shouldScroll && this.el.scroller) {
            this.el.scroller.scrollTop = this.el.scroller.scrollHeight;
        }
    }

    wipe() {
        if(this.el.matrix) this.el.matrix.innerHTML = '';
        this.lastRenderedIdx = -1;
    }

    // src/ui/js/components/matrix.js içine eklenecek yeni metod (sınıfın içine):
    scrollToLog(idx) {
        if (!this.el.matrix || !this.el.scroller) return;

        const row = this.el.matrix.querySelector(`.log-row[data-idx="${idx}"]`);
        if (row) {
            // Önceki animasyonu temizle
            const prev = this.el.matrix.querySelector('.highlight-pulse');
            if (prev) prev.classList.remove('highlight-pulse');

            // Otonom kaydırmayı geçici olarak durdur (operatör inceliyor)
            this.shouldScroll = false;

            // Elementi ekranın ortasına kaydır
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Animasyon sınıfını ekle
            row.classList.add('highlight-pulse');
            
            // Satırı seçili hale getir
            Store.dispatch('SELECT_LOG', idx);
            
            setTimeout(() => row.classList.remove('highlight-pulse'), 2000);
        }
    }    
}
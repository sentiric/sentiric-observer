import { Store } from '../store.js';

export class MatrixComponent {
    constructor(inspectorComponent, traceListComponent) {
        this.inspector = inspectorComponent;
        this.traceList = traceListComponent;
        
        this.lastRenderedIdx = -1;
        this.selectionChanged = false;
        this.shouldScroll = true; // Kendi scroll state'ini yönetir
        
        this.el = {
            matrix: document.getElementById('matrix-content'),
            scroller: document.getElementById('matrix-scroller')
        };

        this.bindEvents();
    }

    bindEvents() {
        if (!this.el.matrix) return;

        // Kullanıcı scroll yaparsa takibi bırak
        this.el.scroller?.addEventListener('scroll', () => {
            const el = this.el.scroller;
            const isAtBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 10;
            this.shouldScroll = isAtBottom;
        });

        // Satıra tıklama
        this.el.matrix.addEventListener('click', (e) => {
            const row = e.target.closest('.log-row');
            if (row) {
                const idx = parseFloat(row.dataset.idx);
                Store.dispatch('SELECT_LOG', idx);
                this.selectionChanged = true; 
                this.shouldScroll = false; 
                
                // Sadece index gönderiyoruz, isLeftMenuOpen'e gerek kalmadı
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

        while (this.el.matrix.children.length > 500) {
            this.el.matrix.removeChild(this.el.matrix.firstChild);
        }

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
}
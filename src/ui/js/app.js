const state = {
    logs: [],
    autoScroll: true
};

const ui = {
    render() {
        const wrapper = document.getElementById('console-wrapper');
        const content = document.getElementById('console-content');
        if (!wrapper || !content) return;

        const totalLogs = state.logs.length;
        const rowHeight = (typeof CONFIG !== 'undefined') ? CONFIG.ROW_HEIGHT : 24;

        // 1. Toplam Alan Yüksekliği (Scrollbar için)
        content.style.height = `${totalLogs * rowHeight}px`;

        // 2. Görünürlük Hesaplama
        const startIndex = Math.floor(wrapper.scrollTop / rowHeight);
        const visibleCount = Math.ceil(wrapper.clientHeight / rowHeight);
        const endIndex = Math.min(totalLogs, startIndex + visibleCount + 5);

        // 3. Dilimleme
        const visibleLogs = state.logs.slice(startIndex, endIndex);

        // 4. HTML Üretimi (Absolute Positioning ile çakılma engellenir)
        content.innerHTML = visibleLogs.map((log, index) => {
            const actualIndex = startIndex + index;
            const y = actualIndex * rowHeight;
            const time = new Date(log.timestamp).toLocaleTimeString('tr-TR', {hour12:false});
            
            return `
                <div class="log-row ${log.event_type || 'LOG'} ${log.level || 'INFO'}" 
                     style="position: absolute; top: 0; left: 0; right: 0; transform: translateY(${y}px); height: ${rowHeight}px;">
                    <span class="time">${time}</span>
                    <span class="service">[${log.service}]</span>
                    <span class="msg">${this.escapeHtml(log.message || log.body)}</span>
                </div>
            `;
        }).join('');
    },

    scrollToBottom() {
        if (state.autoScroll) {
            const wrapper = document.getElementById('console-wrapper');
            if (wrapper) {
                wrapper.scrollTop = wrapper.scrollHeight;
            }
        }
    },

    escapeHtml(text) {
        if (!text) return "";
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    updateStats(data) {
        if (data.event_type === 'RTP_METRIC' && data.attributes) {
            const pps = document.getElementById('pps-val');
            const bw = document.getElementById('bw-val');
            if(pps) pps.innerText = data.attributes.pps || 0;
            if(bw) bw.innerText = data.attributes.bandwidth_kbps || 0;
            if(window.visualizer) visualizer.update(data.attributes.pps || 0);
        }
        const node = document.getElementById('node-val');
        if(node) node.innerText = data.node || '-';
    },

    toggleAutoScroll() {
        state.autoScroll = !state.autoScroll;
        const btn = document.getElementById('scroll-state');
        if(btn) btn.innerText = state.autoScroll ? 'ON' : 'OFF';
        if(state.autoScroll) this.scrollToBottom();
    },

    clearLogs() {
        state.logs = [];
        this.render();
    }
};

window.addEventListener('resize', () => ui.render());
document.addEventListener('DOMContentLoaded', () => ui.render());
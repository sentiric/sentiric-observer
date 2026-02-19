const state = {
    logs:[],
    autoScroll: true
};

const ui = {
    render() {
        const wrapper = document.getElementById('console-wrapper');
        const content = document.getElementById('console-content');
        if (!wrapper || !content) return;

        const totalLogs = state.logs.length;
        const rowHeight = CONFIG.ROW_HEIGHT;

        // 1. Toplam Scroll Yüksekliğini Ayarla
        content.style.height = `${totalLogs * rowHeight}px`;

        // 2. Ekranda Görünen Kısmı Hesapla (Virtual Window)
        const startIndex = Math.max(0, Math.floor(wrapper.scrollTop / rowHeight) - 2);
        const visibleCount = Math.ceil(wrapper.clientHeight / rowHeight) + 4;
        const endIndex = Math.min(totalLogs, startIndex + visibleCount);

        const visibleLogs = state.logs.slice(startIndex, endIndex);

        // 3. Sadece Görünen HTML'i Üret (SUTS v4.0 Parser)
        content.innerHTML = visibleLogs.map((log, index) => {
            const actualIndex = startIndex + index;
            const y = actualIndex * rowHeight; // Satırın Y koordinatı
            
            // Veri Çıkartımı
            const time = log.ts ? new Date(log.ts).toLocaleTimeString('tr-TR', {hour12:false}) : '--:--:--';
            const sev = log.severity || 'INFO';
            const svc = (log.resource && log.resource.service_name) ? log.resource.service_name : 'unknown';
            const eventName = log.event || 'LOG';
            const traceId = log.trace_id ? `<span class="trace-id" title="${log.trace_id}"></span>` : '';
            const msg = log.message || '';
            
            return `
                <div class="log-row sev-${sev.toLowerCase()}" style="position: absolute; top: 0; left: 0; right: 0; transform: translateY(${y}px); height: ${rowHeight}px;">
                    <span class="time">${time}</span>
                    <span class="sev-badge">${sev}</span>
                    <span class="svc" title="${svc}">${svc}</span>
                    <span class="event" title="${eventName}">${eventName}</span>
                    <span class="msg">${traceId} ${this.escapeHtml(msg)}</span>
                </div>
            `;
        }).join('');
    },

    scrollToBottom() {
        const wrapper = document.getElementById('console-wrapper');
        if (wrapper && state.autoScroll) {
            wrapper.scrollTop = wrapper.scrollHeight;
        }
    },

    escapeHtml(text) {
        if (!text) return "";
        // Basit XSS Koruması
        return text.toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    },

    updateHeader(log) {
        document.getElementById('total-logs-val').innerText = state.logs.length;
        if(log.resource && log.resource.host_name) {
            document.getElementById('node-val').innerText = log.resource.host_name;
        }
    },

    toggleAutoScroll() {
        state.autoScroll = !state.autoScroll;
        const btnText = document.getElementById('scroll-state');
        const btnDiv = document.getElementById('btn-scroll');
        
        if (state.autoScroll) {
            btnText.innerText = 'ON';
            btnDiv.className = 'btn-active';
            this.scrollToBottom();
        } else {
            btnText.innerText = 'OFF';
            btnDiv.className = '';
        }
    },

    clearLogs() {
        state.logs =[];
        this.updateHeader({resource: {host_name: 'Cleared'}});
        this.render();
    }
};

// Başlangıç Kurulumları
window.addEventListener('resize', () => ui.render());

// Scroll dinleyicisi: Kullanıcı yukarı kaydırırsa auto-scroll'u kapat
document.getElementById('console-wrapper').addEventListener('scroll', (e) => {
    const el = e.target;
    // Eğer en alta çok yakın değilse ve autoScroll açıksa kapat
    if (state.autoScroll && el.scrollTop + el.clientHeight < el.scrollHeight - 50) {
        ui.toggleAutoScroll(); 
    }
});

document.addEventListener('DOMContentLoaded', () => {
    visualizer.init();
    ws.connect();
    
    // Virtual Scroll'un çalışması için manuel scroll tetikleyicisi
    setInterval(() => {
        if(state.logs.length > 0 && !state.autoScroll) {
            ui.render(); // Scroll pozisyonu değiştikçe ekranı boya
        }
    }, 100); // 100ms'de bir render kontrolü
});
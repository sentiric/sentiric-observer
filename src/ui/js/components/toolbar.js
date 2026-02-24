// src/ui/js/components/toolbar.js
import { Store } from '../store.js';

export class ToolbarComponent {
    constructor(matrixComponent) {
        this.matrix = matrixComponent; 
        
        this.el = {
            inpSearch: document.getElementById('filter-global'),
            selLevel: document.getElementById('filter-level'),
            btnNoise: document.getElementById('btn-toggle-noise'),
            btnPause: document.getElementById('btn-pause'),
            btnClear: document.getElementById('btn-clear'),
            btnExportMain: document.querySelector('.dropdown > .t-btn.primary'),
            dropdownContent: document.querySelector('.dropdown-content'),
            btnExpRaw: document.getElementById('btn-export-raw'),
            btnExpAi: document.getElementById('btn-export-ai')
        };

        this.bindEvents();
    }

    bindEvents() {
        this.el.inpSearch?.addEventListener('input', (e) => Store.dispatch('SET_SEARCH', e.target.value));
        this.el.selLevel?.addEventListener('change', (e) => Store.dispatch('SET_LEVEL', e.target.value));

        this.el.btnNoise?.addEventListener('click', (e) => {
            Store.dispatch('TOGGLE_NOISE');
            e.target.innerText = Store.state.controls.hideRtpNoise ? "🔇 NOISE: HIDDEN" : "🔊 NOISE: VISIBLE";
            e.target.classList.toggle('active', Store.state.controls.hideRtpNoise);
        });

        this.el.btnPause?.addEventListener('click', (e) => {
            Store.dispatch('TOGGLE_PAUSE');
            e.target.innerText = Store.state.status.isPaused ? "▶ RESUME" : "PAUSE";
            e.target.classList.toggle('danger', Store.state.status.isPaused);
            if(!Store.state.status.isPaused) this.matrix.shouldScroll = true;
        });

        this.el.btnClear?.addEventListener('click', () => {
            Store.dispatch('WIPE_DATA');
            this.matrix.wipe();
        });

        // Export Dropdown Menü
        if (this.el.btnExportMain && this.el.dropdownContent) {
            this.el.btnExportMain.addEventListener('click', (e) => {
                e.preventDefault();
                const isBlock = this.el.dropdownContent.style.display === 'block';
                this.el.dropdownContent.style.display = isBlock ? 'none' : 'block';
            });
            // Dışarı tıklandığında menüyü kapat
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.dropdown')) this.el.dropdownContent.style.display = 'none';
            });
        }

        this.el.btnExpRaw?.addEventListener('click', (e) => { e.preventDefault(); this.exportData('raw'); });
        this.el.btnExpAi?.addEventListener('click', (e) => { e.preventDefault(); this.exportData('ai'); });
    }

    exportData(type) {
        const state = Store.state;
        const trace = state.controls.lockedTraceId;
        
        // 1. Veri Kaynağını Belirle
        // Eğer Trace kilitliyse: Sadece o trace'e ait TÜM veriyi (RawLogs içinden) al.
        // Eğer Kilitli değilse: Ekranda ne görüyorsam (FilteredLogs) onu al.
        let dataToExport = trace 
            ? state.rawLogs.filter(l => (l.trace_id || l.attributes?.['sip.call_id']) === trace) 
            : [...state.filteredLogs]; // Kopyasını al
        
        if (dataToExport.length === 0) return alert("No data to export!");

        // 2. Zaman Akışını Garanti Altına Al (Kronolojik Sıralama)
        // Logların oluşma zamanına (ts) göre sırala. _idx de kullanılabilir ama ts evrenseldir.
        dataToExport.sort((a, b) => new Date(a.ts) - new Date(b.ts));

        // Dosya ismi için zaman damgası
        const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5);
        const nodeName = document.getElementById('node-name')?.innerText || 'local';
        const fileNameBase = `panopticon_${trace || 'global'}_${nodeName}_${timestamp}`;

        if (type === 'raw') {
            // --- RAW EXPORT (Kanıt Modu) ---
            // Hiçbir filtreleme yapma. Sniffer paketleri dahil her şeyi indir.
            const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
            this.downloadFile(blob, `${fileNameBase}_evidence.json`);
            
        } else if (type === 'ai') {
            // --- AI REPORT (Akıl Modu) ---
            // Sniffer paketlerini (RTP_PACKET) temizle. AI'ın bunlara ihtiyacı yok.
            // Ama Media Service logları (RTP_QOS, SESSION_START) kalsın!
            const aiData = dataToExport.filter(l => l.event !== 'RTP_PACKET');

            const lines = aiData.map(l => {
                // Mesajı temizle
                let cleanMsg = l.message.replace(/(\r\n|\n|\r)/gm, " ");
                if (cleanMsg.length > 200) cleanMsg = cleanMsg.substring(0, 200) + "...";
                
                return `[${l.ts.substring(11, 23)}] ${l.severity} | ${l.resource['service.name']} -> ${l.event}: ${cleanMsg}`;
            });

            const report = `# Sentiric AI Context Report\nGenerated: ${new Date().toISOString()}\nNode: ${nodeName}\nTrace: ${trace || 'Global Stream'}\n\n## Timeline Summary\n\`\`\`log\n${lines.join('\n')}\n\`\`\`\n\n## Instructions for AI\nAnalyze the timeline above for anomalies, latency issues, or SIP protocol errors. Look specifically for 'WARN' or 'ERROR' levels.`;
            
            const blob = new Blob([report], { type: 'text/markdown' });
            this.downloadFile(blob, `${fileNameBase}_report.md`);
        }
        
        // Menüyü kapat
        if (this.el.dropdownContent) this.el.dropdownContent.style.display = 'none';
    }

    downloadFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }
}
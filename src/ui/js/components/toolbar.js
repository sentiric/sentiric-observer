// src/ui/js/components/toolbar.js
import { Store } from '../store.js';

export class ToolbarComponent {
    constructor(matrixComponent) {
        this.matrix = matrixComponent; 
        
        this.el = {
            inpSearch: document.getElementById('filter-global'),
            btnNoise: document.getElementById('btn-toggle-noise'),
            btnPause: document.getElementById('btn-pause'),
            btnClear: document.getElementById('btn-clear'),
            btnExportMain: document.querySelector('.dropdown > .t-btn.primary'),
            dropdownContent: document.querySelector('.dropdown-content'),
            btnExpRaw: document.getElementById('btn-export-raw'),
            btnExpAi: document.getElementById('btn-export-ai'),
            selService: document.getElementById('filter-service') // [YENİ]
        };

        // [ARCH-COMPLIANCE] Sentiric Mimari Katmanları
        this.LAYERS = {
            TELECOM: ['sip-sbc-service', 'sip-proxy-service', 'media-service', 'stream-gateway-service'],
            CORE: ['sip-b2bua-service', 'dialplan-service', 'user-service', 'workflow-service', 'agent-service', 'telephony-action-service'],
            AI: ['stt-gateway-service', 'stt-whisper-service', 'tts-gateway-service', 'tts-coqui-service', 'llm-gateway-service', 'llm-llama-service', 'dialog-service']
        };

        this.bindEvents();

        // [YENİ] Store'dan gelen knownServices'i dropdown'a bas
        Store.subscribe((state) => {
            if (this.el.selService && state.knownServices.size > this.el.selService.options.length - 1) {
                const currentVal = this.el.selService.value;
                let html = '<option value="ALL">ALL SERVICES</option>';
                Array.from(state.knownServices).sort().forEach(svc => {
                    html += `<option value="${svc}">${svc}</option>`;
                });
                this.el.selService.innerHTML = html;
                this.el.selService.value = currentVal;
            }
        });        
    }

    bindEvents() {
        // [YENİ] Dropdown değişimini Store'a bildir
        this.el.selService?.addEventListener('change', (e) => {
            Store.dispatch('SET_SERVICE_FILTER', e.target.value);
        });
                
        this.el.inpSearch?.addEventListener('input', (e) => Store.dispatch('SET_SEARCH', e.target.value));

        this.el.levelCheckboxes = document.querySelectorAll('.lvl-chk');
        this.el.levelCheckboxes?.forEach(chk => {
            chk.addEventListener('change', () => {
                const selectedLevels = Array.from(this.el.levelCheckboxes).filter(c => c.checked).map(c => c.value);
                Store.dispatch('SET_LEVELS', selectedLevels);
            });
        });

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

        if (this.el.btnExportMain && this.el.dropdownContent) {
            this.el.btnExportMain.addEventListener('click', (e) => {
                e.preventDefault();
                const isBlock = this.el.dropdownContent.style.display === 'block';
                this.el.dropdownContent.style.display = isBlock ? 'none' : 'block';
            });
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.dropdown')) this.el.dropdownContent.style.display = 'none';
            });
        }

        // İsimleri UI ile uyumlu yapıyoruz
        if(this.el.btnExpRaw) this.el.btnExpRaw.innerText = "📄 RAW JSON (DB Dump)";
        if(this.el.btnExpAi) this.el.btnExpAi.innerText = "🕵️ FORENSIC DOSSIER (Markdown)";

        this.el.btnExpRaw?.addEventListener('click', (e) => { e.preventDefault(); this.exportData('raw'); });
        this.el.btnExpAi?.addEventListener('click', (e) => { e.preventDefault(); this.exportData('dossier'); });

        const mobileBtn = document.getElementById('mobile-menu-btn');
        if (mobileBtn) {
            mobileBtn.addEventListener('click', () => document.getElementById('workspace').classList.toggle('mobile-left-open'));
        }
    }

    categorizeService(svcName) {
        if (this.LAYERS.TELECOM.includes(svcName)) return "EDGE & TELECOM";
        if (this.LAYERS.CORE.includes(svcName)) return "CORE LOGIC";
        if (this.LAYERS.AI.includes(svcName)) return "AI ENGINES";
        return "INFRA / OTHER";
    }

    exportData(type) {
        const state = Store.state;
        let dataToExport = [...state.filteredLogs]; 
        
        if (dataToExport.length === 0) return alert("No data to export!");

        dataToExport.sort((a, b) => new Date(a.ts) - new Date(b.ts));

        const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5);
        const nodeName = document.getElementById('node-name')?.innerText || 'local';
        const traceId = state.controls.lockedTraceId || 'Global_Capture';
        const fileNameBase = `sentiric_forensic_${traceId}_${timestamp}`;

        if (type === 'raw') {
            const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
            this.downloadFile(blob, `${fileNameBase}.json`);
            
        } else if (type === 'dossier') {
            const aiData = dataToExport.filter(l => l.event !== 'RTP_PACKET');
            
            let minTs = new Date(aiData[0].ts).getTime();
            let maxTs = new Date(aiData[aiData.length-1].ts).getTime();
            let totalMs = maxTs - minTs;
            
            let errors = aiData.filter(l => l.severity === "ERROR" || l.severity === "FATAL");

            let report = `# 🕵️ SENTIRIC SOVEREIGN FORENSIC DOSSIER\n`;
            report += `> **Generated:** ${new Date().toISOString()}\n> **Node:** ${nodeName}\n> **Trace ID:** ${traceId}\n> **Total Duration:** ${totalMs} ms\n\n`;

            // 1. EXECUTIVE SUMMARY
            report += `## 1. Executive Summary\n`;
            report += `- **Total Events Captured:** ${aiData.length}\n`;
            report += `- **Critical Errors:** ${errors.length}\n`;
            if (errors.length > 0) {
                report += `\n### 🚨 Critical Failure Points\n`;
                errors.forEach(e => {
                    report += `- **[+${new Date(e.ts).getTime() - minTs}ms]** \`${e.resource['service.name']}\`: ${e.message}\n`;
                });
            }

            // 2. ARCHITECTURAL LAYER BREAKDOWN
            report += `\n## 2. Layer Analysis\n`;
            let layerStats = { "EDGE & TELECOM": 0, "CORE LOGIC": 0, "AI ENGINES": 0, "INFRA / OTHER": 0 };
            aiData.forEach(l => layerStats[this.categorizeService(l.resource['service.name'])]++);
            
            report += `| Layer | Events Processed | Status |\n|---|---|---|\n`;
            Object.keys(layerStats).forEach(layer => {
                let status = layerStats[layer] > 0 ? "Active 🟢" : "Idle ⚪";
                report += `| **${layer}** | ${layerStats[layer]} | ${status} |\n`;
            });

            // 3. AI GENERATION VELOCITY (Sadece LLM olanlar)
            let aiSpans = aiData.filter(l => l._ts_start && l.event.includes('STREAM'));
            if (aiSpans.length > 0) {
                report += `\n## 3. AI Performance Diagnostics\n`;
                report += `| Engine | Duration (ms) | Est. Tokens | Speed (ms/tok) |\n|---|---|---|---|\n`;
                aiSpans.forEach(l => {
                    const dur = new Date(l.ts).getTime() - new Date(l._ts_start).getTime();
                    const toks = Math.max(Math.floor(l.message.length / 4), 1);
                    report += `| \`${l.resource['service.name']}\` | ${dur} | ~${toks} | **${(dur/toks).toFixed(1)}** |\n`;
                });
            }

            // 4. FULL EVENT TIMELINE
            report += `\n## 4. Master Event Timeline\n\`\`\`log\n`;
            aiData.forEach(l => {
                let cleanMsg = l.message.replace(/(\r\n|\n|\r)/gm, " ");
                let relMs = new Date(l.ts).getTime() - minTs;
                report += `[+${relMs.toString().padStart(5, '0')}ms] [${l.severity}] ${l.resource['service.name']} -> ${l.event}: ${cleanMsg}\n`;
            });
            report += `\`\`\`\n\n--- END OF REPORT ---`;
            
            const blob = new Blob([report], { type: 'text/markdown' });
            this.downloadFile(blob, `${fileNameBase}.md`);
        }
        
        if (this.el.dropdownContent) this.el.dropdownContent.style.display = 'none';
    }

    downloadFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
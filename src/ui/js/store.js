// src/ui/js/store.js
import { CONFIG } from './config.js'; // CONFIG'in module export edilebilir olması lazım

/**
 * SENTIRIC REACTIVE STORE (Zero-Dependency)
 * Uygulamanın tek hakikat kaynağı (Single Source of Truth).
 * Tüm veri manipülasyonları sadece burada yapılır.
 */
export const Store = {
    // 1. STATE (Bellek)
    state: {
        rawLogs: [],         // Tüm gelen loglar
        filteredLogs: [],    // Ekranda gösterilecek loglar
        activeTraces: new Map(), // Çağrı bazlı gruplama
        
        status: {
            pps: 0,
            isPaused: false,
            isSnifferLive: false,
            socketConnected: false,
        },
        
        controls: {
            lockedTraceId: null, // Odaklanılan çağrı
            selectedLogIdx: null, // Detayı açılan log
            hideRtpNoise: true,
            globalSearch: "",
            levelFilter: "ALL"
        }
    },

    // 2. LISTENERS (Aboneler - UI bileşenleri burayı dinler)
    listeners: [],
    subscribe(callback) {
        this.listeners.push(callback);
    },

    // 3. ACTIONS (Veriyi değiştiren tek yöntem)
    dispatch(actionType, payload) {
        let shouldRender = false;

        switch(actionType) {
            case 'INGEST_LOG':
                if (this.state.status.isPaused) break;
                
                const log = payload;
                log._idx = Date.now() + Math.random(); // Benzersiz ID ata

                // Gelen logu direkt sona ekle. Sıralamayı applyFilters yapacak.
                this.state.rawLogs.push(log);
                
                // RAM Koruması (Fazla logları en baştan sil)
                if (this.state.rawLogs.length > (CONFIG?.MAX_LOGS || 10000)) {
                    this.state.rawLogs.shift();
                }

                this.state.status.pps++;
                this.extractTrace(log);
                shouldRender = this.applyFilters();
                break;

            case 'TOGGLE_PAUSE':
                this.state.status.isPaused = !this.state.status.isPaused;
                shouldRender = true;
                break;

            case 'TOGGLE_NOISE':
                this.state.controls.hideRtpNoise = !this.state.controls.hideRtpNoise;
                shouldRender = this.applyFilters();
                break;

            case 'SET_SEARCH':
                this.state.controls.globalSearch = payload.toLowerCase();
                shouldRender = this.applyFilters();
                break;

            case 'LOCK_TRACE':
                this.state.controls.lockedTraceId = payload;
                shouldRender = this.applyFilters();
                break;

            case 'UNLOCK_TRACE':
                this.state.controls.lockedTraceId = null;
                shouldRender = this.applyFilters();
                break;

            case 'SELECT_LOG':
                this.state.controls.selectedLogIdx = payload;
                shouldRender = true;
                break;

            case 'WIPE_DATA':
                this.state.rawLogs = [];
                this.state.filteredLogs = [];
                this.state.activeTraces.clear();
                this.state.controls.lockedTraceId = null;
                this.state.controls.selectedLogIdx = null;
                shouldRender = true;
                break;

            case 'TICK_1S': // Her saniye metrikleri sıfırlar
                this.state.status.pps = 0;
                shouldRender = true;
                break;
            
            case 'SET_LEVEL': // <--- YENİ EKLENDİ
                this.state.controls.levelFilter = payload;
                shouldRender = this.applyFilters();
                break;
                
        }

        // Eğer kritik bir veri değiştiyse UI'a haber ver
        if (shouldRender) {
            this.notify();
        }
    },

    // --- INTERNAL LOGIC ---

    extractTrace(log) {
        const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
        if (!tid || tid === "unknown") return;
        
        if (!this.state.activeTraces.has(tid)) {
            this.state.activeTraces.set(tid, { start: log.ts, count: 1 });
        } else {
            this.state.activeTraces.get(tid).count++;
        }
    },

    applyFilters() {
        // --- CHRONOS FIX v2.0: HER SEFERİNDE TAM SIRALAMA ---
        // Bu, ağ gecikmelerinden kaynaklanan sıralama hatalarını kesin olarak çözer.
        this.state.rawLogs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        
        const { globalSearch, hideRtpNoise, lockedTraceId, levelFilter } = this.state.controls;
        
        this.state.filteredLogs = this.state.rawLogs.filter(log => {
            const tid = log.trace_id || (log.attributes && log.attributes['sip.call_id']);
            
            if (lockedTraceId && tid !== lockedTraceId) return false;
            if (!lockedTraceId && hideRtpNoise && (log.event === "RTP_PACKET" || log.smart_tags?.includes('RTP'))) return false;
            // INFO ???
            if (levelFilter === "WARN" && log.severity !== "WARN" && log.severity !== "ERROR" && log.severity !== "FATAL") return false;
            if (levelFilter === "ERROR" && log.severity !== "ERROR" && log.severity !== "FATAL") return false;
            
            // Kapsamlı Arama: Sadece ana alanlar değil, tüm JSON'u stringe çevirip içinde ara.
            if (globalSearch) {
                const searchableString = JSON.stringify(log).toLowerCase();
                if (!searchableString.includes(globalSearch)) return false;
            }
            return true;
        });

        return true;
    },

    notify() {
        // Tüm UI bileşenlerine "Veri değişti, kendini güncelle" emri gönderir.
        this.listeners.forEach(fn => fn(this.state));
    }
};
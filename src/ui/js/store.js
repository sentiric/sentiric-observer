// src/ui/js/store.js
import { CONFIG } from './config.js';

/**
 * SENTIRIC REACTIVE STORE v6.1
 * Fixed: Noise filter logic refined (Service Logs vs Raw Packets)
 */
export const Store = {
    state: {
        rawLogs: [],         
        filteredLogs: [],    
        activeTraces: new Map(), 
        
        status: {
            pps: 0,
            isPaused: false,
            socketConnected: false,
        },
        
        controls: {
            lockedTraceId: null, 
            selectedLogIdx: null, 
            hideRtpNoise: true, // Varsayılan: Gürültü Gizli
            globalSearch: "",
            levelFilter: "ALL"
        }
    },

    listeners: [],
    
    subscribe(callback) {
        this.listeners.push(callback);
    },

    dispatch(actionType, payload) {
        let shouldRender = false;

        switch(actionType) {
            case 'INGEST_LOG':
                if (this.state.status.isPaused) break;
                
                const log = payload;
                if (!log._idx) log._idx = Date.now() + Math.random();

                this.state.rawLogs.push(log);
                
                if (this.state.rawLogs.length > CONFIG.MAX_LOGS) {
                    const excess = this.state.rawLogs.length - CONFIG.MAX_LOGS;
                    this.state.rawLogs.splice(0, excess);
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

            case 'TICK_1S': 
                this.state.status.pps = 0;
                shouldRender = true;
                break;
            
            case 'SET_LEVEL': 
                this.state.controls.levelFilter = payload;
                shouldRender = this.applyFilters();
                break;
        }

        if (shouldRender) this.notify();
    },

    extractTrace(log) {
        const tid = log.trace_id || log.attributes?.['sip.call_id'];
        if (!tid || tid === "unknown") return;
        
        const hasAudio = !!log.attributes?.['rtp.audio_b64'];

        if (!this.state.activeTraces.has(tid)) {
            this.state.activeTraces.set(tid, { 
                start: log.ts, 
                count: 1, 
                hasAudio: hasAudio 
            });
        } else {
            const trace = this.state.activeTraces.get(tid);
            trace.count++;
            if (hasAudio) trace.hasAudio = true; 
        }
    },

    applyFilters() {
        // v5.0 CHRONOS FIX: Zaman/Index sıralaması
        this.state.rawLogs.sort((a, b) => a._idx - b._idx);
        
        const { globalSearch, hideRtpNoise, lockedTraceId, levelFilter } = this.state.controls;
        
        this.state.filteredLogs = this.state.rawLogs.filter(log => {
            const tid = log.trace_id || log.attributes?.['sip.call_id'];
            
            // 1. TRACE LOCK (Odaklanma)
            if (lockedTraceId && tid !== lockedTraceId) return false;
            
            // 2. NOISE FILTER (Gürültü Filtresi) - KRİTİK DÜZELTME BURADA
            // Eskiden 'RTP' etiketi olan her şeyi siliyorduk (Media Service dahil).
            // Şimdi sadece Sniffer'dan gelen ham paketleri (RTP_PACKET) siliyoruz.
            // DTMF olayları (event 101) veya Media Service INFO logları korunur.
            if (!lockedTraceId && hideRtpNoise) {
                if (log.event === "RTP_PACKET") return false;
            }
            
            // 3. LEVEL FILTER
            if (levelFilter === "WARN" && log.severity !== "WARN" && log.severity !== "ERROR" && log.severity !== "FATAL") return false;
            if (levelFilter === "ERROR" && log.severity !== "ERROR" && log.severity !== "FATAL") return false;
            
            // 4. GLOBAL SEARCH
            if (globalSearch) {
                const searchableString = JSON.stringify(log).toLowerCase();
                if (!searchableString.includes(globalSearch)) return false;
            }
            return true;
        });

        return true;
    },

    notify() {
        this.listeners.forEach(fn => fn(this.state));
    }
};
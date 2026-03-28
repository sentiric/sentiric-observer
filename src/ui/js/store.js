// src/ui/js/store.js
import { CONFIG } from './config.js';

export const Store = {
    state: {
        rawLogs: [],         
        filteredLogs:[],    
        activeTraces: new Map(), 
        
        status: {
            pps: 0,
            isPaused: false,
            socketConnected: false,
        },
        
        controls: {
            lockedTraceId: null, 
            selectedLogIdx: null, 
            hideRtpNoise: true,
            globalSearch: "",
            levelFilters: ["INFO", "WARN", "ERROR", "FATAL"], // [YENİ]: Çoklu filtre desteği
            forceRender: false
        }
    },

    listeners:[],
    
    subscribe(callback) {
        this.listeners.push(callback);
    },

    dispatch(actionType, payload) {
        let shouldRender = false;

        switch(actionType) {
            case 'INGEST_LOG': // Artık BATCH alır (Array)
                if (this.state.status.isPaused) break;
                
                const logs = payload;
                logs.forEach(log => {
                    // --- V14.0 SMART FOLDING (AI TOKEN COLLAPSE) ---
                    // Eğer bu log bir span parçasıysa ve LLM/STT/CHUNK içeriyorsa DOM'u kurtar.
                    if (log.span_id && (log.event.includes('STREAM') || log.event.includes('CHUNK') || log.event.includes('TOKEN'))) {
                        const existingLog = this.state.rawLogs.find(l => l.span_id === log.span_id && l.event === log.event);
                        if (existingLog) {
                            // Cümleye token ekle
                            existingLog.message += log.message;
                            existingLog.ts = log.ts; // Zamanı güncelle
                            // NOT: Matrix.js'in bu değişikliği algılaması için "forceRender" tetikleyebiliriz
                            // Ancak şimdilik sadece string büyüsün, sonraki adımda Virtual DOM bunu halledecek.
                            this.state.controls.forceRender = true;
                            return; // Yeni satır açmadan çık.
                        }
                    }

                    // Standart işlem
                    if (!log._idx) log._idx = Date.now() + Math.random();
                    this.state.rawLogs.push(log);
                    this.state.status.pps++;
                    this.extractTrace(log);
                });

                // Hafıza Temizliği
                if (this.state.rawLogs.length > CONFIG.MAX_LOGS) {
                    const excess = this.state.rawLogs.length - CONFIG.MAX_LOGS;
                    this.state.rawLogs.splice(0, excess);
                }

                shouldRender = this.applyFilters();
                break;

            case 'TOGGLE_PAUSE':
                this.state.status.isPaused = !this.state.status.isPaused;
                shouldRender = true;
                break;

            case 'TOGGLE_NOISE':
                this.state.controls.hideRtpNoise = !this.state.controls.hideRtpNoise;
                this.state.controls.forceRender = true; 
                shouldRender = this.applyFilters();
                break;

            case 'SET_SEARCH':
                this.state.controls.globalSearch = payload.toLowerCase();
                this.state.controls.forceRender = true; 
                shouldRender = this.applyFilters();
                break;

            case 'LOCK_TRACE':
                this.state.controls.lockedTraceId = payload;
                this.state.controls.forceRender = true; 
                shouldRender = this.applyFilters();
                break;

            case 'UNLOCK_TRACE':
                this.state.controls.lockedTraceId = null;
                this.state.controls.forceRender = true; 
                shouldRender = this.applyFilters();
                break;

            case 'SELECT_LOG':
                this.state.controls.selectedLogIdx = payload;
                shouldRender = true;
                break;

            case 'WIPE_DATA':
                this.state.rawLogs = [];
                this.state.filteredLogs =[];
                this.state.activeTraces.clear();
                this.state.controls.lockedTraceId = null;
                this.state.controls.selectedLogIdx = null;
                this.state.controls.forceRender = true;
                shouldRender = true;
                break;

            case 'TICK_1S': 
                this.state.status.pps = 0;
                shouldRender = true;
                break;
            
            case 'SET_LEVELS': // [YENİ]: Checkbox entegrasyonu
                this.state.controls.levelFilters = payload;
                this.state.controls.forceRender = true;
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
        this.state.rawLogs.sort((a, b) => a._idx - b._idx);
        
        const { globalSearch, hideRtpNoise, lockedTraceId, levelFilters } = this.state.controls;
        
        this.state.filteredLogs = this.state.rawLogs.filter(log => {
            const tid = log.trace_id || log.attributes?.['sip.call_id'];
            
            if (lockedTraceId && tid !== lockedTraceId) return false;
            
            if (!lockedTraceId && hideRtpNoise) {
                if (log.event === "RTP_PACKET") return false;
            }
            
            // [SMART FILTERING]: Sadece Checkbox'ta seçili olan seviyeleri göster
            if (levelFilters && !levelFilters.includes(log.severity)) return false;
            
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
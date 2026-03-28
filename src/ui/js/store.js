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
            levelFilters: ["INFO", "WARN", "ERROR", "FATAL"],
            forceRender: false,
            dirtyLogs: new Set() // [YENİ] Sadece güncellenecek DOM elementlerinin ID'leri
        }
    },

    listeners:[],
    
    subscribe(callback) {
        this.listeners.push(callback);
    },

    dispatch(actionType, payload) {
        let shouldRender = false;
        this.state.controls.dirtyLogs.clear(); // Her frame'de temizle

        switch(actionType) {
            case 'INGEST_LOG': 
                if (this.state.status.isPaused) break;
                
                const logs = payload;
                logs.forEach(log => {
                    // --- V14.0 SMART FOLDING (AI TOKEN COLLAPSE) ---
                    // Eğer bu log bir span parçasıysa (LLM/STT/CHUNK/STREAM) DOM'u kurtar.
                    if (log.span_id && (log.event.includes('STREAM') || log.event.includes('CHUNK') || log.event.includes('TOKEN'))) {
                        const existingLog = this.state.rawLogs.find(l => l.span_id === log.span_id && l.event === log.event);
                        if (existingLog) {
                            // Token'ı mevcut cümleye ekle
                            existingLog.message += log.message;
                            existingLog.ts = log.ts; // Son token geliş zamanı
                            
                            // DOM'da sadece bu satırın güncellenmesi için işaretle
                            this.state.controls.dirtyLogs.add(existingLog._idx);
                            this.extractTrace(existingLog); // Trace istatistiklerini güncelle
                            return; // Yeni satır açmadan çık.
                        }
                    }

                    // Standart işlem (Yeni satır)
                    if (!log._idx) log._idx = Date.now() + Math.random();
                    this.state.rawLogs.push(log);
                    this.state.status.pps++;
                    this.extractTrace(log);
                });

                // Hafıza Temizliği (Eskileri Uçur)
                if (this.state.rawLogs.length > CONFIG.MAX_LOGS) {
                    const excess = this.state.rawLogs.length - CONFIG.MAX_LOGS;
                    this.state.rawLogs.splice(0, excess);
                    this.state.controls.forceRender = true; // Liste kırpıldığı için tam render şart
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
                this.state.filteredLogs = [];
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
            
            case 'SET_LEVELS':
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
        const isError = log.severity === "ERROR" || log.severity === "FATAL";
        const isWarn = log.severity === "WARN";

        if (!this.state.activeTraces.has(tid)) {
            this.state.activeTraces.set(tid, { 
                start: log.ts, 
                count: 1, 
                hasAudio: hasAudio,
                errorCount: isError ? 1 : 0,
                warnCount: isWarn ? 1 : 0,
                urgencyScore: isError ? 5 : (isWarn ? 2 : 0)
            });
        } else {
            const trace = this.state.activeTraces.get(tid);
            trace.count++;
            if (hasAudio) trace.hasAudio = true; 
            if (isError) { trace.errorCount++; trace.urgencyScore += 5; }
            if (isWarn) { trace.warnCount++; trace.urgencyScore += 2; }
            // Güncel tutmak için map'i set etmeye gerek yok, obje referansı üzerinden güncellenir.
        }
    },

    applyFilters() {
        // Eğer sadece varolan satırlara token eklenmişse (dirtyLogs var ama forceRender yoksa)
        // filtrelemeyi baştan yapmaya gerek yok, performansı koru.
        if (this.state.controls.dirtyLogs.size > 0 && !this.state.controls.forceRender) {
            return true; 
        }

        this.state.rawLogs.sort((a, b) => a._idx - b._idx);
        const { globalSearch, hideRtpNoise, lockedTraceId, levelFilters } = this.state.controls;
        
        this.state.filteredLogs = this.state.rawLogs.filter(log => {
            const tid = log.trace_id || log.attributes?.['sip.call_id'];
            if (lockedTraceId && tid !== lockedTraceId) return false;
            if (!lockedTraceId && hideRtpNoise) {
                if (log.event === "RTP_PACKET") return false;
            }
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
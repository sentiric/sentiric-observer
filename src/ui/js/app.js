// src/ui/js/app.js
"use strict";

import { Store } from './store.js';
import { LogStream } from './websocket.js';
import { CONFIG } from './config.js';

// Components & Features
import { Visualizer } from './features/visualizer.js';
import { HeaderComponent } from './components/header.js';
import { ToolbarComponent } from './components/toolbar.js';
import { InspectorComponent } from './components/inspector.js';
import { TraceListComponent } from './components/trace_list.js';
import { MatrixComponent } from './components/matrix.js';

const App = {
    renderPending: false,
    
    init() {
        console.log("💠 Sovereign UI Orchestrator v6.0 Booting...");
        
        // 1. Bağımsız Özellikler (Features)
        this.viz = new Visualizer();
        
        // 2. UI Bileşenleri (Dependency Injection ile birbirine bağlanır)
        this.header = new HeaderComponent();
        this.inspector = new InspectorComponent(this.viz);
        this.traceList = new TraceListComponent(this.inspector);
        
        // Matrix, Toolbar'ın Wipe ve Inspector'un Open fonksiyonlarını kullanacağı için onlara referans alır
        this.matrix = new MatrixComponent(this.inspector, this.traceList);
        this.toolbar = new ToolbarComponent(this.matrix);

        // 3. Render Döngüsü (60FPS Frame Throttling)
        Store.subscribe((state) => {
            if (!this.renderPending) {
                this.renderPending = true;
                requestAnimationFrame(() => {
                    this.header.render(state);
                    this.traceList.render(state);
                    this.matrix.render(state);
                    this.renderPending = false;
                });
            }
        });

        // 4. Periyodik Görevler
        setInterval(() => Store.dispatch('TICK_1S'), 1000);
        
        // 5. Ağı Başlat
        this.startNetwork();
    },

    startNetwork() {
        new LogStream(CONFIG.WS_URL, 
            (log) => {
                Store.dispatch('INGEST_LOG', log);
                
                // Gelen log RTP ise ve Visualizer açıksa veriyi besle
                if (this.viz.isActive && log.event === "RTP_PACKET") {
                    this.viz.pushData(log.attributes?.['net.packet_len'] || 0);
                }
            },
            (isOnline) => {
                this.header.setSocketStatus(isOnline);
            }
        ).connect();
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
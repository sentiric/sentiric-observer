import { CONFIG } from '../config.js';

export class HeaderComponent {
    constructor() {
        this.el = {
            pps: document.getElementById('pps-val'),
            buffer: document.getElementById('buffer-val'),
            total: document.getElementById('total-val'),
            status: document.getElementById('ws-status'),
            snifferToggle: document.getElementById('sniffer-toggle'),
            snifferStatus: document.getElementById('sniffer-status'),
            nodeName: document.getElementById('node-name'),
            vBadge: document.querySelector('.v-badge')
        };

        this.init();
    }

    init() {
        this.loadSystemConfig();
        this.checkSnifferState();
        this.bindEvents();
    }

    async loadSystemConfig() {
        try {
            const response = await fetch('/api/config');
            const config = await response.json();
            if (this.el.vBadge) this.el.vBadge.innerText = `v${config.version}`;
            if (this.el.nodeName) this.el.nodeName.innerText = config.node_name;
        } catch (e) {
            console.error("Failed to load system config:", e);
        }
    }

    checkSnifferState() {
        fetch('/api/sniffer/status').then(r => r.json()).then(data => {
            if (this.el.snifferToggle) this.el.snifferToggle.checked = data.active;
            this.updateSnifferUI(data.active);
        }).catch(() => {});
    }

    bindEvents() {
        this.el.snifferToggle?.addEventListener('change', (e) => {
            const isActive = e.target.checked;
            fetch(`/api/sniffer/${isActive ? 'enable' : 'disable'}`, { method: 'POST' })
            .then(r => r.json()).then(() => {
                this.updateSnifferUI(isActive);
            }).catch(() => {});
        });
    }

    updateSnifferUI(isActive) {
        if (this.el.snifferStatus) {
            this.el.snifferStatus.innerText = isActive ? "LIVE" : "STANDBY";
            this.el.snifferStatus.className = `pod-val ${isActive ? 'recording' : 'standby'}`;
        }
    }

    setSocketStatus(isOnline) {
        if (this.el.status) {
            this.el.status.innerText = isOnline ? "ONLINE" : "OFFLINE";
            this.el.status.className = `status-pill ${isOnline ? 'online' : 'offline'}`;
        }
    }

    render(state) {
        if (this.el.pps) this.el.pps.innerText = state.status.pps;
        if (this.el.total) this.el.total.innerText = state.rawLogs.length;
        if (this.el.buffer) {
            const pct = Math.round((state.rawLogs.length / CONFIG.MAX_LOGS) * 100);
            this.el.buffer.innerText = `${pct}%`;
        }
    }
}
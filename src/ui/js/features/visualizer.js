import { CONFIG } from '../config.js';

export class Visualizer {
    constructor() {
        this.scopeCanvas = document.getElementById('scope-chart');
        this.scopeCtx = this.scopeCanvas ? this.scopeCanvas.getContext('2d') : null;
        this.data = new Array(CONFIG.CHART_POINTS || 150).fill(0);
        this.isActive = false;
        this.animationId = null;
        
        if (this.scopeCanvas) {
            this.resize();
            window.addEventListener('resize', () => this.resize());
        }
    }
    
    resize() {
        if(!this.scopeCanvas) return;
        this.scopeCanvas.width = this.scopeCanvas.offsetWidth || 400;
        this.scopeCanvas.height = this.scopeCanvas.offsetHeight || 60;
    }
    
    pushData(val) {
        this.data.push(val);
        this.data.shift();
    }

    start() {
        if (this.isActive || !this.scopeCtx) return;
        this.isActive = true;
        this.resize();
        this.animateScope();
    }

    stop() {
        this.isActive = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    animateScope() {
        if (!this.isActive) return;

        const ctx = this.scopeCtx;
        const w = this.scopeCanvas.width;
        const h = this.scopeCanvas.height;
        
        ctx.clearRect(0, 0, w, h);
        
        ctx.strokeStyle = '#00ff9d';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 5;
        ctx.shadowColor = 'rgba(0, 255, 157, 0.8)';
        
        ctx.beginPath();
        const step = w / (this.data.length - 1);
        const max = Math.max(10, ...this.data); 
        
        this.data.forEach((val, i) => {
            const y = h - ((val / max) * h * 0.8) - (h * 0.1);
            if (i === 0) ctx.moveTo(0, y);
            else ctx.lineTo(i * step, y);
        });
        ctx.stroke();
        
        this.animationId = requestAnimationFrame(() => this.animateScope());
    }
}
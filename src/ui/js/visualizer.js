// src/ui/js/visualizer.js

export const visualizer = {
    scopeCanvas: null,
    scopeCtx: null,
    audioCanvas: null,
    audioCtx: null,
    data: new Array(100).fill(0),
    audioActive: false,
    
    init() {
        this.scopeCanvas = document.getElementById('scope-chart');
        this.audioCanvas = document.getElementById('audio-viz');
        
        if (this.scopeCanvas) {
            this.scopeCtx = this.scopeCanvas.getContext('2d');
            this.resize();
            this.animateScope();
        }
        if (this.audioCanvas) {
            this.audioCtx = this.audioCanvas.getContext('2d');
        }
    },
    
    resize() {
        if(!this.scopeCanvas) return;
        this.scopeCanvas.width = this.scopeCanvas.offsetWidth;
        this.scopeCanvas.height = this.scopeCanvas.offsetHeight;
    },
    
    pushData(val) {
        this.data.push(val);
        this.data.shift();
    },

    startAudioViz() {
        this.audioActive = true;
        this.animateAudio();
    },

    stopAudioViz() {
        this.audioActive = false;
    },

    animateScope() {
        const ctx = this.scopeCtx;
        const w = this.scopeCanvas.width;
        const h = this.scopeCanvas.height;
        
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#00ff9d';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#00ff9d';
        
        ctx.beginPath();
        const step = w / (this.data.length - 1);
        const max = Math.max(20, ...this.data);
        
        this.data.forEach((val, i) => {
            const y = h - ((val / max) * h * 0.7) - (h * 0.15);
            if (i === 0) ctx.moveTo(0, y);
            else ctx.lineTo(i * step, y);
        });
        ctx.stroke();
        
        requestAnimationFrame(() => this.animateScope());
    },

    animateAudio() {
        if (!this.audioActive || !this.audioCtx) return;
        
        const ctx = this.audioCtx;
        const w = this.audioCanvas.width = this.audioCanvas.offsetWidth;
        const h = this.audioCanvas.height = this.audioCanvas.offsetHeight;
        
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#a855f7';
        
        const barCount = 40;
        const gap = 2;
        const barWidth = (w / barCount) - gap;
        
        for (let i = 0; i < barCount; i++) {
            // Gerçekçi jitter/ses dalgası simülasyonu
            const barHeight = Math.random() * h * 0.8;
            ctx.fillRect(i * (barWidth + gap), (h - barHeight) / 2, barWidth, barHeight);
        }
        
        requestAnimationFrame(() => this.animateAudio());
    }
};
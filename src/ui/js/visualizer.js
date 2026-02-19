const visualizer = {
    canvas: null,
    ctx: null,
    data: new Array(CONFIG.CHART_POINTS).fill(0),

    init() {
        this.canvas = document.getElementById('pulse-chart');
        if(!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.animate();
    },

    ping() {
        // Yeni log geldiğinde grafiği hafif zıplat
        this.data.push(Math.random() * 40 + 60);
        this.data.shift();
    },

    animate() {
        if (!this.canvas) return;
        this.canvas.width = this.canvas.offsetWidth;
        this.canvas.height = this.canvas.offsetHeight;
        
        // Grafiği sola kaydır
        this.data.push(0);
        this.data.shift();

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        
        const step = this.canvas.width / (this.data.length - 1);
        const max = 100;

        this.data.forEach((v, i) => {
            const x = i * step;
            // Sıfırsa ortada düz çizgi, değer varsa zıplama
            const y = v === 0 ? this.canvas.height / 2 : this.canvas.height - (v / max * this.canvas.height * 0.8);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        
        ctx.stroke();
        requestAnimationFrame(() => this.animate());
    }
};
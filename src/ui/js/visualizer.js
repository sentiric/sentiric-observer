const visualizer = {
    canvas: null,
    ctx: null,
    data: new Array(CONFIG.CHART_POINTS).fill(0),

    init() {
        this.canvas = document.getElementById('pulse-chart');
        this.ctx = this.canvas.getContext('2d');
        this.animate();
    },

    update(val) {
        this.data.push(val);
        this.data.shift();
    },

    animate() {
        if (!this.canvas) return;
        this.canvas.width = this.canvas.offsetWidth;
        this.canvas.height = this.canvas.offsetHeight;
        
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        ctx.strokeStyle = '#bc8cff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        const step = this.canvas.width / (this.data.length - 1);
        const max = Math.max(...this.data, 100);

        this.data.forEach((v, i) => {
            const x = i * step;
            const y = this.canvas.height - (v / max * this.canvas.height * 0.7) - 10;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        
        ctx.stroke();
        requestAnimationFrame(() => this.animate());
    }
};
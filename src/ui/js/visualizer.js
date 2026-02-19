const visualizer = {
    canvas: null,
    ctx: null,
    data: [],
    maxPoints: 100, // Son 100 saniyeyi göster

    init() {
        this.canvas = document.getElementById('pulse-chart');
        this.ctx = this.canvas.getContext('2d');
        // Initial empty data
        this.data = new Array(this.maxPoints).fill(0);
        this.animate();
    },

    pushData(val) {
        this.data.push(val);
        if (this.data.length > this.maxPoints) this.data.shift();
    },

    animate() {
        if (!this.canvas) return;

        // Resize
        this.canvas.width = this.canvas.offsetWidth;
        this.canvas.height = this.canvas.offsetHeight;

        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        // Grid Lines
        ctx.strokeStyle = '#30363d';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
        ctx.stroke();

        // Data Line
        ctx.strokeStyle = '#2ea043'; // Green Line
        ctx.lineWidth = 2;
        ctx.beginPath();

        // Normalize Data (Max value 50 PPS varsayalım, ama dinamik scale)
        const maxVal = Math.max(10, Math.max(...this.data) * 1.2);
        const step = w / (this.maxPoints - 1);

        this.data.forEach((val, i) => {
            const x = i * step;
            const y = h - ((val / maxVal) * h);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        
        ctx.stroke();

        // Area Fill
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.fillStyle = 'rgba(46, 160, 67, 0.1)';
        ctx.fill();

        requestAnimationFrame(this.animate.bind(this));
    }
};
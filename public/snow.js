const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Snow {
  constructor(overlay, canvas) {
    this.overlay = overlay; this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.frame = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
  }
  async start(preview = false) {
    this.overlay.hidden = false; this.overlay.classList.remove('whiteout');
    this.overlay.querySelector('p').textContent = preview ? 'Just a little snowfall preview…' : 'A little North Pole magic…';
    this.overlay.querySelector('small').textContent = preview ? 'Your picture will stay just as it is' : 'Your picture is on its way';
    const bounds = this.overlay.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = bounds.width * dpr; this.canvas.height = bounds.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = bounds.width; this.height = bounds.height;
    this.particles = Array.from({ length: 160 }, () => ({ x: Math.random() * this.width, y: Math.random() * this.height, r: 1 + Math.random() * 4, speed: 70 + Math.random() * 140, phase: Math.random() * 6 }));
    this.last = performance.now();
    if (!this.reduced.matches) this.tick(this.last);
    await new Promise(requestAnimationFrame); this.overlay.classList.add('visible');
  }
  tick(now) {
    const dt = Math.min((now - this.last) / 1000, .05); this.last = now;
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (const flake of this.particles) {
      flake.x += flake.speed * dt * 2; flake.y += (flake.speed * .35 + Math.sin(now / 650 + flake.phase) * 20) * dt;
      if (flake.x > this.width + 10) flake.x = -10;
      if (flake.y > this.height + 10) flake.y = -10;
      this.ctx.beginPath(); this.ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2); this.ctx.fillStyle = '#fff'; this.ctx.fill();
    }
    this.frame = requestAnimationFrame(time => this.tick(time));
  }
  async reveal(replace) {
    this.overlay.classList.add('whiteout'); await sleep(this.reduced.matches ? 0 : 450);
    replace(); await sleep(this.reduced.matches ? 0 : 300); await this.stop();
  }
  async stop() {
    this.overlay.classList.remove('visible'); await sleep(this.reduced.matches ? 0 : 500);
    cancelAnimationFrame(this.frame); this.frame = null; this.overlay.hidden = true; this.overlay.classList.remove('whiteout');
  }
}

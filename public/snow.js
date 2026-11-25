const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Snow {
  constructor(overlay, canvas) {
    this.overlay = overlay; this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.frame = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
  }
  async start(preview = false) {
    clearTimeout(this.lakeTimer);
    cancelAnimationFrame(this.frame);
    this.overlay.hidden = false; this.overlay.classList.remove('whiteout', 'at-lake');
    this.atLake = false;
    this.overlay.querySelector('p').textContent = preview ? 'Just a little snowfall preview…' : 'A little North Pole magic…';
    this.overlay.querySelector('small').textContent = preview ? 'Your picture will stay just as it is' : 'Your picture is on its way';
    const bounds = this.overlay.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = bounds.width * dpr; this.canvas.height = bounds.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = bounds.width; this.height = bounds.height;
    this.particles = Array.from({ length: 240 }, () => ({ x: Math.random() * this.width, y: Math.random() * this.height, r: 1.5 + Math.random() * 5, speed: 110 + Math.random() * 200, phase: Math.random() * 6 }));
    this.startedAt = this.last = performance.now();
    if (!this.reduced.matches) this.tick(this.last);
    await new Promise(requestAnimationFrame); this.overlay.classList.add('visible');
    this.lakeTimer = setTimeout(() => {
      this.atLake = true; this.overlay.classList.add('at-lake');
      this.overlay.querySelector('p').textContent = 'A little stop at the North Pole…';
      this.overlay.querySelector('small').textContent = preview ? 'Watch our friends fishing on the ice' : 'Our friend is bringing your picture to life';
      if (this.reduced.matches) this.drawLake(0);
    }, this.reduced.matches ? 0 : 1700);
  }
  drawLake(now) {
    const ctx = this.ctx, w = this.width, h = this.height;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#132f58'); sky.addColorStop(.55, '#6fb6c8'); sky.addColorStop(1, '#e1f7f8');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e9f7ec';
    for (let i = 0; i < 26; i++) { ctx.beginPath(); ctx.arc((i * 137 % 997) / 997 * w, (i * 73 % 211) / 500 * h, i % 3 === 0 ? 2 : 1, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#a9d8e3'; ctx.beginPath(); ctx.moveTo(0, h * .58);
    for (let i = 0; i <= 8; i++) ctx.lineTo(i * w / 8, h * (i % 2 ? .38 : .58));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill();
    const ocean = ctx.createLinearGradient(0, h * .56, 0, h);
    ocean.addColorStop(0, '#326f8b'); ocean.addColorStop(1, '#102f50');
    ctx.fillStyle = ocean; ctx.fillRect(0, h * .56, w, h * .44);
    // Short travelling wavelets, with open water between irregular ice floes.
    ctx.strokeStyle = '#79b8c755'; ctx.lineWidth = 2;
    for (let i = 0; i < 38; i++) {
      const x = ((i * 173 + now / 65) % (w + 80)) - 40;
      const y = h * (.58 + (i * 37 % 100) / 245);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 12, y - 3, x + 28, y); ctx.stroke();
    }
    for (let i = 0; i < 13; i++) {
      const x = ((i * 227 + now / 150) % (w + 120)) - 60;
      const y = h * (.6 + (i * 29 % 100) / 260);
      const size = 13 + (i % 4) * 9;
      this.iceFloe(x, y, size, size * .45);
    }
    const scale = Math.min(w / 520, h / 700);
    for (let i = 0; i < 3; i++) {
      const glide = Math.sin(now / 6500 + i * 2) * w * .045;
      const x = w * (.23 + i * .25) + glide, y = h * (.69 + (i % 2) * .08) + Math.sin(now / 1700 + i) * 3;
      ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
      this.iceFloe(-6, 20, 39, 18);
      ctx.fillStyle = i % 2 ? '#b94c60' : '#267d72'; ctx.beginPath(); ctx.roundRect(-14, -30, 28, 37, 10); ctx.fill();
      ctx.fillStyle = '#f4d3b1'; ctx.beginPath(); ctx.arc(0, -40, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = i % 2 ? '#e5ad4e' : '#b94c60'; ctx.beginPath(); ctx.moveTo(-16, -45); ctx.lineTo(5, -76); ctx.lineTo(16, -45); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff7d5'; ctx.beginPath(); ctx.arc(5, -76, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#233c54'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-8, 4); ctx.lineTo(-8, 17); ctx.lineTo(3, 17); ctx.moveTo(8, 4); ctx.lineTo(8, 14); ctx.lineTo(18, 14); ctx.stroke();
      const lift = Math.max(0, Math.sin(now / 1100 + i * 2)) * 28;
      ctx.strokeStyle = '#654b40'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(8, -18); ctx.quadraticCurveTo(35, -55 - lift, 46, -29 - lift); ctx.stroke();
      ctx.strokeStyle = '#ecfbff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(46, -29 - lift); ctx.lineTo(35, 15 - lift); ctx.stroke();
      if (lift > 9) { ctx.fillStyle = '#edbe68'; ctx.beginPath(); ctx.ellipse(35, 17 - lift, 9, 4, -.4, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(43, 15 - lift); ctx.lineTo(50, 9 - lift); ctx.lineTo(50, 22 - lift); ctx.fill(); }
      ctx.restore();
    }
  }
  iceFloe(x, y, width, height) {
    const ctx = this.ctx;
    const corners = [[-1, -.15], [-.65, -.8], [-.1, -.6], [.2, -1], [.85, -.45], [.6, .1], [1, .4], [.3, .85], [-.3, .6], [-.8, .9]];
    const path = offset => {
      ctx.beginPath();
      corners.forEach(([px, py], index) => {
        if (index === 0) ctx.moveTo(x + px * width, y + py * height + offset);
        else ctx.lineTo(x + px * width, y + py * height + offset);
      });
      ctx.closePath();
    };
    path(7); ctx.fillStyle = '#6ba9c4'; ctx.fill();
    path(0); ctx.fillStyle = '#e4f5f7'; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.strokeStyle = '#accfdf'; ctx.beginPath(); ctx.moveTo(x - width * .6, y - height * .3); ctx.lineTo(x - width * .1, y); ctx.lineTo(x + width * .2, y - height * .5); ctx.stroke();
  }
  tick(now) {
    const dt = Math.min((now - this.last) / 1000, .05); this.last = now;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.shadowBlur = 0;
    if (this.atLake) this.drawLake(now - this.startedAt);
    // A blue edge keeps white snow visible against blank drawing paper.
    this.ctx.shadowColor = '#527b9b';
    this.ctx.shadowBlur = 4;
    for (const flake of this.particles.slice(0, this.atLake ? 35 : 240)) {
      flake.x += flake.speed * dt * 2; flake.y += (flake.speed * .35 + Math.sin(now / 650 + flake.phase) * 20) * dt;
      if (flake.x > this.width + 10) flake.x = -10;
      if (flake.y > this.height + 10) flake.y = -10;
      this.ctx.beginPath(); this.ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2); this.ctx.fillStyle = '#fff'; this.ctx.fill();
    }
    this.frame = requestAnimationFrame(time => this.tick(time));
  }
  async reveal(replace) {
    // Fast image responses should still have a visible snowfall transition.
    if (!this.reduced.matches) await sleep(Math.max(0, 3800 - (performance.now() - this.startedAt)));
    clearTimeout(this.lakeTimer); this.atLake = false; this.overlay.classList.remove('at-lake');
    this.overlay.querySelector('p').textContent = 'Here comes your imagination…';
    await sleep(this.reduced.matches ? 0 : 650);
    this.overlay.classList.add('whiteout'); await sleep(this.reduced.matches ? 0 : 450);
    replace(); await sleep(this.reduced.matches ? 0 : 300); await this.stop();
  }
  async stop() {
    clearTimeout(this.lakeTimer);
    this.overlay.classList.remove('visible'); await sleep(this.reduced.matches ? 0 : 500);
    cancelAnimationFrame(this.frame); this.frame = null; this.overlay.hidden = true; this.overlay.classList.remove('whiteout', 'at-lake');
  }
}

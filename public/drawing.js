export class Drawing {
  constructor(canvas, onChange) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onChange = onChange;
    this.colour = '#be4147'; this.thickness = 8; this.tool = 'pen'; this.locked = false;
    this.hasContent = false; this.history = []; this.pointer = null;
    this.resize();
    this.white();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', event => this.begin(event));
    canvas.addEventListener('pointermove', event => this.move(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => this.end(event));
  }
  white() { this.ctx.fillStyle = '#ffffff'; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
  paint(image) {
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    const scale = Math.min(this.canvas.width / width, this.canvas.height / height);
    this.ctx.drawImage(image, (this.canvas.width - width * scale) / 2, (this.canvas.height - height * scale) / 2, width * scale, height * scale);
  }
  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2, 2048 / Math.max(bounds.width, bounds.height));
    const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.beforeResize?.();
    const copy = document.createElement('canvas'); copy.width = this.canvas.width; copy.height = this.canvas.height;
    copy.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas.width = width; this.canvas.height = height; this.white();
    if (this.hasContent) this.paint(copy);
  }
  snapshot() {
    this.history.push({ image: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height), hasContent: this.hasContent });
    if (this.history.length > 8) this.history.shift();
  }
  position(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * this.canvas.width / bounds.width, y: (event.clientY - bounds.top) * this.canvas.height / bounds.height };
  }
  begin(event) {
    if (this.locked || this.pointer !== null || event.button !== 0) return;
    event.preventDefault(); this.snapshot(); this.pointer = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId); this.previous = this.position(event);
    this.ctx.fillStyle = this.tool === 'eraser' ? '#ffffff' : this.colour;
    this.ctx.beginPath(); this.ctx.arc(this.previous.x, this.previous.y, this.width(event) / 2, 0, Math.PI * 2); this.ctx.fill();
    this.hasContent = true; this.onChange();
  }
  width(event) {
    const pressure = event.pointerType === 'pen' ? Math.max(.3, event.pressure) * 1.5 : 1;
    return this.thickness * pressure * (this.tool === 'eraser' ? 3 : 1);
  }
  move(event) {
    if (this.pointer !== event.pointerId || this.locked) return;
    for (const point of event.getCoalescedEvents?.() || [event]) {
      const next = this.position(point);
      this.ctx.beginPath(); this.ctx.moveTo(this.previous.x, this.previous.y); this.ctx.lineTo(next.x, next.y);
      this.ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.colour;
      this.ctx.lineWidth = this.width(point); this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round'; this.ctx.stroke(); this.previous = next;
    }
  }
  end(event) { if (this.pointer === event.pointerId) { this.pointer = null; this.onChange(); } }
  undo() {
    if (this.locked || !this.history.length) return;
    const previous = this.history.pop();
    this.restore(previous);
  }
  restore(previous) {
    if (previous.image.width === this.canvas.width && previous.image.height === this.canvas.height) this.ctx.putImageData(previous.image, 0, 0);
    else {
      const copy = document.createElement('canvas'); copy.width = previous.image.width; copy.height = previous.image.height;
      copy.getContext('2d').putImageData(previous.image, 0, 0); this.white(); this.paint(copy);
    }
    this.hasContent = previous.hasContent; this.onChange();
  }
  clear() {
    if (this.locked) return;
    this.snapshot(); this.white(); this.hasContent = false; this.onChange();
  }
  export() {
    const output = document.createElement('canvas'); output.width = 1536; output.height = 1024;
    const context = output.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1536, 1024);
    const scale = Math.min(1536 / this.canvas.width, 1024 / this.canvas.height);
    const width = this.canvas.width * scale, height = this.canvas.height * scale;
    context.drawImage(this.canvas, (1536 - width) / 2, (1024 - height) / 2, width, height);
    return output.toDataURL('image/png');
  }
  async decode(source) {
    const image = new Image(); image.src = source; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('That picture could not be opened.');
    return image;
  }
  replace(image) {
    this.snapshot(); this.white();
    this.paint(image);
    this.hasContent = true; this.onChange();
  }
  async upload(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP picture.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a picture smaller than 10 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = await this.decode(url);
      if (image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error('That picture has too many pixels. Try a smaller copy.');
      this.replace(image);
    } finally { URL.revokeObjectURL(url); }
  }
  starter() {
    if (this.locked) return;
    this.snapshot(); this.white();
    const ctx = this.ctx;
    ctx.save();
    const scale = Math.min(this.canvas.width / 1536, this.canvas.height / 1024);
    ctx.translate((this.canvas.width - 1536 * scale) / 2, (this.canvas.height - 1024 * scale) / 2); ctx.scale(scale, scale);
    const path = (data, colour, width = 9, fill) => {
      const p = new Path2D(data); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (fill) { ctx.fillStyle = fill; ctx.fill(p); } ctx.stroke(p);
    };
    // A deliberately unfinished pencil-like starting sketch, not a generated result.
    path('M405 634 Q535 706 810 667 Q959 647 1059 483 Q1091 447 1122 470 Q1117 500 1085 503', '#b84a51', 12);
    path('M405 634 L397 545 Q460 583 502 565 L527 626 Q741 669 881 581', '#b84a51', 10, '#fae9e4');
    path('M425 686 L463 766 M804 692 L840 763 M327 754 Q526 837 965 758 Q1111 731 1124 647 Q1102 619 1087 644', '#cfa451', 11);
    path('M610 617 Q590 468 714 460 Q798 471 808 605', '#b84a51', 10, '#f6d6d3');
    path('M643 448 Q598 361 660 328 Q736 294 764 373 Q777 437 713 458', '#917b69', 7, '#f7e4d1');
    path('M631 342 Q622 292 700 230 L772 333 Q721 306 631 342', '#b84a51', 9, '#e9a6a2');
    path('M638 397 Q690 436 749 391 Q735 500 691 510 Q648 478 638 397', '#c6cbbd', 7, '#fffffa');
    path('M654 370 L657 370 M721 365 L724 365', '#414c43', 12);
    path('M858 583 L849 502 L947 489 L966 558 M897 495 L908 578 M855 531 L951 517', '#6e9a80', 8, '#edf4ea');
    path('M351 380 L358 398 L380 405 L360 414 L354 435 L347 413 L328 405 L347 397 M1002 296 L1009 312 L1028 317 L1010 324 L1005 343 L997 325 L978 319 L997 312', '#d6ba73', 5);
    path('M329 823 Q630 850 1104 808', '#d5ddd3', 4);
    ctx.restore();
    this.hasContent = true; this.onChange();
  }
}

// Bounded pen strokes only: this cursor never controls the desktop or runs code.
export class DrawingCursor {
  constructor(board, element) { this.board = board; this.element = element; }
  draw(strokes, signal) {
    signal.throwIfAborted();
    const board = this.board, canvas = board.canvas, ctx = board.ctx;
    const before = { image: ctx.getImageData(0, 0, canvas.width, canvas.height), hasContent: board.hasContent };
    const bounds = canvas.getBoundingClientRect();
    const segments = strokes.flatMap(stroke => stroke.points.slice(1).map((point, index) => ({ from: stroke.points[index], to: point, colour: stroke.colour, width: stroke.width })));
    const totalLength = segments.reduce((sum, s) => sum + Math.hypot((s.to.x - s.from.x) * bounds.width / 1000, (s.to.y - s.from.y) * bounds.height / 1000), 0);
    const speed = Math.max(180, totalLength / 10);
    this.element.hidden = false;
    return new Promise((resolve, reject) => {
      let frame, index = 0, progress = 0, lastTime;
      const finish = error => {
        cancelAnimationFrame(frame); signal.removeEventListener('abort', abort); this.element.hidden = true;
        if (error) { board.restore(before); reject(error); }
        else { board.history.push(before); if (board.history.length > 8) board.history.shift(); board.hasContent = true; board.onChange(); resolve(); }
      };
      const abort = () => finish(signal.reason || new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      const tick = time => {
        let distance = Math.min(50, lastTime === undefined ? 16 : time - lastTime) * speed / 1000; lastTime = time;
        while (index < segments.length && distance > 0) {
          const s = segments[index];
          const length = Math.max(.01, Math.hypot((s.to.x - s.from.x) * bounds.width / 1000, (s.to.y - s.from.y) * bounds.height / 1000));
          const next = Math.min(1, progress + distance / length);
          const position = amount => ({ x: s.from.x + (s.to.x - s.from.x) * amount, y: s.from.y + (s.to.y - s.from.y) * amount });
          const from = position(progress), to = position(next);
          ctx.beginPath(); ctx.moveTo(from.x * canvas.width / 1000, from.y * canvas.height / 1000); ctx.lineTo(to.x * canvas.width / 1000, to.y * canvas.height / 1000);
          ctx.strokeStyle = s.colour; ctx.lineWidth = s.width * canvas.width / bounds.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
          this.element.style.left = `${to.x / 10}%`; this.element.style.top = `${to.y / 10}%`;
          // A partial segment consumes the entire frame budget. Subtracting
          // floating-point fractions can leave a tiny remainder and spin forever.
          distance = next < 1 ? 0 : Math.max(0, distance - (next - progress) * length); progress = next;
          if (progress === 1) { index++; progress = 0; }
        }
        if (index === segments.length) finish(); else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
  }
}

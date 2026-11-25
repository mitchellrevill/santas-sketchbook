export class Drawing {
  constructor(canvas, onChange) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onChange = onChange;
    this.colour = '#be4147'; this.thickness = 8; this.tool = 'pen'; this.locked = false;
    this.hasContent = false; this.history = []; this.pointer = null; this.revision = 0;
    this.resize();
    this.white();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', event => this.begin(event));
    canvas.addEventListener('pointermove', event => this.move(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => this.end(event));
  }
  white() { this.ctx.fillStyle = '#ffffff'; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
  changed() { this.revision++; this.onChange(); }
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
    this.revision++;
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
    event.preventDefault();
    if (this.tool === 'fill') { this.fillAt(this.position(event)); return; }
    this.snapshot(); this.pointer = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId); this.previous = this.position(event);
    this.ctx.fillStyle = this.tool === 'eraser' ? '#ffffff' : this.colour;
    this.ctx.beginPath(); this.ctx.arc(this.previous.x, this.previous.y, this.width(event) / 2, 0, Math.PI * 2); this.ctx.fill();
    this.hasContent = true; this.changed();
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
  end(event) { if (this.pointer === event.pointerId) { this.pointer = null; this.changed(); } }
  fillAt(position) {
    const width = this.canvas.width, height = this.canvas.height;
    const startX = Math.max(0, Math.min(width - 1, Math.floor(position.x)));
    const startY = Math.max(0, Math.min(height - 1, Math.floor(position.y)));
    const image = this.ctx.getImageData(0, 0, width, height), pixels = image.data;
    const start = startY * width + startX;
    const target = [...pixels.subarray(start * 4, start * 4 + 4)];
    const colour = [1, 3, 5].map(offset => parseInt(this.colour.slice(offset, offset + 2), 16));
    if (colour.every((value, index) => value === target[index]) && target[3] === 255) return;
    this.snapshot();
    const visited = new Uint8Array(width * height);
    const queue = new Uint32Array(width * height);
    let head = 0, tail = 1;
    queue[0] = start; visited[start] = 1;
    const enqueue = index => {
      if (visited[index]) return;
      visited[index] = 1;
      const offset = index * 4;
      if (target.every((value, channel) => Math.abs(pixels[offset + channel] - value) <= 24)) queue[tail++] = index;
    };
    while (head < tail) {
      const index = queue[head++], x = index % width, offset = index * 4;
      pixels[offset] = colour[0]; pixels[offset + 1] = colour[1]; pixels[offset + 2] = colour[2]; pixels[offset + 3] = 255;
      if (x > 0) enqueue(index - 1);
      if (x < width - 1) enqueue(index + 1);
      if (index >= width) enqueue(index - width);
      if (index < width * (height - 1)) enqueue(index + width);
    }
    this.ctx.putImageData(image, 0, 0);
    this.hasContent = true; this.changed();
  }
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
    this.hasContent = previous.hasContent; this.changed();
  }
  clear() {
    if (this.locked) return;
    this.snapshot(); this.white(); this.hasContent = false; this.changed();
  }
  export() {
    const output = document.createElement('canvas'); output.width = 1536; output.height = 1024;
    const context = output.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1536, 1024);
    const scale = Math.min(1536 / this.canvas.width, 1024 / this.canvas.height);
    const width = this.canvas.width * scale, height = this.canvas.height * scale;
    context.drawImage(this.canvas, (1536 - width) / 2, (1024 - height) / 2, width, height);
    return output.toDataURL('image/png');
  }
  visionSnapshot(source = this.canvas) {
    const bounds = this.canvas.getBoundingClientRect();
    const viewport = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
    const scale = Math.min(1024 / viewport.width, 1024 / viewport.height, 1);
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(viewport.width * scale));
    output.height = Math.max(1, Math.round(viewport.height * scale));
    output.getContext('2d').drawImage(source, 0, 0, output.width, output.height);
    // Measure ink separately from the vision image. Each cell covers 50 units
    // of the same 0..1000 coordinate system used by the pen tool.
    const sample = document.createElement('canvas');
    sample.width = 160;
    sample.height = 160;
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    sampleContext.drawImage(source, 0, 0, 160, 160);
    const pixels = sampleContext.getImageData(0, 0, 160, 160).data;
    const inkMap = Array.from({ length: 20 }, (_, row) => {
      let cells = '';
      for (let column = 0; column < 20; column++) {
        let ink = 0;
        for (let y = row * 8; y < row * 8 + 8; y++) {
          for (let x = column * 8; x < column * 8 + 8; x++) {
            const offset = (y * 160 + x) * 4;
            if (pixels[offset + 3] > 100 && Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 220) ink++;
          }
        }
        cells += ink >= 2 ? '#' : '.';
      }
      return cells;
    });
    return { image: output.toDataURL('image/png'), viewport, revision: this.revision, inkMap };
  }
  preview(strokes, exclusions) {
    const output = document.createElement('canvas');
    output.width = this.canvas.width; output.height = this.canvas.height;
    const ctx = output.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0);
    const bounds = this.canvas.getBoundingClientRect();
    for (const stroke of strokes) {
      // Reject segments crossing controls before paying for visual review.
      const paddingX = stroke.width / bounds.width * 500;
      const paddingY = stroke.width / bounds.height * 500;
      const points = stroke.fill ? [...stroke.points, stroke.points[0]] : stroke.points;
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1], to = points[index];
        for (const rect of exclusions) {
          if (segmentTouchesRect(from, to, {
            x: rect.x - paddingX, y: rect.y - paddingY,
            width: rect.width + paddingX * 2, height: rect.height + paddingY * 2,
          })) throw new Error('That drawing would cover the controls. Try a different location.');
        }
      }
      if (stroke.fill && exclusions.some(rect => [
        { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
        { x: rect.x, y: rect.y + rect.height }, { x: rect.x + rect.width, y: rect.y + rect.height },
      ].some(point => pointInPolygon(point, stroke.points)))) throw new Error('That filled shape would cover the controls. Try a different location.');
      paintStroke(ctx, stroke, output.width, output.height, bounds.width);
    }
    return this.visionSnapshot(output).image;
  }
  async decode(source) {
    const image = new Image(); image.src = source; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('That picture could not be opened.');
    return image;
  }
  replace(image) {
    this.snapshot(); this.white();
    this.paint(image);
    this.hasContent = true; this.changed();
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
    this.hasContent = true; this.changed();
  }
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index], b = points[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function paintStroke(ctx, stroke, width, height, cssWidth) {
  ctx.beginPath();
  stroke.points.forEach((point, index) => {
    const x = point.x * width / 1000, y = point.y * height / 1000;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  if (stroke.fill) { ctx.closePath(); ctx.fillStyle = stroke.fill; ctx.fill(); }
  ctx.strokeStyle = stroke.colour; ctx.lineWidth = stroke.width * width / cssWidth;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}

function segmentTouchesRect(from, to, rect) {
  let start = 0, end = 1;
  for (const [origin, delta, min, max] of [
    [from.x, to.x - from.x, rect.x, rect.x + rect.width],
    [from.y, to.y - from.y, rect.y, rect.y + rect.height],
  ]) {
    if (delta === 0) { if (origin < min || origin > max) return false; }
    else {
      const first = (min - origin) / delta, second = (max - origin) / delta;
      start = Math.max(start, Math.min(first, second));
      end = Math.min(end, Math.max(first, second));
      if (start > end) return false;
    }
  }
  return true;
}

// Bounded pen strokes only: this cursor never controls the desktop or runs code.
export class DrawingCursor {
  constructor(board, element) { this.board = board; this.element = element; }
  draw(strokes, signal) {
    signal.throwIfAborted();
    const board = this.board, canvas = board.canvas, ctx = board.ctx;
    const before = { image: ctx.getImageData(0, 0, canvas.width, canvas.height), hasContent: board.hasContent };
    const bounds = canvas.getBoundingClientRect();
    const segments = strokes.flatMap(stroke => {
      const points = stroke.fill ? [...stroke.points, stroke.points[0]] : stroke.points;
      return points.slice(1).map((point, index) => ({ from: points[index], to: point,
        colour: stroke.colour, width: stroke.width, stroke, last: index === points.length - 2 }));
    });
    const totalLength = segments.reduce((sum, s) => sum + Math.hypot((s.to.x - s.from.x) * bounds.width / 1000, (s.to.y - s.from.y) * bounds.height / 1000), 0);
    const speed = Math.max(180, totalLength / 10);
    this.element.hidden = false;
    return new Promise((resolve, reject) => {
      let frame, index = 0, progress = 0, lastTime;
      const finish = error => {
        cancelAnimationFrame(frame); signal.removeEventListener('abort', abort); this.element.hidden = true;
        if (error) { board.restore(before); reject(error); }
        else {
          // Animation draws partial segments, which accumulate antialiasing.
          // Commit the exact same paths as the reviewed offscreen preview.
          ctx.putImageData(before.image, 0, 0);
          for (const stroke of strokes) paintStroke(ctx, stroke, canvas.width, canvas.height, bounds.width);
          board.history.push(before);
          if (board.history.length > 8) board.history.shift();
          board.hasContent = true; board.changed(); resolve();
        }
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
          if (progress === 1) {
            if (s.last && s.stroke.fill) paintStroke(ctx, s.stroke, canvas.width, canvas.height, bounds.width);
            index++; progress = 0;
          }
        }
        if (index === segments.length) finish(); else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
  }
}

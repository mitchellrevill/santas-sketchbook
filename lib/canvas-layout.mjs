// Ink cells are measurements, not object names. Vision still determines what
// the marks represent. All returned rectangles use the pen's 0..1000 space.
export function canvasLayout(viewport, inkMap, exclusions = []) {
  const coordinates = {
    origin: 'top-left', xRange: [0, 1000], yRange: [0, 1000],
    cssPixelsPerXUnit: viewport.width / 1000,
    cssPixelsPerYUnit: viewport.height / 1000,
    circleExample: { radiusCssPixels: 40, radiusX: 40000 / viewport.width, radiusY: 40000 / viewport.height },
  };
  if (!inkMap) return { coordinates, measured: false };

  const occupied = inkMap.map(row => [...row].map(cell => cell === '#'));
  const seen = new Set();
  const occupiedRegions = [];
  for (let row = 0; row < 20; row++) {
    for (let column = 0; column < 20; column++) {
      if (!occupied[row][column] || seen.has(row * 20 + column)) continue;
      const queue = [[column, row]];
      seen.add(row * 20 + column);
      let left = column, right = column, top = row, bottom = row;
      for (let index = 0; index < queue.length; index++) {
        const [x, y] = queue[index];
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nextX = x + dx, nextY = y + dy, key = nextY * 20 + nextX;
          if (nextX < 0 || nextY < 0 || nextX >= 20 || nextY >= 20 || seen.has(key) || !occupied[nextY][nextX]) continue;
          seen.add(key); queue.push([nextX, nextY]);
        }
      }
      occupiedRegions.push({ x: left * 50, y: top * 50, width: (right - left + 1) * 50, height: (bottom - top + 1) * 50 });
    }
  }

  // Reserve whole measured regions, including the interior of hollow shapes,
  // and leave one cell of breathing room around existing art and controls.
  const reserved = [...occupiedRegions, ...exclusions];
  const blocked = Array.from({ length: 20 }, (_, row) => Array.from({ length: 20 }, (_, column) =>
    reserved.some(rect => column * 50 < rect.x + rect.width + 50 && (column + 1) * 50 > rect.x - 50
      && row * 50 < rect.y + rect.height + 50 && (row + 1) * 50 > rect.y - 50)));
  const candidates = [];
  for (let top = 0; top < 20; top++) {
    const freeColumns = Array(20).fill(true);
    for (let bottom = top; bottom < 20; bottom++) {
      for (let column = 0; column < 20; column++) freeColumns[column] &&= !blocked[bottom][column];
      let start = 0;
      for (let column = 0; column <= 20; column++) {
        if (column < 20 && freeColumns[column]) continue;
        if (column - start >= 3 && bottom - top >= 2) {
          candidates.push({ x: start * 50, y: top * 50, width: (column - start) * 50, height: (bottom - top + 1) * 50 });
        }
        start = column + 1;
      }
    }
  }
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  const freeRegions = [];
  for (const rect of candidates) {
    const duplicate = freeRegions.some(other => {
      const overlap = Math.max(0, Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x))
        * Math.max(0, Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y));
      return overlap / Math.min(rect.width * rect.height, other.width * other.height) > .65;
    });
    if (!duplicate) freeRegions.push(rect);
    if (freeRegions.length === 5) break;
  }
  return { coordinates, measured: true, occupiedRegions, freeRegions,
    note: 'Coarse ink bounds, not semantic objects. Free regions are options, not instructions. Use the original image and the requested relationship to choose placement.' };
}

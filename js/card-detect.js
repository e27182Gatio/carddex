// Phase 1: low-cost upright card detection on a grayscale ROI.
// Pure functions to allow deterministic tests without a camera.
function peak(from, to, score) {
  let pos = -1, power = 0;
  for (let i = from; i <= to; i++) {
    const p = score(i);
    if (p > power) { pos = i; power = p; }
  }
  return { pos, power };
}
export function detectCard(gray, w, h, aspect = 63 / 88) {
  if (!gray || gray.length !== w * h || w < 36 || h < 48) return null;
  const vert = (x) => {
    let sum = 0, n = 0;
    for (let y = Math.floor(h * .3); y < Math.floor(h * .7); y += 2) {
      sum += Math.abs(gray[y * w + x + 1] - gray[y * w + x - 1]); n++;
    }
    return sum / Math.max(1, n);
  };
  const horiz = (y) => {
    let sum = 0, n = 0;
    for (let x = Math.floor(w * .3); x < Math.floor(w * .7); x += 2) {
      sum += Math.abs(gray[(y + 1) * w + x] - gray[(y - 1) * w + x]); n++;
    }
    return sum / Math.max(1, n);
  };
  const l = peak(2, Math.floor(w * .39), vert);
  const r = peak(Math.floor(w * .61), w - 3, vert);
  const t = peak(2, Math.floor(h * .35), horiz);
  const b = peak(Math.floor(h * .65), h - 3, horiz);
  const box = { x: l.pos, y: t.pos, w: r.pos - l.pos, h: b.pos - t.pos };
  if (box.w < w * .45 || box.h < h * .52) return null;
  const ratio = (box.w / w) / (box.h / h) * aspect;
  if (ratio < .52 || ratio > .96) return null;
  if (Math.min(l.power, r.power, t.power, b.power) < 10) return null;
  let sum = 0, sq = 0, n = 0;
  for (let y = box.y + 4; y < box.y + box.h - 4; y += 3) {
    for (let x = box.x + 4; x < box.x + box.w - 4; x += 3) {
      const v = gray[y * w + x]; sum += v; sq += v * v; n++;
    }
  }
  if (!n) return null;
  const mean = sum / n, contrast = Math.sqrt(Math.max(0, sq / n - mean * mean));
  if (mean < 20 || mean > 246 || contrast < 9) return null;
  return { box, contrast, strength: Math.min(l.power, r.power, t.power, b.power) };
}
export function frameHash(gray, w, h, box) {
  let bits = "";
  for (let y = 0; y < 8; y++) {
    let prev = null;
    for (let x = 0; x < 9; x++) {
      const px = Math.min(w - 1, Math.floor(box.x + box.w * (.08 + .84 * x / 8)));
      const py = Math.min(h - 1, Math.floor(box.y + box.h * (.08 + .84 * (y + .5) / 8)));
      const v = gray[py * w + px];
      if (prev !== null) bits += v > prev ? "1" : "0";
      prev = v;
    }
  }
  return bits;
}
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}
export function frameMovement(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let n = 0, count = 0;
  for (let i = 0; i < a.length; i += 3) { n += Math.abs(a[i] - b[i]); count++; }
  return n / count;
}

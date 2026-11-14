import { TEXT_DEFAULT_COLOR } from './model.js';

const ACHROMATIC_SAT = 0.15;

function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0, light };
  const sat = d / (1 - Math.abs(2 * light - 1));
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, sat, light };
}

const hex2 = v => Math.round(v).toString(16).padStart(2, '0');

export function dominantColor(rgba) {
  const buckets = new Map();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let s = buckets.get(key);
    if (!s) buckets.set(key, (s = { n: 0, r: 0, g: 0, b: 0 }));
    s.n++; s.r += r; s.g += g; s.b += b;
  }
  let best = null, bestScore = -1;
  for (const s of buckets.values()) {
    const r = s.r / s.n, g = s.g / s.n, b = s.b / s.n;
    const score = s.n * (0.3 + hsl(r, g, b).sat);
    if (score > bestScore) { bestScore = score; best = [r, g, b]; }
  }
  if (!best) return TEXT_DEFAULT_COLOR;
  return '#' + best.map(hex2).join('');
}

export function colorSortKey(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const { hue, sat, light } = hsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return { group: sat < ACHROMATIC_SAT ? 1 : 0, hue, light };
}

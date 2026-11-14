// 브라우저 전용 캔버스 그리기. 테스트하지 않는다.
//
// createRenderer({scene, thumbB64}) -> {attach, setTargets, redraw, invalidateThumbs}
// - scene() -> {cards, view, selectedId, drag, mode}. drag.rect가 있으면 그 카드는 그 자리에 그린다.
// - thumbB64(cardId) -> Promise<string|null>. 썸네일 base64(data: 접두 없음).
// - attach(surface|null): client.surfaces.on이 준 표면. visible이 false이면 그리기 루프를 멈춘다.
// - setTargets(Map<cardId, rect>, animate): 카드의 목표 자리. animate이면 지금 자리에서 300ms ease-out으로 옮긴다.
// - invalidateThumbs(): 썸네일 shard가 바뀌었을 때. 다음 그리기에서 base64 길이를 다시 보고 다르면 새로 디코드한다.

import { toScreen } from './layout.js';

const ANIM_MS = 300;
const BG = '#e8e5df';
const PAPER = '#f3efe6';
const INK = '#3b3833';
const MUTED = '#77736c';
const LOADING = '#d9d5ce';
const PLACEHOLDER = '#cbc7c0';
const LINK_BG = '#fbfaf7';
const SELECT = '#2f6fde';
const RADIUS = 6;
const FONT = 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const BADGE = { youtube: '▶', video: '🎞', pinterest: '📌', text: '✎', link: '🔗' };

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

function b64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function ellipsize(ctx, text, maxW) {
  const s = String(text ?? '');
  if (ctx.measureText(s).width <= maxW) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + '…';
}

// 글자 단위로 줄을 나눈다(한국어는 띄어쓰기 없이도 줄이 길다).
function wrap(ctx, text, maxW, maxLines) {
  const lines = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        lines.push(line);
        if (lines.length >= maxLines) return lines;
        line = '';
      }
      line += ch;
    }
    lines.push(line);
    if (lines.length >= maxLines) return lines;
  }
  return lines;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url ?? ''); }
}

export function createRenderer({ scene, thumbB64 }) {
  let surface = null;
  let onResize = null;
  let raf = 0;
  let targets = new Map();
  let anim = null; // {from: Map, start}
  let thumbGen = 0;
  const bitmaps = new Map(); // cardId -> {len, bmp, gen, pending}

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function currentRect(id, t) {
    const to = targets.get(id);
    if (!to) return null;
    if (!anim) return to;
    const from = anim.from.get(id);
    if (!from) return to;
    const k = Math.min(1, (t - anim.start) / ANIM_MS);
    return k >= 1 ? to : lerpRect(from, to, easeOut(k));
  }

  function schedule() {
    if (raf || !surface || !surface.visible) return;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function frame() {
    raf = 0;
    if (!surface || !surface.visible) return;
    const t = now();
    draw(t);
    if (anim && t - anim.start < ANIM_MS) schedule();
    else anim = null;
  }

  function bitmapFor(card) {
    let e = bitmaps.get(card.id);
    if (!e) { e = { len: -1, bmp: null, gen: -1, pending: false }; bitmaps.set(card.id, e); }
    if (e.gen !== thumbGen && !e.pending) refresh(card.id, e);
    return e.bmp;
  }

  function refresh(id, e) {
    e.pending = true;
    const gen = thumbGen;
    Promise.resolve()
      .then(() => thumbB64(id))
      .then(async (b64) => {
        if (!b64) {
          e.bmp?.close?.();
          e.bmp = null;
          e.len = -1;
          return;
        }
        if (e.bmp && e.len === b64.length) return;
        const bmp = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/jpeg' }));
        e.bmp?.close?.();
        e.bmp = bmp;
        e.len = b64.length;
        schedule();
      })
      .catch(() => {})
      .finally(() => {
        e.gen = gen;
        e.pending = false;
        if (gen !== thumbGen) schedule(); // 기다리는 동안 다시 바뀌었으면 다음 그리기에서 또 본다
      });
  }

  function drawCover(ctx, bmp, s) {
    const k = Math.max(s.w / bmp.width, s.h / bmp.height);
    const w = bmp.width * k, h = bmp.height * k;
    ctx.drawImage(bmp, s.x + (s.w - w) / 2, s.y + (s.h - h) / 2, w, h);
  }

  function drawText(ctx, card, s) {
    ctx.fillStyle = PAPER;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    const pad = 10;
    if (s.w > 40 && s.h > 30) {
      ctx.fillStyle = INK;
      ctx.font = `13px ${FONT}`;
      ctx.textBaseline = 'top';
      const lineH = 18;
      const maxLines = Math.max(1, Math.floor((s.h - pad * 2 - 14) / lineH));
      const lines = wrap(ctx, card.text ?? card.title, s.w - pad * 2, maxLines);
      lines.forEach((l, i) => ctx.fillText(ellipsize(ctx, l, s.w - pad * 2), s.x + pad, s.y + pad + i * lineH));
    }
    const r = Math.max(3, Math.min(6, s.w / 20));
    ctx.beginPath();
    ctx.arc(s.x + s.w - pad - r, s.y + s.h - pad - r, r, 0, Math.PI * 2);
    ctx.fillStyle = card.color || '#9e9e9e';
    ctx.fill();
  }

  function drawLink(ctx, card, s) {
    ctx.fillStyle = LINK_BG;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (s.w < 40 || s.h < 30) return;
    const pad = 10;
    ctx.textBaseline = 'top';
    ctx.fillStyle = INK;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(ellipsize(ctx, hostOf(card.url) || card.title, s.w - pad * 2), s.x + pad, s.y + s.h / 2 - 18);
    ctx.fillStyle = MUTED;
    ctx.font = `11px ${FONT}`;
    ctx.fillText(ellipsize(ctx, card.url, s.w - pad * 2), s.x + pad, s.y + s.h / 2 + 2);
  }

  function drawPlaceholder(ctx, card, s) {
    ctx.fillStyle = PLACEHOLDER;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (s.w < 40 || s.h < 30) return;
    ctx.fillStyle = INK;
    ctx.font = `12px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, card.title, s.w - 20), s.x + 10, s.y + s.h / 2);
  }

  function drawBadge(ctx, card, s) {
    const b = BADGE[card.kind];
    if (!b || s.w < 32 || s.h < 32) return;
    ctx.font = `12px ${FONT}`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(b).width + 10;
    roundRect(ctx, s.x + 6, s.y + 6, w, 20, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.fillText(b, s.x + 11, s.y + 16);
  }

  function drawNote(ctx, card, s) {
    if (!card.note || s.w < 40 || s.h < 40) return;
    const h = 22;
    ctx.fillStyle = 'rgba(30,28,25,0.62)';
    ctx.fillRect(s.x, s.y + s.h - h, s.w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, card.note, s.w - 12), s.x + 6, s.y + s.h - h / 2);
  }

  function drawCard(ctx, card, s, selected, manual) {
    ctx.save();
    roundRect(ctx, s.x, s.y, s.w, s.h, RADIUS);
    ctx.shadowColor = 'rgba(0,0,0,0.12)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = LOADING;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();
    if (card.hasThumb) {
      const bmp = bitmapFor(card);
      if (bmp) drawCover(ctx, bmp, s);
    } else if (card.kind === 'text') drawText(ctx, card, s);
    else if (card.kind === 'link' || card.kind === 'youtube' || card.kind === 'pinterest') drawLink(ctx, card, s);
    else drawPlaceholder(ctx, card, s);
    drawBadge(ctx, card, s);
    drawNote(ctx, card, s);
    ctx.restore();
    if (selected) {
      ctx.save();
      roundRect(ctx, s.x - 1.5, s.y - 1.5, s.w + 3, s.h + 3, RADIUS + 1.5);
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (manual) {
        // 크기 조절 손잡이
        ctx.beginPath();
        ctx.moveTo(s.x + s.w, s.y + s.h - 12);
        ctx.lineTo(s.x + s.w, s.y + s.h);
        ctx.lineTo(s.x + s.w - 12, s.y + s.h);
        ctx.closePath();
        ctx.fillStyle = SELECT;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function draw(t) {
    const { canvas, cssWidth, cssHeight, dpr } = surface;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sc = scene();
    const manual = sc.mode !== 'sorted';
    for (const card of sc.cards) {
      const r = sc.drag?.cardId === card.id && sc.drag.rect && sc.drag.moved ? sc.drag.rect : currentRect(card.id, t) ?? card.manual;
      if (!r) continue;
      const s = toScreen(sc.view, r);
      if (s.x > cssWidth || s.y > cssHeight || s.x + s.w < 0 || s.y + s.h < 0) continue;
      drawCard(ctx, card, s, card.id === sc.selectedId, manual);
    }
  }

  return {
    attach(next) {
      if (surface && onResize) surface.resize.removeEventListener('resize', onResize);
      stop();
      surface = next;
      onResize = null;
      if (!surface) return;
      onResize = () => { if (surface.visible) schedule(); else stop(); };
      surface.resize.addEventListener('resize', onResize);
      schedule();
    },
    setTargets(map, animate = false) {
      // 애니메이션 중에 배치가 다시 바뀌어도(다른 PC 등) 지금 보이는 자리에서 새 목표로 이어 간다.
      if (animate || anim) {
        const t = now();
        const from = new Map();
        for (const id of map.keys()) {
          const r = currentRect(id, t);
          if (r) from.set(id, r);
        }
        anim = { from, start: t };
      }
      targets = new Map(map);
      for (const id of [...bitmaps.keys()]) {
        if (!targets.has(id)) { bitmaps.get(id).bmp?.close?.(); bitmaps.delete(id); }
      }
      schedule();
    },
    redraw: schedule,
    invalidateThumbs() {
      thumbGen++;
      schedule();
    },
    get surface() { return surface; },
  };
}

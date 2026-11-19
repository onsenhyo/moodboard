// 브라우저 전용 캔버스 그리기. 순수한 부분(그리는 순서, 카드 매트, 묶음 이름)은 drawplan.js에 두고 테스트한다.
//
// createRenderer({scene, thumbB64, theme, gifs, pageVisible}) -> {attach, setTargets, redraw, invalidateThumbs}
// - scene() -> {cards, groups, view, selectedId, selectedGroupId, drag, mode, bg}.
//   bg는 보드 배경('#rrggbb'). 없으면 테마 bg를 쓴다(theme.js boardTheme). 글 카드의 paper는 paperFor로 칠한다.
//   drag.rect가 있으면 그 카드(또는 묶음)는 그 자리에 그린다. 묶음을 끌 때는 drag.cards의 자리에 카드를 그린다.
// - thumbB64(cardId) -> Promise<string|null>. 썸네일 base64(data: 접두 없음).
// - theme() -> THEMES의 한 값(theme.js). 그릴 때마다 묻는다.
// - gifs: gifanim.js의 createGifPlayer. anim 카드는 썸네일 대신 지금 프레임을 그린다. 화면에 anim 카드가 있고
//   표면과 페이지(pageVisible())가 보이는 동안만 약 30fps로 다시 그리고, 아니면 쉰다(animDelay).
// - attach(surface|null): client.surfaces.on이 준 표면. visible이 false이면 그리기 루프를 멈춘다.
// - setTargets(Map<cardId, rect>, animate): 카드의 목표 자리. animate이면 지금 자리에서 300ms ease-out으로 옮긴다.
// - invalidateThumbs(): 썸네일 shard가 바뀌었을 때. 다음 그리기에서 base64 길이를 다시 보고 다르면 새로 디코드한다.
// - 사진은 card.crop(crop.js)의 원본 사각형만 사진 칸에 cover로 그린다.
// - scene().crop = {id, base, rect}이면 자르기 화면을 그린다: 원본 전체(base가 사진 칸에 맞는 자리), 바깥 어둡게,
//   accent 색 틀과 손잡이 8개, 안내 글. cropLayout()은 마지막으로 그린 {img, card} 화면 rect(없으면 null).
// - thumbSize(cardId) -> {width, height} | null: 디코드한 썸네일 크기.
//
// 모든 사각형은 각지게 그린다(둥근 모서리 없음).

import { toScreen } from './layout.js';
import { THEMES, groupDotColor, boardTheme, paperFor } from './theme.js';
import { cropSourceRect, cropImageRect, CROP_HINT } from './crop.js';
import { animDelay } from './gifanim.js';
import { drawList, cardChrome, groupBox, groupLabel, groupMembers, groupToggle, cardLabel, cardMemo, wrapLines } from './drawplan.js';

const ANIM_MS = 300;
const HANDLE_PX = 12;
const GROUP_LABEL_LEFT = 10; // 목업 left:10px
const GROUP_DOT_PX = 7;
const GROUP_DOT_GAP = 6;
const GROUP_TOGGLE_FONT = '12px system-ui, -apple-system, sans-serif';
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

// 사각형 안쪽에 1px 선을 긋는다(카드 크기를 넘지 않게).
function strokeInside(ctx, color, s) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(s.x + 0.5, s.y + 0.5, Math.max(0, s.w - 1), Math.max(0, s.h - 1));
  ctx.restore();
}

function setLetterSpacing(ctx, v) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = v;
}

const docVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

// 사진 카드에서 그릴 원본 사각형(원본 픽셀). 카드 crop {x,y,w,h}(0..1, crop.js)를 그림 크기에 맞춰 바꾼다.
// 정지 썸네일과 GIF 프레임이 같은 길을 지나므로 움직이는 GIF도 자른 대로 그린다. 자르지 않았으면 그림 전체.
export function photoSource(card, img) {
  const w = img.naturalWidth || img.displayWidth || img.width;
  const h = img.naturalHeight || img.displayHeight || img.height;
  return cropSourceRect(card?.crop, w, h);
}

export function createRenderer({ scene, thumbB64, theme = () => THEMES.light, gifs = null, pageVisible = docVisible }) {
  let surface = null;
  let onResize = null;
  let raf = 0;
  let animTimer = 0;
  let animOnScreen = 0; // 마지막 그리기에서 화면에 있던 anim 카드 수
  let targets = new Map();
  let anim = null; // {from: Map, start}
  let thumbGen = 0;
  const bitmaps = new Map(); // cardId -> {len, bmp, gen, pending}
  // 배율 1 글꼴의 글 폭. 아랫단 줄 나누기가 프레임마다 재므로 모아 둔다.
  const widths = new Map();
  let mctx = null;
  let cropLayout = null;
  const measure = (text, font) => {
    const key = font + '\n' + text;
    let w = widths.get(key);
    if (w === undefined) {
      if (widths.size > 20000) widths.clear();
      mctx.font = font;
      w = mctx.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };

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
    clearTimeout(animTimer);
    animTimer = 0;
  }

  function frame() {
    raf = 0;
    if (!surface || !surface.visible) return;
    const t = now();
    draw(t);
    if (anim && t - anim.start < ANIM_MS) schedule();
    else anim = null;
    // 움직이는 GIF: 다음 프레임을 약 30fps로 잡는다. 화면에 없거나 숨으면 잡지 않는다.
    const wait = animDelay({
      animating: animOnScreen > 0, surfaceVisible: surface.visible, pageVisible: pageVisible(), sinceLastMs: now() - t,
    });
    if (wait !== null && !animTimer) animTimer = setTimeout(() => { animTimer = 0; schedule(); }, wait);
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

  // --- 바탕 ---

  // 바탕은 변환 없이 backing store 전체를 칠한다. 가장자리 한 픽셀도 비워 두지 않는다
  // (비면 쉘 .ks-canvas의 어두운 바탕이 비친다).
  function drawBackground(ctx, th, view, w, h, dpr) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    const g = th.grid;
    if (!g) return;
    // 점 격자는 세계 좌표 간격이라 끌고 확대하면 함께 움직인다. 너무 촘촘해지면 간격을 두 배로 늘린다.
    let step = g.step * view.scale;
    while (step < 10) step *= 2;
    const ox = ((-view.x * view.scale) % step + step) % step;
    const oy = ((-view.y * view.scale) % step + step) % step;
    const r = g.r ?? 1;
    ctx.fillStyle = g.dot;
    for (let y = oy; y < h + step; y += step) {
      for (let x = ox; x < w + step; x += step) ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  // --- 묶음 ---

  function drawGroup(ctx, th, group, s, members) {
    const box = groupBox(group, s);
    ctx.save();
    ctx.fillStyle = th.groupFill;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = th.groupLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(0, box.w - 1), Math.max(0, box.h - 1));

    // 접기 글리프: interaction.js의 접기 판정 영역(상자 안 왼쪽 위 24×28) 가운데
    const tg = groupToggle(group, box);
    ctx.font = th.uiFont ?? GROUP_TOGGLE_FONT;
    ctx.fillStyle = th.groupLabelInk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tg.glyph, tg.cx, tg.cy);
    ctx.textAlign = 'left';

    const label = groupLabel(th, group, members.length);
    ctx.font = th.groupLabelFont;
    setLetterSpacing(ctx, th.groupLabelSpacing ?? '0px');
    ctx.fillStyle = th.groupLabelInk;
    let x = box.x + GROUP_LABEL_LEFT;
    let y;
    if (group.collapsed) {
      // 접힌 묶음: 제목줄 안, 접기 영역 오른쪽에 쓴다.
      x = tg.zone.x + tg.zone.w + 2;
      ctx.textBaseline = 'middle';
      y = box.y + box.h / 2;
    } else {
      // 펼친 묶음: 상자 위쪽 바깥에 쓴다.
      ctx.textBaseline = 'alphabetic';
      y = box.y - (th.groupLabelGap ?? 4);
    }
    const maxW = Math.max(0, box.x + box.w - GROUP_LABEL_LEFT - x);
    const start = x;
    if (th.groupDot) {
      const cy = group.collapsed ? y : y - 4;
      ctx.beginPath();
      ctx.arc(x + GROUP_DOT_PX / 2, cy, GROUP_DOT_PX / 2, 0, Math.PI * 2);
      ctx.fillStyle = members.length ? groupDotColor(members) : th.groupDotFallback;
      ctx.fill();
      ctx.fillStyle = th.groupLabelInk;
      x += GROUP_DOT_PX + GROUP_DOT_GAP;
    }
    ctx.fillText(ellipsize(ctx, label, Math.max(0, maxW - (x - start))), x, y);
    setLetterSpacing(ctx, '0px');
    ctx.restore();
  }

  // --- 카드 ---

  function drawCover(ctx, img, s, src) {
    if (!(src.sw > 0 && src.sh > 0)) return;
    const k = Math.max(s.w / src.sw, s.h / src.sh);
    const w = src.sw * k, h = src.sh * k;
    ctx.drawImage(img, src.sx, src.sy, src.sw, src.sh, s.x + (s.w - w) / 2, s.y + (s.h - h) / 2, w, h);
  }

  // 사진 카드에 그릴 그림. anim 카드는 GIF의 지금 프레임(준비 전에는 정지 썸네일).
  function photoImage(card, t) {
    return (card.anim && gifs?.frame(card, t)) || bitmapFor(card);
  }

  function drawText(ctx, th, card, s) {
    const paper = paperFor(th, card);
    ctx.fillStyle = paper.bg;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    const bar = th.textAccentBar ? th.textAccentWidth ?? 3 : 0;
    if (th.textBorder) strokeInside(ctx, th.textBorder, s);
    if (bar) {
      ctx.fillStyle = card.color || '#9e9e9e';
      ctx.fillRect(s.x, s.y, bar, s.h);
    }
    const pad = 12;
    if (s.w > 40 && s.h > 30) {
      ctx.fillStyle = paper.ink;
      ctx.font = th.textFont;
      ctx.textBaseline = 'top';
      const lineH = 18;
      const maxW = s.w - pad * 2 - bar;
      const x = s.x + bar + pad;
      const label = cardLabel(card);
      let top = s.y + pad;
      if (label) {
        ctx.font = th.textTitleFont;
        ctx.fillText(ellipsize(ctx, label, maxW), x, top);
        top += lineH + 4;
        ctx.font = th.textFont;
      }
      const maxLines = Math.floor((s.y + s.h - top - pad - (bar ? 0 : 14)) / lineH);
      if (maxLines >= 1 || !label) {
        const lines = wrap(ctx, card.text ?? card.title, maxW, Math.max(1, maxLines));
        lines.forEach((l, i) => ctx.fillText(ellipsize(ctx, l, maxW), x, top + i * lineH));
      }
    }
    if (!bar) {
      // 라이트: 색 띠 대신 오른쪽 아래 작은 색 점
      const r = Math.max(3, Math.min(6, s.w / 20));
      ctx.beginPath();
      ctx.arc(s.x + s.w - pad - r, s.y + s.h - pad - r, r, 0, Math.PI * 2);
      ctx.fillStyle = card.color || '#9e9e9e';
      ctx.fill();
    }
  }

  // 링크 카드: 이름(label, 없으면 주소의 host), 주소, 메모 2줄을 가운데에 쌓는다.
  function drawLink(ctx, th, card, s) {
    ctx.fillStyle = th.linkBg;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (th.linkBorder) strokeInside(ctx, th.linkBorder, s);
    if (s.w < 40 || s.h < 30) return;
    const pad = 10, w = s.w - pad * 2;
    ctx.font = th.memoFont;
    const memo = wrapLines(cardMemo(card), w, 2, (t) => ctx.measureText(t).width);
    const top = s.y + s.h / 2 - 18 - (memo.length * 13) / 2;
    ctx.textBaseline = 'top';
    ctx.fillStyle = th.linkInk;
    ctx.font = th.linkTitleFont;
    ctx.fillText(ellipsize(ctx, cardLabel(card) || hostOf(card.url) || card.title, w), s.x + pad, top);
    ctx.fillStyle = th.linkMuted;
    ctx.font = th.linkUrlFont;
    ctx.fillText(ellipsize(ctx, card.url, w), s.x + pad, top + 20);
    ctx.font = th.memoFont;
    ctx.fillStyle = th.memoColor;
    memo.forEach((l, i) => ctx.fillText(l, s.x + pad, top + 38 + i * 13));
  }

  function drawPlaceholder(ctx, th, card, s) {
    ctx.fillStyle = th.placeholderBg;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (th.border) strokeInside(ctx, th.border, s);
    if (s.w < 40 || s.h < 30) return;
    ctx.fillStyle = th.placeholderInk;
    ctx.font = th.placeholderFont;
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, card.title, s.w - 20), s.x + 10, s.y + s.h / 2);
  }

  function drawBadge(ctx, th, card, at, inner) {
    const b = BADGE[card.kind];
    // 글 카드는 색 띠로 충분하다(뷰어와 같음). 배지가 글 위에 겹치지 않게 뺀다.
    if (!b || card.kind === 'text' || inner.w < 32 || inner.h < 32) return;
    ctx.font = th.badgeFont;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(b).width + 10;
    const h = 16;
    ctx.fillStyle = th.badgeBg;
    ctx.fillRect(at.x, at.y, w, h);
    ctx.fillStyle = th.badgeInk;
    ctx.fillText(b, at.x + 5, at.y + h / 2);
  }

  function drawNote(ctx, th, card, s) {
    if (!card.note || s.w < 40 || s.h < 40) return;
    const h = 22;
    ctx.fillStyle = th.noteBg;
    ctx.fillRect(s.x, s.y + s.h - h, s.w, h);
    ctx.fillStyle = th.noteInk;
    ctx.font = th.noteFont;
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, card.note, s.w - 12), s.x + 6, s.y + s.h - h / 2);
  }

  function drawCard(ctx, th, card, s, scale, t) {
    const ch = cardChrome(th, card, s, scale, measure);
    const o = ch.outer, inner = ch.inner;
    ctx.save();
    // 그림자: 겹마다 같은 사각형을 한 번씩 칠한다.
    ctx.fillStyle = ch.matBg ?? th.loadingBg;
    for (const sh of ch.shadows) {
      ctx.shadowColor = sh.color;
      ctx.shadowBlur = sh.blur;
      ctx.shadowOffsetY = sh.y;
      ctx.fillRect(o.x, o.y, o.w, o.h);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (!ch.shadows.length) ctx.fillRect(o.x, o.y, o.w, o.h);
    // 아랫단: 다크 띠를 칠하고, 캡션과 메모를 카드 안에 잘라 쓴다.
    if (ch.foot) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(o.x, o.y, o.w, o.h);
      ctx.clip();
      if (ch.foot.bg) {
        ctx.fillStyle = ch.foot.bg;
        ctx.fillRect(ch.foot.x, ch.foot.y, ch.foot.w, ch.foot.h);
      }
      ctx.textBaseline = 'middle';
      for (const l of ch.lines) {
        ctx.font = l.font;
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.y);
      }
      ctx.restore();
    }
    // 내용은 카드(매트 안쪽) 밖으로 나가지 않게 자른다.
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    if (card.hasThumb) {
      ctx.fillStyle = th.loadingBg;
      ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
      const img = photoImage(card, t);
      if (img) drawCover(ctx, img, inner, photoSource(card, img));
    } else if (card.kind === 'text') drawText(ctx, th, card, inner);
    else if (card.kind === 'link' || card.kind === 'youtube' || card.kind === 'pinterest') drawLink(ctx, th, card, inner);
    else drawPlaceholder(ctx, th, card, inner);
    drawBadge(ctx, th, card, ch.badgeAt, inner);
    drawNote(ctx, th, card, inner);
    ctx.restore();
  }

  // --- 선택 ---

  function drawSelection(ctx, th, box, handle) {
    const lw = th.selectWidth ?? 2;
    ctx.save();
    ctx.strokeStyle = th.selectLine;
    ctx.lineWidth = lw;
    ctx.strokeRect(box.x - lw / 2 - 1, box.y - lw / 2 - 1, box.w + lw + 2, box.h + lw + 2);
    if (handle) {
      // 크기 조절 손잡이
      ctx.beginPath();
      ctx.moveTo(box.x + box.w, box.y + box.h - HANDLE_PX);
      ctx.lineTo(box.x + box.w, box.y + box.h);
      ctx.lineTo(box.x + box.w - HANDLE_PX, box.y + box.h);
      ctx.closePath();
      ctx.fillStyle = th.selectLine;
      ctx.fill();
    }
    ctx.restore();
  }

  // --- 자르기 ---

  // 원본 전체를 그리고, 자를 사각형 바깥을 어둡게, 틀과 손잡이 8개를 긋는다.
  function drawCrop(ctx, th, card, s, scale, crop, w, h) {
    const bmp = bitmapFor(card);
    if (!bmp) return null;
    const inner = cardChrome(th, card, s, scale, measure).inner;
    const img = cropImageRect(inner, crop.base, bmp.width, bmp.height);
    const r = crop.rect;
    const box = { x: img.x + r.x * img.w, y: img.y + r.y * img.h, w: r.w * img.w, h: r.h * img.h };
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, img.x, img.y, img.w, img.h);
    ctx.beginPath();
    ctx.rect(img.x, img.y, img.w, img.h);
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    const accent = th.accent ?? th.selectLine;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    const hs = 8;
    const xs = [box.x, box.x + box.w / 2, box.x + box.w];
    const ys = [box.y, box.y + box.h / 2, box.y + box.h];
    ctx.fillStyle = '#ffffff';
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        if (i === 1 && j === 1) continue;
        ctx.fillRect(xs[i] - hs / 2, ys[j] - hs / 2, hs, hs);
        ctx.strokeRect(xs[i] - hs / 2 + 0.5, ys[j] - hs / 2 + 0.5, hs - 1, hs - 1);
      }
    }
    // 안내 글
    ctx.font = th.uiFont ?? GROUP_TOGGLE_FONT;
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(CROP_HINT).width + 20;
    const hx = (w - tw) / 2, hy = 12;
    ctx.fillStyle = th.badgeBg ?? 'rgba(0,0,0,.7)';
    ctx.fillRect(hx, hy, tw, 24);
    ctx.fillStyle = th.badgeInk ?? '#ffffff';
    ctx.fillText(CROP_HINT, hx + 10, hy + 12);
    ctx.restore();
    return { img, card: s };
  }

  // --- 한 장 ---

  // backing store를 지금 표면 크기(css × dpr)에 맞춘다. 크기를 바꾸면 캔버스가 비므로 바로 다시 그려야 한다.
  function syncSize() {
    const { canvas, cssWidth, cssHeight, dpr } = surface;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    let changed = false;
    if (canvas.width !== width) { canvas.width = width; changed = true; }
    if (canvas.height !== height) { canvas.height = height; changed = true; }
    return changed;
  }

  function draw(t) {
    syncSize();
    const { canvas, cssWidth, cssHeight, dpr } = surface;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    mctx = ctx;
    const sc = scene();
    const th = boardTheme(theme() ?? THEMES.light, sc.bg);
    const view = sc.view;
    const manual = sc.mode !== 'sorted';
    const drag = sc.drag;
    const cards = sc.cards ?? [];
    const groups = sc.groups ?? [];
    const cardsById = new Map(cards.map((c) => [c.id, c]));
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    // 묶음을 끄는 동안 안의 카드 자리
    const dragCards = drag?.kind === 'group' && drag.moved && Array.isArray(drag.cards)
      ? new Map(drag.cards.map((c) => [c.cardId, c.rect]))
      : null;

    const cardRect = (card) => {
      if (drag?.cardId === card.id && drag.rect && drag.moved) return drag.rect;
      if (manual && dragCards?.has(card.id)) return dragCards.get(card.id);
      return currentRect(card.id, t) ?? card.manual;
    };
    const groupRect = (g) =>
      drag?.groupId === g.id && drag.moved && (drag.kind === 'group' || drag.kind === 'group_resize') ? drag.rect : g.rect;
    const offscreen = (s) => s.x > cssWidth || s.y > cssHeight || s.x + s.w < 0 || s.y + s.h < 0;

    const animIds = new Set();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const item of drawList({ ...sc, cards, groups })) {
      if (item.kind === 'background') {
        drawBackground(ctx, th, view, cssWidth, cssHeight, dpr);
      } else if (item.kind === 'group') {
        const g = groupsById.get(item.id);
        const r = g && groupRect(g);
        if (!r) continue;
        const s = toScreen(view, r);
        // 이름은 상자 위 바깥에 있으므로 위쪽은 넉넉히 본다
        if (offscreen({ ...s, y: s.y - 24, h: s.h + 24 })) continue;
        drawGroup(ctx, th, g, s, groupMembers(cards, g.id));
      } else if (item.kind === 'card') {
        const card = cardsById.get(item.id);
        const r = card && cardRect(card);
        if (!r) continue;
        const s = toScreen(view, r);
        if (offscreen(s)) continue;
        if (card.anim && card.hasThumb) animIds.add(card.id);
        drawCard(ctx, th, card, s, view.scale, t);
      } else if (item.kind === 'selection') {
        if (sc.crop && item.target === 'card' && item.id === sc.crop.id) continue;
        if (item.target === 'card') {
          const card = cardsById.get(item.id);
          const r = card && cardRect(card);
          if (r) drawSelection(ctx, th, toScreen(view, r), manual);
        } else {
          const g = groupsById.get(item.id);
          const r = g && groupRect(g);
          if (r) drawSelection(ctx, th, groupBox(g, toScreen(view, r)), !g.collapsed);
        }
      }
    }
    cropLayout = null;
    const crop = sc.crop;
    const ccard = crop && cardsById.get(crop.id);
    const cr = ccard && cardRect(ccard);
    if (cr) cropLayout = drawCrop(ctx, th, ccard, toScreen(view, cr), view.scale, crop, cssWidth, cssHeight);
    // 화면 밖으로 나간 GIF의 디코더와 프레임은 놓는다.
    animOnScreen = animIds.size;
    gifs?.retain(animIds);
  }

  return {
    attach(next) {
      if (surface && onResize) surface.resize.removeEventListener('resize', onResize);
      stop();
      surface = next;
      onResize = null;
      if (!surface) return;
      // 크기가 바뀌면 같은 일 안에서 바로 다시 그린다. 비운 캔버스를 다음 프레임까지 두지 않는다.
      onResize = () => {
        if (!surface.visible) { stop(); return; }
        if (syncSize()) { stop(); frame(); } else schedule();
      };
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
    cropLayout: () => cropLayout,
    thumbSize(id) {
      const bmp = bitmaps.get(id)?.bmp;
      return bmp ? { width: bmp.width, height: bmp.height } : null;
    },
  };
}

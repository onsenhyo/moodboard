// 내보낸 HTML 안에서 도는 읽기 전용 뷰어. 브라우저 전용이며 iife로 따로 번들해 HTML에 넣는다.
// 정렬은 앱과 같은 sortedLayout(layout.js, color.js)과 sortCols를 쓴다.
// 외부 요청은 하지 않는다. 썸네일과 영상은 페이지 안의 text/plain 블록에서 읽는다.

import { sortedLayout, SORT_CELL, SORT_GAP } from '../layout.js';
import { sortCols, zoomAt, fitView } from '../interaction.js';

const BADGE = { youtube: '▶', video: '🎞', pinterest: '📌', text: '✎', link: '🔗' };
const LINK_KINDS = new Set(['youtube', 'pinterest', 'link']);
const CLICK_PX = 4;
const ZOOM_STEP = 1.25;
const ANIM_MS = 300;

const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
};

const safeUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};
const hostOf = (u) => { try { return new URL(u).host; } catch { return u ?? ''; } };

function readBlocks(attr) {
  const m = new Map();
  for (const s of document.querySelectorAll(`script[type="text/plain"][${attr}]`)) {
    m.set(s.getAttribute(attr), { b64: s.textContent.trim(), mime: s.getAttribute('data-mime') });
  }
  return m;
}

function b64ToBlobUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
}

function start() {
  const data = JSON.parse(document.getElementById('board')?.textContent || '{"name":"","cards":[]}');
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const thumbs = readBlocks('data-thumb');
  const videos = readBlocks('data-video');
  const videoUrls = new Map();
  const thumbUrl = (id) => (thumbs.has(id) ? `data:image/jpeg;base64,${thumbs.get(id).b64}` : null);
  const videoUrl = (id) => {
    if (!videos.has(id)) return null;
    if (!videoUrls.has(id)) videoUrls.set(id, b64ToBlobUrl(videos.get(id).b64, videos.get(id).mime));
    return videoUrls.get(id);
  };

  document.title = data.name || document.title;

  // --- 화면 뼈대 ---
  const btn = (label, title) => el('button', { type: 'button', title: title || label, text: label });
  const sortBtn = btn('색으로 정렬');
  const manualBtn = btn('내 배치');
  const outBtn = btn('−', '축소');
  const inBtn = btn('+', '확대');
  const fitBtn = btn('맞춤');
  const bar = el('div', { id: 'bar' }, el('h1', { text: data.name || '' }), sortBtn, manualBtn, outBtn, inBtn, fitBtn);
  const world = el('div', { id: 'world' });
  const stage = el('div', { id: 'stage' }, world);
  const lb = el('div', { id: 'lb', role: 'dialog', 'aria-modal': 'true' });
  document.body.append(bar, stage, lb);

  // --- 카드 ---
  const manual = new Map(cards.map((c) => [c.id, c.manual ?? { x: 0, y: 0, w: 240, h: 180 }]));
  const sorted = sortedLayout(cards, { cols: sortCols(cards.length), cell: SORT_CELL, gap: SORT_GAP });
  const nodes = new Map();
  for (const c of cards) {
    const n = el('div', { class: `card ${c.kind === 'text' ? 'text' : ''}`, 'data-id': c.id, title: c.title || '' });
    const src = c.hasThumb ? thumbUrl(c.id) : null;
    if (src) n.append(el('img', { src, alt: c.title || '', draggable: 'false' }));
    else if (c.kind === 'text') n.append(el('div', { class: 'ph', text: c.text ?? '' }));
    else n.append(el('div', { class: 'ph', text: c.url ? `${hostOf(c.url)}\n${c.url}` : (c.title || '') }));
    if (c.kind === 'text') n.append(el('span', { class: 'dot', style: `background:${/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#9e9e9e'}` }));
    if (BADGE[c.kind]) n.append(el('span', { class: 'badge', text: BADGE[c.kind] }));
    if (c.note) n.append(el('div', { class: 'note', text: c.note }));
    world.append(n);
    nodes.set(c.id, n);
  }

  let mode = 'manual';
  let view = { x: 0, y: 0, scale: 1 };
  const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
  const rects = () => (mode === 'sorted' ? sorted : manual);

  function place(animate) {
    const r = rects();
    for (const [id, n] of nodes) {
      const rect = r.get(id);
      if (!rect) continue;
      n.classList.toggle('anim', animate);
      Object.assign(n.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    }
    if (animate) setTimeout(() => { for (const n of nodes.values()) n.classList.remove('anim'); }, ANIM_MS + 50);
  }
  function applyView() {
    world.style.transform = `scale(${view.scale}) translate(${-view.x}px, ${-view.y}px)`;
  }
  function fit() {
    view = fitView([...rects().values()], size());
    applyView();
  }
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    sortBtn.setAttribute('aria-pressed', String(mode === 'sorted'));
    manualBtn.setAttribute('aria-pressed', String(mode === 'manual'));
    place(true);
    fit();
  }
  function zoom(factor, anchor) {
    const s = size();
    view = zoomAt(view, factor, anchor ?? { x: s.w / 2, y: s.h / 2 });
    applyView();
  }

  sortBtn.setAttribute('aria-pressed', 'false');
  manualBtn.setAttribute('aria-pressed', 'true');
  sortBtn.onclick = () => setMode('sorted');
  manualBtn.onclick = () => setMode('manual');
  inBtn.onclick = () => zoom(ZOOM_STEP);
  outBtn.onclick = () => zoom(1 / ZOOM_STEP);
  fitBtn.onclick = fit;

  // --- 이동과 확대 ---
  let drag = null;
  const local = (e) => { const b = stage.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  stage.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0) return;
    const cardEl = e.target.closest?.('.card');
    drag = { id: e.pointerId, start: local(e), view, moved: false, cardId: cardEl?.getAttribute('data-id') ?? null };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = local(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < CLICK_PX) return;
    drag.moved = true;
    stage.classList.add('panning');
    view = { ...drag.view, x: drag.view.x - dx / drag.view.scale, y: drag.view.y - dy / drag.view.scale };
    applyView();
  });
  const endDrag = (e, open) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    stage.classList.remove('panning');
    if (open && !d.moved && d.cardId) openCard(d.cardId);
  };
  stage.addEventListener('pointerup', (e) => endDrag(e, true));
  stage.addEventListener('pointercancel', (e) => endDrag(e, false));
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    zoom(factor, local(e));
  }, { passive: false });
  addEventListener('resize', () => applyView());

  // --- 크게 보기 ---
  const byId = new Map(cards.map((c) => [c.id, c]));
  function closeLb() {
    for (const v of lb.querySelectorAll('video')) v.pause();
    lb.classList.remove('open');
    lb.replaceChildren();
  }
  function openCard(id) {
    const c = byId.get(id);
    if (!c) return;
    const box = el('div', { class: 'box' });
    const vsrc = c.kind === 'video' && c.video ? videoUrl(c.id) : null;
    const isrc = c.hasThumb ? thumbUrl(c.id) : null;
    if (vsrc) box.append(el('video', { src: vsrc, controls: '', autoplay: '', playsinline: '' }));
    else if (c.kind === 'text') box.append(el('div', { class: 'txt', text: c.text ?? '' }));
    else if (isrc) box.append(el('img', { src: isrc, alt: c.title || '' }));
    const meta = el('div', { class: 'meta' });
    if (c.title) meta.append(el('span', { class: 'title', text: c.title }));
    if (c.note) meta.append(el('span', { text: c.note }));
    const href = LINK_KINDS.has(c.kind) && c.url ? safeUrl(c.url) : null;
    if (href) meta.append(el('a', { href, target: '_blank', rel: 'noopener', text: '원본 보기' }));
    if (c.kind === 'video' && !vsrc) meta.append(el('span', { text: '영상은 이 파일에 들어 있지 않아요' }));
    box.append(meta);
    const close = el('button', { type: 'button', class: 'close', title: '닫기', text: '✕' });
    close.onclick = closeLb;
    lb.replaceChildren(close, box);
    lb.classList.add('open');
  }
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLb(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLb(); });

  place(false);
  fit();
}

// 내보낸 페이지에서는 데이터 블록이 앞에 있으므로 바로 시작한다.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

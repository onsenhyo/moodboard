// 내보낸 HTML 안에서 도는 읽기 전용 뷰어. 브라우저 전용이며 iife로 따로 번들해 HTML에 넣는다.
// 정렬은 앱과 같은 sortedLayout(layout.js, color.js)과 sortCols를 쓴다.
// 외부 요청은 하지 않는다. 썸네일과 영상은 페이지 안의 text/plain 블록에서 읽는다.
// 모양은 앱 캔버스와 같은 THEMES 토큰으로 정하고, prefers-color-scheme으로 light/dark를 고른다.
// 묶음 상자는 카드 아래에 그린다. 접힌 묶음은 제목줄만 보이고 그 카드는 수동 배치에서 숨긴다.
// 색 정렬 모드에서는 묶음을 숨기고 모든 카드를 보인다.

import { sortedLayout, SORT_CELL, SORT_GAP, GROUP_TITLE_PX } from '../layout.js';
import { sortCols, zoomAt, fitView } from '../interaction.js';
import { THEMES, themeName, groupDotColor, boardTheme, paperFor } from '../theme.js';
import { captionFor, cardLabel, cardMemo, FOOT } from '../drawplan.js';

const BADGE = { youtube: '▶', video: '🎞', pinterest: '📌', text: '✎', link: '🔗' };
const LINK_KINDS = new Set(['youtube', 'pinterest', 'link']);
const CLICK_PX = 4;
const ZOOM_STEP = 1.25;
const ANIM_MS = 300;
const HEX = /^#[0-9a-f]{6}$/i;
const LABEL_ROOM = 24; // 맞춤 때 상자 위 이름 자리

const shadowCss = (list) => (list ?? []).map((s) => `0 ${s.y}px ${s.blur}px ${s.color}`).join(',') || 'none';

// THEMES 토큰을 CSS로 옮긴다. 둥근 모서리는 쓰지 않는다. 점 격자의 크기와 자리는 applyView가 정한다.
function themeCss(t) {
  const pad = t.mat ? t.mat.pad : 0;
  const bottom = t.mat ? t.mat.bottom : 0;
  const fx = t.mat ? FOOT.xMat : FOOT.xStrip;
  const grid = t.grid
    ? `background-image:radial-gradient(circle,${t.grid.dot} ${t.grid.r}px,transparent ${t.grid.r + 0.5}px);`
    : 'background-image:none;';
  const shadow = shadowCss(t.shadow);
  const lined = (line) => (line ? `inset 0 0 0 1px ${line}${shadow === 'none' ? '' : `,${shadow}`}` : shadow);
  return [
    `html,body{background:${t.bg};color:${t.textInk};font:${t.uiFont}}`,
    `#stage{background-color:${t.bg};${grid}}`,
    `#bar{background:${t.surfaceSolid};color:${t.textInk};border-bottom-color:${t.border}}`,
    `#bar h1{font:${t.linkTitleFont}}`,
    `#bar button{font:${t.uiFont};color:${t.textInk};background:${t.surfaceRaised};border-color:${t.border}}`,
    `#bar button[aria-pressed=true]{background:${t.accent};border-color:${t.accent};color:${t.accentContrast}}`,
    `.group{background:${t.groupFill};border-color:${t.groupLine}}`,
    `.group .label{font:${t.groupLabelFont};color:${t.groupLabelInk};letter-spacing:${t.groupLabelSpacing};`
      + `text-transform:${t.groupLabelUpper ? 'uppercase' : 'none'};padding-bottom:${t.groupLabelGap}px}`,
    `.group.collapsed .label{padding-bottom:0}`,
    `.group .gdot{display:${t.groupDot ? 'block' : 'none'}}`,
    `.card{box-shadow:${lined(t.border)};background:${t.placeholderBg}}`,
    `.card.photo{box-shadow:${shadow};background:${t.matBg ?? t.loadingBg}}`,
    // 사진 카드 아랫단(앱 캔버스 drawplan cardChrome과 같은 치수): 라이트는 매트 아랫단, 다크는 사진 아래 띠.
    `.card.photo{padding:${pad}px ${pad}px ${bottom}px}`,
    `.card.photo.footed{padding-bottom:0}`,
    `.card .pic{background:${t.loadingBg}}`,
    `.card .foot{padding:${FOOT.top}px ${fx}px ${FOOT.bottom}px;max-height:${FOOT.maxShare * 100}%;background:${t.stripBg ?? 'none'}}`,
    `.card .foot.kindonly{display:${t.mat ? 'block' : 'none'}}`,
    `.card .cap{font:${t.captionFont};color:${t.captionColor};height:${FOOT.capH}px;line-height:${FOOT.capH}px}`,
    `.card .cap.label{color:${t.labelColor}}`,
    `.card .memo{font:${t.memoFont};color:${t.memoColor};line-height:${FOOT.memoH}px}`,
    `.card .badge{left:${pad + 6}px;top:${pad + 6}px;background:${t.badgeBg};color:${t.badgeInk};font:${t.badgeFont}}`,
    `.card.text{background:${t.textBg};color:${t.textInk};box-shadow:${lined(t.textBorder)}}`,
    `.card.text .ph{font:${t.textFont};line-height:1.35;padding-left:${14 + (t.textAccentBar ? t.textAccentWidth : 0)}px}`,
    `.card .accent{display:${t.textAccentBar ? 'block' : 'none'};width:${t.textAccentWidth}px}`,
    `.card .tdot{display:${t.textAccentBar ? 'none' : 'block'}}`,
    `.card.link{background:${t.linkBg};color:${t.linkInk};box-shadow:${lined(t.linkBorder)}}`,
    `.card.link .ph{font:${t.linkUrlFont};color:${t.linkMuted}}`,
    `.card.link .ph b{font:${t.linkTitleFont};color:${t.linkInk}}`,
    `.card.placeholder .ph{font:${t.placeholderFont};color:${t.placeholderInk}}`,
    `.card .note{background:${t.noteBg};color:${t.noteInk};font:${t.noteFont}}`,
    `#lb .txt{background:${t.textBg};color:${t.textInk};font:${t.textFont}}`,
  ].join('\n');
}

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
  const groups = (Array.isArray(data.groups) ? data.groups : []).filter((g) => g && g.id && g.rect);
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

  // --- 테마 ---
  // 글 카드 종이: paper가 있는 카드만 인라인 색을 둔다(없으면 테마 CSS의 textBg).
  const paperNodes = [];
  const paintPapers = () => {
    for (const [n, c] of paperNodes) {
      const p = paperFor(theme, c);
      n.style.background = p.bg;
      n.style.color = p.ink;
    }
  };
  const themeStyle = el('style', { id: 'theme' });
  document.head.append(themeStyle);
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  let theme = THEMES.light;
  const applyTheme = () => {
    const name = themeName(!!mq?.matches);
    // 보드 bg가 있으면 바탕과 점 격자를 그 색에 맞춘다(앱 캔버스와 같은 boardTheme).
    theme = boardTheme(THEMES[name], data.bg);
    document.documentElement.setAttribute('data-theme', name);
    themeStyle.textContent = themeCss(theme);
    paintPapers();
  };
  applyTheme();
  // 테마가 바뀌면 격자 간격도 다시 맞춘다. applyView는 아래에서 정하므로 처음 한 번은 부르지 않는다.
  const onScheme = () => { applyTheme(); applyView(); };
  if (mq?.addEventListener) mq.addEventListener('change', onScheme);
  else if (mq?.addListener) mq.addListener(onScheme);

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

  // --- 묶음 상자(카드 아래) ---
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const membersOf = (g) => cards.filter((c) => c.groupId === g.id);
  const groupNodes = new Map();
  for (const g of groups) {
    const members = membersOf(g);
    const label = g.collapsed ? `▸ ${g.name} · ${members.length}장` : g.name;
    const n = el('div', { class: `group${g.collapsed ? ' collapsed' : ''}`, 'data-group': g.id, title: g.name },
      el('div', { class: 'label' },
        el('span', { class: 'gdot', style: `background:${groupDotColor(members)}` }),
        el('span', { text: label })));
    const h = g.collapsed ? Math.min(g.rect.h, GROUP_TITLE_PX) : g.rect.h;
    Object.assign(n.style, { left: `${g.rect.x}px`, top: `${g.rect.y}px`, width: `${g.rect.w}px`, height: `${h}px` });
    world.append(n);
    groupNodes.set(g.id, n);
  }
  const hiddenInManual = (c) => !!(c.groupId && groupById.get(c.groupId)?.collapsed);

  // --- 카드 ---
  const manual = new Map(cards.map((c) => [c.id, c.manual ?? { x: 0, y: 0, w: 240, h: 180 }]));
  const sorted = sortedLayout(cards, { cols: sortCols(cards.length), cell: SORT_CELL, gap: SORT_GAP });
  const nodes = new Map();
  for (const c of cards) {
    const src = c.hasThumb ? thumbUrl(c.id) : null;
    const color = HEX.test(c.color) ? c.color : '#9e9e9e';
    const type = src ? 'photo' : c.kind === 'text' ? 'text' : LINK_KINDS.has(c.kind) ? 'link' : 'placeholder';
    const label = cardLabel(c), memo = cardMemo(c);
    const cap = type === 'photo' ? captionFor(c) : null;
    const footed = !!(cap || memo);
    const n = el('div', { class: `card ${type}${type === 'photo' && footed ? ' footed' : ''}`, 'data-id': c.id, title: label || c.title || '' });
    const memoEl = memo ? el('div', { class: 'memo', text: memo }) : null;
    if (type === 'photo') {
      n.append(el('div', { class: 'pic' }, el('img', { src, alt: label || c.title || '', draggable: 'false' }),
        c.note ? el('div', { class: 'note', text: c.note }) : null));
      // 종류 이름만 있는 아랫단은 다크에서 숨긴다(footText).
      if (footed) {
        n.append(el('div', { class: `foot${label || memo ? '' : ' kindonly'}` },
          cap ? el('div', { class: `cap${label ? ' label' : ''}`, text: cap }) : null, memoEl));
      }
    } else if (type === 'text') {
      n.append(el('span', { class: 'accent', style: `background:${color}` }));
      n.append(el('div', { class: 'ph', text: c.text ?? '' }));
      n.append(el('span', { class: 'tdot', style: `background:${color}` }));
      if (c.paper) paperNodes.push([n, c]);
    } else if (type === 'link') {
      const ph = el('div', { class: 'ph' }, el('b', { text: label || c.title || hostOf(c.url) }));
      ph.append(c.url ? `${hostOf(c.url)}\n${c.url}` : '');
      if (memoEl) ph.append(memoEl);
      n.append(ph);
    } else {
      n.append(el('div', { class: 'ph', text: c.title || '' }));
    }
    // 글 카드는 색 띠/점으로 충분하므로 배지를 달지 않는다(목업과 같음).
    if (BADGE[c.kind] && type !== 'text') n.append(el('span', { class: 'badge', text: BADGE[c.kind] }));
    if (c.note && type !== 'photo') n.append(el('div', { class: 'note', text: c.note }));
    world.append(n);
    nodes.set(c.id, n);
  }
  paintPapers();

  let mode = 'manual';
  let view = { x: 0, y: 0, scale: 1 };
  const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
  const rects = () => (mode === 'sorted' ? sorted : manual);

  function place(animate) {
    const r = rects();
    const sortedMode = mode === 'sorted';
    for (const n of groupNodes.values()) n.classList.toggle('hidden', sortedMode);
    for (const c of cards) {
      const n = nodes.get(c.id);
      const rect = r.get(c.id);
      if (!n || !rect) continue;
      n.classList.toggle('hidden', !sortedMode && hiddenInManual(c));
      n.classList.toggle('anim', animate);
      Object.assign(n.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    }
    if (animate) setTimeout(() => { for (const n of nodes.values()) n.classList.remove('anim'); }, ANIM_MS + 50);
  }
  function applyView() {
    world.style.transform = `scale(${view.scale}) translate(${-view.x}px, ${-view.y}px)`;
    // 점 격자는 세계 좌표 간격이라 끌고 확대하면 함께 움직인다(앱 캔버스와 같은 규칙).
    const g = theme.grid;
    if (!g) return;
    let step = g.step * view.scale;
    while (step < 10) step *= 2;
    const ox = ((-view.x * view.scale) % step + step) % step;
    const oy = ((-view.y * view.scale) % step + step) % step;
    stage.style.backgroundSize = `${step}px ${step}px`;
    stage.style.backgroundPosition = `${ox - step / 2}px ${oy - step / 2}px`;
  }
  // 맞춤은 보이는 것만 본다. 수동 배치에서는 묶음 상자와 그 위 이름 자리까지 넣는다.
  function visibleRects() {
    const r = rects();
    if (mode === 'sorted') return [...r.values()];
    const out = cards.filter((c) => !hiddenInManual(c)).map((c) => r.get(c.id)).filter(Boolean);
    for (const g of groups) {
      const h = g.collapsed ? Math.min(g.rect.h, GROUP_TITLE_PX) : g.rect.h;
      out.push({ x: g.rect.x, y: g.rect.y - (g.collapsed ? 0 : LABEL_ROOM), w: g.rect.w, h: h + (g.collapsed ? 0 : LABEL_ROOM) });
    }
    return out;
  }
  function fit() {
    view = fitView(visibleRects(), size());
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
    else if (c.kind === 'text') {
      const txt = el('div', { class: 'txt', text: c.text ?? '' });
      if (c.paper) {
        const p = paperFor(theme, c);
        txt.style.background = p.bg;
        txt.style.color = p.ink;
      }
      box.append(txt);
    }
    else if (isrc) box.append(el('img', { src: isrc, alt: c.title || '' }));
    const meta = el('div', { class: 'meta' });
    const title = cardLabel(c) || c.title;
    if (title) meta.append(el('span', { class: 'title', text: title }));
    if (cardMemo(c)) meta.append(el('span', { class: 'memo', text: cardMemo(c) }));
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

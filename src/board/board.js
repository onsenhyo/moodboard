// sandbox 보드 진입점(html 자산 moodboard-board). 보드 그리기와 조작을 맡는다.
//
// 브리지: window.kaleidoscope (kaleidoscope ui/src/blocks/sandbox-frame.ts)
// - storage boards, thumbs_000..127을 직접 읽고, 보드를 바꿀 때 boards에 쓴다(saveWithRetry, CAS 병합).
// - 창 상태
//   읽기: board(지금 보드 id, client가 씀), mode('manual'|'sorted'), cmd({op, n}, n이 바뀔 때만 실행), selected
//   쓰기: selected {kind, id}|null, view {cx, cy, scale}(200ms 모음), paste_inbox {text, n}
// - 입력: 포인터(interaction.js), wheel(이동), ctrl+wheel과 gesture*(확대), Delete/Backspace, Esc, 붙여넣기.

import { reduce, initialState, zoomAt, fitView, sortCols } from '../interaction.js';
import { sortedLayout, SORT_CELL, SORT_GAP } from '../layout.js';
import { createRenderer } from '../render.js';
import { THEMES, themeName, boardTheme } from '../theme.js';
import { BOARDS_ENTRY, mergeBoards, saveWithRetry, shardIdOf, createThumbStore } from '../store.js';
import { createSaver, retryRead } from '../startup.js';
import { liveGroups } from '../model.js';
import { normSelected, deleteCard, deleteGroup } from '../selection.js';
import { wheelView, gestureView, stateFromView, viewFromState, createCmdTracker, keyEffect } from './input.js';

const SHARDS = 128;
const DRAG_SAVE_MS = 400;
const VIEW_MS = 200;
const ZOOM_STEP = 1.25;
const TOAST_MS = 2400;

const k = window.kaleidoscope;

let lastRemote = null; // 마지막으로 읽은 boards 값. 창을 닫을 때 바로 쓰기에 쓴다
const storage = {
  get: async (entry) => {
    const v = await k.getStorage(entry);
    if (entry === BOARDS_ENTRY) lastRemote = v;
    return v;
  },
  set: (entry, value) => k.setStorage(entry, value),
};

// --- 표면 ---

document.documentElement.style.cssText = 'margin:0;height:100%;overflow:hidden';
document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;position:relative';
const canvas = document.createElement('canvas');
canvas.tabIndex = 0;
canvas.setAttribute('aria-label', '무드보드');
canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none';
const toast = document.createElement('div');
toast.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 12px;'
  + 'font:13px system-ui,-apple-system,sans-serif;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .2s';
document.body.append(canvas, toast);

const resizeTarget = new EventTarget();
const surface = {
  canvas,
  get cssWidth() { return Math.max(1, canvas.clientWidth); },
  get cssHeight() { return Math.max(1, canvas.clientHeight); },
  get dpr() { return window.devicePixelRatio || 1; },
  visible: true, // 숨은 동안은 브리지가 requestAnimationFrame을 미룬다
  resize: resizeTarget,
};
const size = () => ({ w: surface.cssWidth, h: surface.cssHeight });

// --- 상태 ---

let doc = { version: 1, boards: [] };
let boardId = null;
let ui = initialState();
let selected = normSelected(k.getState('selected'));
let thumbs = null;
let loaded = false;
let viewRestored = false;
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let themeKey = themeName(darkQuery.matches);

const liveBoards = () => doc.boards.filter((b) => !b.deleted);
const board = () => liveBoards().find((b) => b.id === boardId) ?? liveBoards()[0] ?? null;
const liveCards = () => (board()?.cards ?? []).filter((c) => !c.deleted);
const cardById = (id) => (id ? liveCards().find((c) => c.id === id) ?? null : null);
const groupById = (id) => (id ? liveGroups(board()).find((g) => g.id === id) ?? null : null);
const selCard = () => (selected?.kind === 'card' ? selected.id : null);
const selGroup = () => (selected?.kind === 'group' ? selected.id : null);

const renderer = createRenderer({
  scene: () => ({
    cards: ui.cards, groups: ui.groups, view: ui.view, selectedId: selCard(), selectedGroupId: selGroup(),
    drag: ui.drag, mode: ui.mode, bg: board()?.bg,
  }),
  thumbB64: (id) => (thumbs ? thumbs.get(id) : Promise.resolve(null)),
  theme: () => THEMES[themeKey],
});

// 프레임 바탕도 보드 바탕으로 칠한다(캔버스가 늦게 그려져도 다른 색이 비치지 않게).
function paintChrome() {
  const th = boardTheme(THEMES[themeKey], board()?.bg);
  document.body.style.background = th.bg;
  toast.style.background = th.badgeBg ?? 'rgba(0,0,0,.7)';
  toast.style.color = th.badgeInk ?? '#fff';
}

let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, TOAST_MS);
}

function targets() {
  const m = new Map();
  for (const c of ui.cards) m.set(c.id, ui.mode === 'sorted' ? ui.sorted.get(c.id) : c.manual);
  return m;
}

function refresh(animate) {
  const cards = liveCards();
  const sorted = sortedLayout(cards, { cols: sortCols(cards.length), cell: SORT_CELL, gap: SORT_GAP });
  ui = { ...ui, cards, groups: liveGroups(board()), sorted };
  renderer.setTargets(targets(), animate);
  paintChrome();
}

function syncUi() {
  ui = { ...ui, cards: liveCards(), groups: liveGroups(board()) };
  renderer.setTargets(targets(), false);
}

// --- 저장 ---

let unsaved = false;
const saver = createSaver(async () => {
  unsaved = false;
  const next = await saveWithRetry(storage, (d) => d, { local: doc });
  doc = mergeBoards(doc, next);
  refresh(false);
}, {
  onError: (err) => { unsaved = true; showToast(err?.message ?? '저장하지 못했어요'); },
});
function scheduleSave(ms = 0) {
  unsaved = true;
  saver.schedule(ms);
}

// 창을 닫을 때 브리지는 pagehide를 보낸 직후 이미 보낸 setStorage만 기다린다.
// 읽기 단계에 있는 저장은 기다리지 않으므로 남은 변경을 마지막으로 읽은 값과 합쳐 바로 쓴다.
window.addEventListener('pagehide', () => {
  if (!unsaved) return;
  unsaved = false;
  k.setStorage(BOARDS_ENTRY, mergeBoards(doc, lastRemote)).catch(() => {});
});
k.onLifecycle?.((l) => (l?.phase === 'closing' ? saver.flush() : undefined));

function touchCard(id, patch, t = Date.now()) {
  const c = cardById(id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: t });
  return c;
}
function setCardGroup(id, groupId, t = Date.now()) {
  const c = cardById(id);
  if (!c) return;
  if (typeof groupId === 'string' && groupId) c.groupId = groupId;
  else delete c.groupId;
  c.updatedAt = t;
}
function touchGroup(id, patch, t = Date.now()) {
  const g = groupById(id);
  if (!g) return null;
  Object.assign(g, patch, { updatedAt: t });
  return g;
}

// --- 선택과 view 내보내기 ---

function select(sel) {
  const next = normSelected(sel);
  if (JSON.stringify(next) === JSON.stringify(selected)) return;
  selected = next;
  k.setState('selected', next);
  renderer.redraw();
}

let viewTimer = 0;
let viewSent = '';
function writeView() {
  clearTimeout(viewTimer);
  viewTimer = 0;
  const v = stateFromView(ui.view, size());
  const json = JSON.stringify(v);
  if (json === viewSent) return;
  viewSent = json;
  k.setState('view', v);
}
function setView(view) {
  if (view === ui.view) return;
  ui = { ...ui, view };
  renderer.redraw();
  if (!viewTimer) viewTimer = setTimeout(writeView, VIEW_MS);
}

// --- 포인터 ---

function pointerEvent(phase, e) {
  const r = canvas.getBoundingClientRect();
  return {
    phase, pointer_id: e.pointerId,
    x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height),
    buttons: phase === 'up' ? 0 : e.buttons, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
  };
}

function onPointer(event) {
  const prevDrag = ui.drag;
  const prevView = ui.view;
  const r = reduce({ ...ui, size: size() }, event);
  ui = r.state;
  if (ui.view !== prevView) { const v = ui.view; ui = { ...ui, view: prevView }; setView(v); }
  for (const e of r.effects) {
    if (e.type === 'select') {
      select(e.cardId ? { kind: 'card', id: e.cardId } : e.groupId ? { kind: 'group', id: e.groupId } : null);
    } else if (e.type === 'moved') {
      touchCard(e.cardId, { manual: { ...e.rect } });
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
    } else if (e.type === 'membership') {
      setCardGroup(e.cardId, e.groupId);
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
    } else if (e.type === 'group_moved') {
      const t = Date.now();
      touchGroup(e.groupId, { rect: { ...e.rect } }, t);
      for (const m of e.cards ?? []) touchCard(m.cardId, { manual: { ...m.rect } }, t);
      syncUi();
      scheduleSave(0);
    } else if (e.type === 'group_resized') {
      touchGroup(e.groupId, { rect: { ...e.rect } });
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
    } else if (e.type === 'group_toggled') {
      const g = groupById(e.groupId);
      if (g) touchGroup(g.id, { collapsed: !g.collapsed });
      if (g?.collapsed && cardById(selCard())?.groupId === g.id) select(null);
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
    } else if (e.type === 'notice') {
      showToast(e.text);
    }
  }
  if (ui.drag || prevDrag) renderer.redraw();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.focus({ preventScroll: true });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 이미 놓친 포인터 */ }
  onPointer(pointerEvent('down', e));
});
canvas.addEventListener('pointermove', (e) => { if (ui.drag) onPointer(pointerEvent('move', e)); });
canvas.addEventListener('pointerup', (e) => { if (ui.drag) onPointer(pointerEvent('up', e)); });
canvas.addEventListener('pointercancel', (e) => { if (ui.drag) onPointer(pointerEvent('cancel', e)); });

// --- wheel과 집기 ---

let gestureBase = 0; // gesturestart 때의 scale. 0이면 gesture 중이 아니다
const localPoint = (e) => {
  const r = canvas.getBoundingClientRect();
  const s = size();
  const x = Number.isFinite(e.clientX) ? e.clientX - r.left : s.w / 2;
  const y = Number.isFinite(e.clientY) ? e.clientY - r.top : s.h / 2;
  return { x, y };
};

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (ui.drag) return;
  // WebKit은 핀치를 gesture*로 보낸다. 같은 핀치가 ctrl+wheel로도 오면 두 번 확대하지 않는다.
  if (e.ctrlKey && gestureBase) return;
  const p = localPoint(e);
  setView(wheelView(ui.view, {
    deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, x: p.x, y: p.y,
  }, size()));
}, { passive: false });

for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'gesturestart') gestureBase = ui.view.scale;
    else if (type === 'gestureend') gestureBase = 0;
    else if (gestureBase && !ui.drag) setView(gestureView(ui.view, gestureBase, { scale: e.scale, ...localPoint(e) }));
  }, { passive: false });
}

// --- 키보드와 붙여넣기 ---

function deleteSelected() {
  const b = board();
  if (!b || !selected) return;
  const t = Date.now();
  const done = selected.kind === 'card' ? deleteCard(b, selected.id, t) : deleteGroup(b, selected.id, t);
  select(null);
  if (!done) return;
  refresh(false);
  scheduleSave(0);
}

window.addEventListener('keydown', (e) => {
  const t = e.target;
  const editing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const fx = keyEffect({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, editing });
  if (!fx) return;
  e.preventDefault();
  if (fx === 'delete') deleteSelected();
  else if (fx === 'clear') {
    if (ui.drag) onPointer({ phase: 'cancel', pointer_id: ui.drag.pointerId });
    select(null);
  }
});

document.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text') || '';
  if (!text.trim()) return;
  e.preventDefault();
  k.setState('paste_inbox', { text, n: Date.now() });
});

// --- 창 상태 ---

const nextCmd = createCmdTracker(k.getState('cmd'));

function runCmd(op) {
  const s = size();
  if (op === 'zoom_in') setView(zoomAt(ui.view, ZOOM_STEP, { x: s.w / 2, y: s.h / 2 }));
  else if (op === 'zoom_out') setView(zoomAt(ui.view, 1 / ZOOM_STEP, { x: s.w / 2, y: s.h / 2 }));
  else if (op === 'fit') setView(fitView([...targets().values()].filter(Boolean), s));
}

function applyMode(mode) {
  if ((mode !== 'manual' && mode !== 'sorted') || mode === ui.mode) return;
  ui = { ...ui, mode, drag: null };
  renderer.setTargets(targets(), true);
}

// 다른 보드로 바뀌면 원점·배율 1에서 본다. 시작할 때 client가 board를 처음 알리는 것(같은 보드)은 view를 그대로 둔다.
function applyBoard(id) {
  const next = typeof id === 'string' ? id : null;
  if (next === boardId) return;
  const prev = board()?.id ?? null;
  boardId = next;
  ui = { ...ui, drag: null };
  if (viewRestored && prev !== null && board()?.id !== prev) setView({ x: 0, y: 0, scale: 1 });
  refresh(false);
}

function onState(state) {
  applyBoard(state.board);
  applyMode(state.mode);
  const sel = normSelected(state.selected);
  if (JSON.stringify(sel) !== JSON.stringify(selected)) { selected = sel; renderer.redraw(); }
  const op = nextCmd(state.cmd);
  if (op) runCmd(op);
}
k.onStateChange(onState);

darkQuery.addEventListener('change', (e) => {
  themeKey = themeName(e.matches);
  paintChrome();
  renderer.redraw();
});

// --- 저장소 ---

k.onStorageChange(BOARDS_ENTRY, (value) => {
  lastRemote = value;
  doc = mergeBoards(doc, value);
  loaded = true;
  refresh(false);
}, () => { /* 시작 읽기의 재시도가 맡는다 */ });

const pendingShards = new Map();
for (let i = 0; i < SHARDS; i++) {
  const id = shardIdOf(i);
  k.onStorageChange(id, (value) => {
    if (!thumbs) { pendingShards.set(id, value); return; }
    thumbs.reload(id, value);
    renderer.invalidateThumbs();
  }, () => {});
}

async function start() {
  boardId = typeof k.getState('board') === 'string' ? k.getState('board') : null;
  ui = { ...ui, mode: k.getState('mode') === 'sorted' ? 'sorted' : 'manual', size: size() };
  // 다시 연 창은 마지막 view(가운데와 배율)에서 시작한다.
  ui = { ...ui, view: viewFromState(k.getState('view'), size()) ?? ui.view };
  viewRestored = true;
  renderer.attach(surface);
  new ResizeObserver(() => resizeTarget.dispatchEvent(new Event('resize'))).observe(canvas);
  paintChrome();

  const boardsLoad = retryRead(() => storage.get(BOARDS_ENTRY), { stop: () => loaded })
    .then((r) => {
      if (!r.stopped) { doc = mergeBoards(doc, r.value); loaded = true; }
      refresh(false);
    });
  thumbs = await createThumbStore(storage, { shards: SHARDS });
  for (const [id, value] of pendingShards) thumbs.reload(id, value);
  pendingShards.clear();
  renderer.invalidateThumbs();
  await boardsLoad;
  writeView();
  await Promise.all(thumbs.missing().map((id) => retryRead(() => storage.get(id), {
    stop: () => !thumbs.missing().includes(id),
  }).then((r) => {
    if (!r.stopped) { thumbs.reload(id, r.value); renderer.invalidateThumbs(); }
  })));
}

start().catch((err) => showToast(err?.message ?? '보드를 읽지 못했어요'));

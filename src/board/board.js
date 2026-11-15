// sandbox 보드 진입점(보드 코드 조각 moodboard-board-js-1..N, client가 board_html로 싣는다. src/boardhtml.js). 보드 그리기와 조작을 맡는다.
//
// 브리지: window.kaleidoscope (kaleidoscope ui/src/blocks/sandbox-frame.ts)
// - storage boards, thumbs_000..127을 직접 읽고, 보드를 바꿀 때 boards에 쓴다(saveWithRetry, CAS 병합).
// - 창 상태
//   읽기: board(지금 보드 id, client가 씀), mode('manual'|'sorted'), cmd({op, n}, n이 바뀔 때만 실행), selected
//   쓰기: selected {kind, id}|null, view {cx, cy, scale}(200ms 모음), paste_inbox {text, n},
//         drop_inbox(끌어 놓은 파일 조각, drop.js). 읽기: drop_ack
// - 보드 편집은 패치로 쌓아(patches.js) 새로 읽은 값에 적용해 쓴다. 손을 뗄 때와 키로 지울 때 바로 저장하고,
//   창을 닫거나 숨길 때(pagehide, visibilitychange) 남은 패치를 바로 쓴다.
// - 입력: 포인터(interaction.js), wheel(이동), ctrl+wheel과 gesture*(확대), Delete/Backspace, Esc, 붙여넣기.

import { reduce, initialState, zoomAt, fitView, sortCols } from '../interaction.js';
import { sortedLayout, SORT_CELL, SORT_GAP } from '../layout.js';
import { createRenderer } from '../render.js';
import { THEMES, themeName, boardTheme } from '../theme.js';
import { BOARDS_ENTRY, shardIdOf, createThumbStore, isConflict } from '../store.js';
import { createDocEditor } from '../patches.js';
import { createSaver, retryRead } from '../startup.js';
import { liveGroups } from '../model.js';
import { normSelected, deleteCardPatches, deleteGroupPatches } from '../selection.js';
import { wheelView, gestureView, stateFromView, viewFromState, createCmdTracker, keyEffect } from './input.js';
import { installDrop } from './drop.js';

const SHARDS = 128;
const SAVE_RETRY_MS = 3000;
const CLOSE_TRIES = 3;
const VIEW_MS = 200;
const ZOOM_STEP = 1.25;
const TOAST_MS = 2400;

const k = window.kaleidoscope;

const storage = {
  get: (entry) => k.getStorage(entry),
  set: (entry, value) => k.setStorage(entry, value),
};

// --- 표면 ---

document.documentElement.style.cssText = 'margin:0;height:100%;overflow:hidden';
document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;position:relative';
const canvas = document.createElement('canvas');
canvas.setAttribute('aria-label', '무드보드');
canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none';
const toast = document.createElement('div');
toast.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 12px;'
  + 'font:13px system-ui,-apple-system,sans-serif;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .2s';
// ⌘V 받이. WebKit은 편집할 수 없는 요소에 초점이 있으면 붙여넣기를 막고 paste를 보내지 않는다.
// 보드를 누르면 이 보이지 않는 textarea에 초점을 준다. 키(Delete, Backspace, Esc)도 여기서 받는다.
const pasteBox = document.createElement('textarea');
pasteBox.setAttribute('aria-hidden', 'true');
pasteBox.tabIndex = -1;
pasteBox.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;'
  + 'margin:0;resize:none;overflow:hidden;pointer-events:none;font-size:16px';
pasteBox.addEventListener('input', () => { pasteBox.value = ''; });
const focusPasteBox = () => { if (document.activeElement !== pasteBox) pasteBox.focus({ preventScroll: true }); };
document.body.append(canvas, toast, pasteBox);

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

// ed.doc: 마지막으로 받은 boards 위에 아직 안 쓴 패치를 얹은 화면용 문서.
const ed = createDocEditor({ adapter: storage });
let viewBoard = null; // 지금 view가 보고 있는 보드 id
let boardId = null;
let ui = initialState();
let selected = normSelected(k.getState('selected'));
let thumbs = null;
let loaded = false;
let viewRestored = false;
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let themeKey = themeName(darkQuery.matches);

const liveBoards = () => ed.doc.boards.filter((b) => !b.deleted);
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
  // 다른 보드로 바뀌면(새 보드가 저장소에 늦게 와도) 원점·배율 1에서 본다.
  const id = board()?.id ?? null;
  if (id !== viewBoard) {
    if (viewBoard !== null && id !== null && viewRestored) setView({ x: 0, y: 0, scale: 1 });
    if (id !== null) viewBoard = id;
  }
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

// 패치는 쓰기가 성공할 때까지 줄에 남는다(ed.pending). 실패하면 조금 뒤 다시 저장한다.
const saver = createSaver(async () => {
  await ed.save();
  refresh(false);
}, {
  onError: (err) => {
    showToast(err?.message ?? '저장하지 못했어요');
    if (ed.pending) saver.schedule(SAVE_RETRY_MS);
  },
});
const save = () => saver.schedule(0);

// 창을 닫거나 숨길 때. 브리지의 닫기 flush는 pagehide를 보낸 직후 이미 보낸 setStorage만 기다리므로,
// 첫 시도는 읽기 없이 마지막으로 받은 값에 패치를 얹어 바로 보낸다. 충돌하면 다시 읽고 얹어 CLOSE_TRIES번까지.
// (closing lifecycle은 client 프레임에만 온다. sandbox.tsx는 ks-client-lifecycle을 보내지 않는다.)
let closing = null;
function flushNow() {
  if (!ed.pending || closing) return closing;
  closing = (async () => {
    for (let i = 0; i < CLOSE_TRIES && ed.pending; i++) {
      try {
        if (i === 0) await ed.writeNow();
        else { ed.receive(await storage.get(BOARDS_ENTRY)); await ed.writeNow(); }
      } catch (err) {
        if (!isConflict(err)) break;
      }
    }
  })().finally(() => { closing = null; });
  return closing;
}
window.addEventListener('pagehide', flushNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });

// 지금 보드의 카드나 묶음 하나를 고치는 패치. 고친 필드만 저장에 실린다.
function touchCard(id, fields, deleteKeys) {
  if (!cardById(id)) return;
  ed.edit({ kind: 'card', boardId: board().id, id, fields, deleteKeys });
}
function setCardGroup(id, groupId) {
  if (typeof groupId === 'string' && groupId) touchCard(id, { groupId });
  else touchCard(id, undefined, ['groupId']);
}
function touchGroup(id, fields) {
  if (!groupById(id)) return;
  ed.edit({ kind: 'group', boardId: board().id, id, fields });
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
      save();
    } else if (e.type === 'membership') {
      setCardGroup(e.cardId, e.groupId);
      syncUi();
      save();
    } else if (e.type === 'group_moved') {
      touchGroup(e.groupId, { rect: { ...e.rect } });
      for (const m of e.cards ?? []) touchCard(m.cardId, { manual: { ...m.rect } });
      syncUi();
      save();
    } else if (e.type === 'group_resized') {
      touchGroup(e.groupId, { rect: { ...e.rect } });
      syncUi();
      save();
    } else if (e.type === 'group_toggled') {
      const g = groupById(e.groupId);
      if (g) touchGroup(g.id, { collapsed: !g.collapsed });
      if (g?.collapsed && cardById(selCard())?.groupId === g.id) select(null);
      syncUi();
      save();
    } else if (e.type === 'notice') {
      showToast(e.text);
    }
  }
  if (ui.drag || prevDrag) renderer.redraw();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  focusPasteBox();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 이미 놓친 포인터 */ }
  onPointer(pointerEvent('down', e));
});
canvas.addEventListener('pointermove', (e) => { if (ui.drag) onPointer(pointerEvent('move', e)); });
// mousedown의 기본 동작이 초점을 옮길 수 있으므로 손을 뗄 때 한 번 더 준다.
canvas.addEventListener('pointerup', (e) => {
  focusPasteBox();
  if (ui.drag) onPointer(pointerEvent('up', e));
});
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
  const patches = selected.kind === 'card' ? deleteCardPatches(b, selected.id) : deleteGroupPatches(b, selected.id);
  select(null);
  if (!patches.length) return;
  ed.edit(patches);
  refresh(false);
  save();
}

window.addEventListener('keydown', (e) => {
  const t = e.target;
  // 붙여넣기 받이는 비어 있는 동안 편집 중이 아니다(지우기와 Esc를 보드가 받는다).
  const editing = t === pasteBox
    ? pasteBox.value !== ''
    : t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
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
  e.preventDefault();
  pasteBox.value = '';
  if (!text.trim()) return;
  k.setState('paste_inbox', { text, n: Date.now() });
});

// --- 끌어 놓기 (Finder에서 보드 위로, drop.js) ---

installDrop({
  k, canvas, showToast,
  getView: () => ui.view,
  accent: () => THEMES[themeKey].selectLine ?? '#6f569a',
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
  boardId = next;
  ui = { ...ui, drag: null };
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
  ed.receive(value);
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
      if (!r.stopped && !loaded) { ed.receive(r.value); loaded = true; }
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

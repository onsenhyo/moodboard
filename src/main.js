// client 진입점. 플랫폼 핸들러를 순수 모듈과 render.js에 잇는다.

import { createPlatform } from './platform/kaleidoscope.js';
import { newBoard } from './model.js';
import { sortedLayout } from './layout.js';
import { BOARDS_ENTRY, mergeBoards, saveWithRetry, shardIdOf, createThumbStore } from './store.js';
import { ingestFiles, ingestText } from './ingest.js';
import { makeThumb } from './thumb.js';
import { reduce, initialState, placeNear, zoomAt, fitView, sortCols } from './interaction.js';
import { createRenderer } from './render.js';

const SURFACE = 'board';
const SHARDS = 128;
const DRAG_SAVE_MS = 400;
const ZOOM_STEP = 1.25;
const SORT_CELL = 200;
const SORT_GAP = 16;
const FULL_NOTICE = '썸네일 저장 공간이 가득 찼어요 (약 1,200장)';
const NO_ORIG_NOTICE = '원본은 다른 PC에 있어요';
const DEFAULT_BOARD = '내 보드';
const HEX = /^#[0-9a-f]{6}$/i;

const p = createPlatform(window.kaleidoscope);

let doc = { version: 1, boards: [] };
let boardId = null;
let ui = initialState();
let selectedId = null;
let notice = null;
let thumbs = null;

// --- 보드와 카드 ---

const liveBoards = () => doc.boards.filter((b) => !b.deleted);
const board = () => liveBoards().find((b) => b.id === boardId) ?? null;
const liveCards = () => (board()?.cards ?? []).filter((c) => !c.deleted);
const cardById = (id) => (id ? liveCards().find((c) => c.id === id) ?? null : null);

function ensureBoard() {
  if (!board()) boardId = liveBoards()[0]?.id ?? null;
  if (!boardId) {
    const b = newBoard(DEFAULT_BOARD);
    doc.boards.push(b);
    boardId = b.id;
    scheduleSave();
  }
}

function touchCard(id, patch) {
  const c = cardById(id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: Date.now() });
  return c;
}

// --- 저장 ---

let saveTimer = null;
let saving = false;
let again = false;

function scheduleSave(ms = 0) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(runSave, ms);
}

async function runSave() {
  saveTimer = null;
  if (saving) { again = true; return; }
  saving = true;
  try {
    const next = await saveWithRetry(p.storage, (d) => d, { local: doc });
    // 저장하는 동안 바뀐 로컬 내용이 이기도록 로컬을 앞에 둔다.
    doc = mergeBoards(doc, next);
    refresh(false);
  } catch (err) {
    setNotice(err?.message ?? '저장하지 못했어요');
  } finally {
    saving = false;
    if (again) { again = false; scheduleSave(); }
  }
}

// --- 출력 ---

function setNotice(text) {
  notice = text ?? null;
  p.publish({ notice });
}
const clearNotice = () => { if (notice !== null) setNotice(null); };

function youtubeId(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

let selectSeq = 0;
async function publishSelected() {
  const seq = ++selectSeq;
  const c = cardById(selectedId);
  if (!c) {
    p.publish({ selected: null, selectedUrl: null });
    return;
  }
  const [hasOrig, b64] = await Promise.all([
    c.origKey ? p.blobs.has(c.origKey) : false,
    c.hasThumb && thumbs ? thumbs.get(c.id).catch(() => null) : null,
  ]);
  if (seq !== selectSeq) return;
  const selected = {
    id: c.id,
    kind: c.kind,
    title: c.title ?? '',
    url: c.url ?? null,
    text: c.text ?? null,
    color: c.color,
    hasOrig,
    origKey: c.origKey ?? null,
    thumbDataUrl: b64 ? `data:image/jpeg;base64,${b64}` : null,
    includeVideo: !!c.includeVideo,
    note: c.note ?? null,
  };
  if (c.kind === 'youtube') {
    const id = youtubeId(c.url);
    selected.embedUrl = id ? `https://www.youtube.com/embed/${id}` : null;
  }
  p.publish({ selected, selectedUrl: c.url ?? null });
}

function publishBoards() {
  p.publish({
    boardOptions: liveBoards().map((b) => ({ value: b.id, label: b.name })),
    board: boardId,
    boardName: board()?.name ?? '',
  });
}

function publishMode() {
  p.publish({ mode: ui.mode, sorted: ui.mode === 'sorted' });
}

// --- 그리기 ---

const renderer = createRenderer({
  scene: () => ({ cards: ui.cards, view: ui.view, selectedId, drag: ui.drag, mode: ui.mode }),
  thumbB64: (id) => (thumbs ? thumbs.get(id) : Promise.resolve(null)),
});

function targets() {
  const m = new Map();
  for (const c of ui.cards) m.set(c.id, ui.mode === 'sorted' ? ui.sorted.get(c.id) : c.manual);
  return m;
}

// 문서가 바뀐 뒤 화면 상태를 다시 맞춘다.
function refresh(animate) {
  ensureBoard();
  const cards = liveCards();
  const sorted = sortedLayout(cards, { cols: sortCols(cards.length), cell: SORT_CELL, gap: SORT_GAP });
  ui = { ...ui, cards, sorted };
  if (selectedId && !cardById(selectedId)) { selectedId = null; publishSelected(); }
  renderer.setTargets(targets(), animate);
  publishBoards();
}

function surfaceSize() {
  const s = renderer.surface;
  return s ? { w: s.cssWidth, h: s.cssHeight } : ui.size;
}

// --- 넣기 ---

function ingestDeps() {
  const size = surfaceSize();
  return {
    readBytes: (id) => p.files.read(id),
    blobPut: (key, fileId) => p.blobs.put(key, fileId),
    makeThumb,
    thumbs,
    now: Date.now,
    placeAt: () => placeNear(ui.view, size),
    httpRead: (permission, path, query) => p.http.read(permission, path, query),
  };
}

function addCards(cards, full) {
  const b = board();
  if (b && cards.length) {
    b.cards.push(...cards);
    refresh(false);
    scheduleSave();
  }
  if (full) setNotice(FULL_NOTICE);
  else if (cards.length) clearNotice();
}

async function onFiles({ event } = {}) {
  if (!thumbs || !event || event.cancelled) return;
  const files = Array.isArray(event.files) ? event.files : [];
  if (!files.length) return;
  const { cards, full } = await ingestFiles(files, ingestDeps());
  addCards(cards, full);
}

// --- 동작 ---

p.handle('drop', onFiles);
p.handle('pick', onFiles);

p.handle('add_text', async ({ event } = {}) => {
  if (!thumbs) return;
  const raw = typeof event === 'string' ? event : p.getState('draft');
  if (typeof raw !== 'string' || !raw.trim()) return;
  const { card, full } = await ingestText(raw, ingestDeps());
  addCards(card ? [card] : [], full);
  if (card) p.setState('draft', '');
});

function setMode(mode) {
  if (ui.mode === mode) return;
  ui = { ...ui, mode, drag: null };
  renderer.setTargets(targets(), true);
  publishMode();
  clearNotice();
}
p.handle('sort_color', () => setMode('sorted'));
p.handle('sort_manual', () => setMode('manual'));

function zoom(factor) {
  const size = surfaceSize();
  ui = { ...ui, view: zoomAt(ui.view, factor, { x: size.w / 2, y: size.h / 2 }) };
  renderer.redraw();
}
p.handle('zoom_in', () => zoom(ZOOM_STEP));
p.handle('zoom_out', () => zoom(1 / ZOOM_STEP));
p.handle('zoom_fit', () => {
  ui = { ...ui, view: fitView([...targets().values()].filter(Boolean), surfaceSize()) };
  renderer.redraw();
});

p.handle('pointer', ({ event } = {}) => {
  const s = renderer.surface;
  if (!s) return;
  const prevDrag = ui.drag;
  const r = reduce({ ...ui, size: { w: s.cssWidth, h: s.cssHeight } }, event);
  ui = r.state;
  for (const e of r.effects) {
    if (e.type === 'select') {
      selectedId = e.cardId;
      publishSelected();
      clearNotice();
    } else if (e.type === 'moved') {
      touchCard(e.cardId, { manual: { ...e.rect } });
      ui = { ...ui, cards: liveCards() };
      renderer.setTargets(targets(), false);
      scheduleSave(DRAG_SAVE_MS);
      clearNotice();
    } else if (e.type === 'notice') {
      setNotice(e.text);
    }
  }
  if (ui.drag || prevDrag) renderer.redraw();
});

p.handle('delete_selected', async () => {
  const c = cardById(selectedId);
  if (!c) return;
  touchCard(c.id, { deleted: true });
  selectedId = null;
  publishSelected();
  refresh(false);
  scheduleSave();
  clearNotice();
  // 공간 정리는 실패해도 카드 삭제에는 영향이 없다.
  if (c.hasThumb && thumbs) thumbs.remove(c.id).catch(() => {});
  if (c.origKey) p.blobs.remove(c.origKey).catch(() => {});
});

p.handle('set_text_color', ({ event } = {}) => {
  const c = cardById(selectedId);
  if (!c || c.kind !== 'text' || typeof event !== 'string' || !HEX.test(event)) return;
  touchCard(c.id, { color: event.toLowerCase() });
  refresh(false);
  scheduleSave();
  publishSelected();
  clearNotice();
});

p.handle('set_text', ({ event } = {}) => {
  const c = cardById(selectedId);
  if (!c || c.kind !== 'text' || typeof event !== 'string') return;
  const first = event.split(/\r?\n/)[0];
  touchCard(c.id, { text: event, title: [...first].slice(0, 40).join('') });
  refresh(false);
  scheduleSave();
  publishSelected();
  clearNotice();
});

p.handle('toggle_include_video', async ({ event } = {}) => {
  const c = cardById(selectedId);
  if (!c || c.kind !== 'video') return;
  const on = typeof event === 'boolean' ? event : !c.includeVideo;
  if (on && !(await p.blobs.has(c.origKey))) {
    setNotice(NO_ORIG_NOTICE);
    publishSelected();
    return;
  }
  touchCard(c.id, { includeVideo: on });
  scheduleSave();
  publishSelected();
  clearNotice();
});

p.handle('board_select', ({ event } = {}) => {
  const id = typeof event === 'string' ? event : event?.value;
  if (!liveBoards().some((b) => b.id === id) || id === boardId) return;
  boardId = id;
  p.setState('board', id);
  selectedId = null;
  publishSelected();
  ui = { ...ui, drag: null, view: { x: 0, y: 0, scale: 1 } };
  refresh(false);
  clearNotice();
});

p.handle('board_new', () => {
  const b = newBoard(`보드 ${liveBoards().length + 1}`);
  doc.boards.push(b);
  boardId = b.id;
  p.setState('board', b.id);
  selectedId = null;
  publishSelected();
  ui = { ...ui, drag: null, view: { x: 0, y: 0, scale: 1 } };
  refresh(false);
  scheduleSave();
  clearNotice();
});

p.handle('board_rename', ({ event } = {}) => {
  const raw = typeof event === 'string' ? event : p.getState('board_name');
  const name = typeof raw === 'string' ? raw.trim() : '';
  const b = board();
  if (!b || !name) return;
  Object.assign(b, { name, updatedAt: Date.now() });
  p.setState('board_name', '');
  publishBoards();
  scheduleSave();
  clearNotice();
});

// --- 시작 ---

p.onSurface(SURFACE, (surface) => {
  renderer.attach(surface);
  if (surface) ui = { ...ui, size: { w: surface.cssWidth, h: surface.cssHeight } };
});

// 다른 PC의 변경. 시작하는 동안 온 값도 받으려고 읽기 전에 건다.
let loaded = false;
p.storage.watch(BOARDS_ENTRY, (value) => {
  doc = mergeBoards(doc, value);
  if (!loaded) return;
  refresh(false);
  if (selectedId) publishSelected();
}, (err) => setNotice(err?.message ?? '보드를 읽지 못했어요'));
for (let i = 0; i < SHARDS; i++) {
  const id = shardIdOf(i);
  // 썸네일 저장소가 만들어지기 전에 온 값은 버린다. 저장소가 시작할 때 같은 항목을 새로 읽는다.
  p.storage.watch(id, (value) => {
    if (!thumbs) return;
    thumbs.reload(id, value);
    renderer.invalidateThumbs();
    if (cardById(selectedId)?.hasThumb) publishSelected();
  }, () => { /* 한 shard를 못 읽어도 나머지 썸네일은 그린다 */ });
}

async function start() {
  p.publish({ selected: null, selectedUrl: null, notice: null, exportInfo: '', boardOptions: [], board: null, boardName: '' });
  publishMode();
  const saved = p.getState('board');
  if (typeof saved === 'string') boardId = saved;

  doc = mergeBoards(doc, await p.storage.get(BOARDS_ENTRY));
  loaded = true;
  refresh(false);

  thumbs = await createThumbStore(p.storage, { shards: SHARDS });
  renderer.invalidateThumbs();
}

start().catch((err) => setNotice(err?.message ?? '보드를 읽지 못했어요'));

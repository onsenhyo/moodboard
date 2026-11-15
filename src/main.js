// client 진입점. 플랫폼 핸들러를 순수 모듈과 render.js에 잇는다.

import { createPlatform } from './platform/kaleidoscope.js';
import { newBoard, newGroup, liveGroups, GROUP_DEFAULT_SIZE } from './model.js';
import { sortedLayout, SORT_CELL, SORT_GAP, toWorld } from './layout.js';
import { BOARDS_ENTRY, mergeBoards, saveWithRetry, shardIdOf, createThumbStore } from './store.js';
import { ingestFiles, ingestText } from './ingest.js';
import { makeThumb } from './thumb.js';
import { reduce, initialState, placeNear, zoomAt, fitView, sortCols } from './interaction.js';
import { createRenderer } from './render.js';
import { THEMES, themeName } from './theme.js';
import { createGate, retryRead, createSaver } from './startup.js';
import { panelOutputs } from './panel.js';
import { createPreview } from './preview.js';
import { planExport, buildExportChunks, exportMessages, runExport } from './export.js';
// 빌드 1단계(npm run build:viewer)가 만든 뷰어 iife. esbuild text loader로 문자열이 된다.
import VIEWER_JS from '../dist/viewer.txt';

const SURFACE = 'board';
const PREVIEW_SURFACE = 'preview';
const EMBED_STATE = 'yt_embed';
const SHARDS = 128;
const DRAG_SAVE_MS = 400;
const ZOOM_STEP = 1.25;
const FULL_NOTICE = '썸네일 저장 공간이 가득 찼어요 (약 1,200장)';
const NO_ORIG_NOTICE = '원본은 다른 PC에 있어요';
const DEFAULT_BOARD = '내 보드';
const LOADING_NOTICE = '보드를 불러오는 중이에요';
const RETRYING_NOTICE = '보드를 다 불러오지 못해 다시 읽는 중이에요';
const HEX = /^#[0-9a-f]{6}$/i;

const p = createPlatform(window.kaleidoscope);

let doc = { version: 1, boards: [] };
let boardId = null;
let ui = initialState();
let selectedId = null;
let selectedGroupId = null; // 선택한 묶음. selectedId와 함께 참이 되지 않는다
let notice = null;
let thumbs = null;
let loaded = false; // boards를 한 번이라도 읽었는가
let loadingNotice = LOADING_NOTICE; // 시작 읽기가 다 끝날 때까지 notice 아래에 깔린다
const ready = createGate(); // boards와 썸네일 저장소가 준비되면 열린다

// --- 보드와 카드 ---

const liveBoards = () => doc.boards.filter((b) => !b.deleted);
const board = () => liveBoards().find((b) => b.id === boardId) ?? null;
const liveCards = () => (board()?.cards ?? []).filter((c) => !c.deleted);
const cardById = (id) => (id ? liveCards().find((c) => c.id === id) ?? null : null);
const boardGroups = () => liveGroups(board());
const groupById = (id) => (id ? boardGroups().find((g) => g.id === id) ?? null : null);
const groupCards = (id) => liveCards().filter((c) => c.groupId === id);

function ensureBoard() {
  if (!board()) boardId = liveBoards()[0]?.id ?? null;
  // 저장된 보드를 읽기 전에는 기본 보드를 만들지 않는다.
  if (!boardId && loaded) {
    const b = newBoard(DEFAULT_BOARD);
    doc.boards.push(b);
    boardId = b.id;
    scheduleSave();
  }
}

function touchCard(id, patch, t = Date.now()) {
  const c = cardById(id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: t });
  return c;
}

// 카드를 묶음에서 뺄 때는 groupId 키를 지운다(저장 스키마가 문자열만 받아 null을 쓰지 않는다).
function setCardGroup(id, groupId, t = Date.now()) {
  const c = cardById(id);
  if (!c) return null;
  if (typeof groupId === 'string' && groupId) c.groupId = groupId;
  else delete c.groupId;
  c.updatedAt = t;
  return c;
}

function touchGroup(id, patch, t = Date.now()) {
  const g = groupById(id);
  if (!g) return null;
  Object.assign(g, patch, { updatedAt: t });
  return g;
}

// --- 저장 ---

// 저장은 한 줄로 세운다. 창을 닫을 때 saver.flush()가 남은 저장을 끝낸다.
const saver = createSaver(async () => {
  const next = await saveWithRetry(p.storage, (d) => d, { local: doc });
  // 저장하는 동안 바뀐 로컬 내용이 이기도록 로컬을 앞에 둔다.
  doc = mergeBoards(doc, next);
  refresh(false);
}, { onError: (err) => setNotice(err?.message ?? '저장하지 못했어요') });

const scheduleSave = (ms = 0) => saver.schedule(ms);

// --- 출력 ---

function publishNotice() {
  const text = notice ?? loadingNotice;
  p.publish({ notice: text, has_notice: typeof text === 'string' && text !== '' });
}
function setNotice(text) {
  notice = text ?? null;
  publishNotice();
}
function setLoadingNotice(text) {
  loadingNotice = text ?? null;
  publishNotice();
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

const preview = createPreview();
let embedState; // 마지막으로 쓴 yt_embed. 같은 값을 다시 쓰지 않는다.

// SHIM(p2/x): panel.js에 묶음 출력이 들어오기 전까지 group_selected·has_group_selected를 여기서 채운다.
// panel 쪽 브랜치를 합친 뒤 이 함수와 publishPanel 안의 호출 한 줄을 지운다.
// panelOutputs가 이미 group_selected를 내면 아무것도 하지 않는다.
function shimGroupPanel(sel, panel) {
  if ('group_selected' in panel) return panel;
  const g = sel?.group ?? null;
  if (!g) return { ...panel, group_selected: null, has_group_selected: false };
  // 묶음을 골랐을 때는 카드 쪽 출력을 비운다.
  return { ...panelOutputs(null), sel_none: false, group_selected: { id: g.id, name: g.name, count: g.count }, has_group_selected: true };
}

// 옆 칸 출력. web_view의 url은 창 상태만 받으므로 유튜브 주소는 상태 yt_embed에도 쓴다.
// sel: 카드 선택 객체 | {group:{id, name, count}} | null
function publishPanel(sel) {
  const panel = shimGroupPanel(sel, panelOutputs(sel)); // SHIM(p2/x): 합친 뒤 panelOutputs(sel)만 남긴다
  const card = sel && !sel.group ? sel : null;
  const count = sel?.group ? sel.group.count : null;
  p.publish({
    selected: card,
    selected_url: card?.url ?? null,
    group_count_label: count == null ? '' : `${count}장`,
    ...panel,
  });
  if (panel.embed_url !== embedState) {
    embedState = panel.embed_url;
    p.setState(EMBED_STATE, panel.embed_url);
  }
  preview.show(card && panel.sel_thumb_preview ? card.thumbDataUrl : null);
}

let selectSeq = 0;
async function publishSelected() {
  const seq = ++selectSeq;
  const g = groupById(selectedGroupId);
  if (g) {
    publishPanel({ group: { id: g.id, name: g.name ?? '', count: groupCards(g.id).length } });
    return;
  }
  const c = cardById(selectedId);
  if (!c) {
    publishPanel(null);
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
  publishPanel(selected);
}

// 카드 하나 또는 묶음 하나를 고른다. 둘 다 null이면 선택을 푼다.
function select({ cardId = null, groupId = null } = {}) {
  const prevGroup = selectedGroupId;
  selectedId = cardId;
  selectedGroupId = cardId ? null : groupId;
  // 이름 입력칸은 묶음을 새로 고를 때만 채운다(입력 중인 글을 덮지 않는다).
  if (selectedGroupId && selectedGroupId !== prevGroup) p.setState('group_name', groupById(selectedGroupId)?.name ?? '');
  publishSelected();
}

function publishBoards() {
  p.publish({
    board_options: liveBoards().map((b) => ({ value: b.id, label: b.name })),
    board: boardId,
    board_label: board()?.name ?? '',
  });
}

function publishMode() {
  p.publish({ mode: ui.mode, sorted: ui.mode === 'sorted', manual_mode: ui.mode === 'manual' });
}

// --- 그리기 ---

// 쉘 테마(시스템이면 OS 설정)를 frame의 prefers-color-scheme으로 받는다.
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let themeKey = themeName(!!darkQuery?.matches);

const renderer = createRenderer({
  scene: () => ({
    cards: ui.cards, groups: ui.groups, view: ui.view, selectedId, selectedGroupId, drag: ui.drag, mode: ui.mode,
  }),
  thumbB64: (id) => (thumbs ? thumbs.get(id) : Promise.resolve(null)),
  theme: () => THEMES[themeKey],
});

function setTheme(name) {
  if (name !== themeKey) {
    themeKey = name;
    renderer.redraw();
  }
  p.setState('theme', name);
}
darkQuery?.addEventListener?.('change', (e) => setTheme(themeName(!!e.matches)));

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
  ui = { ...ui, cards, groups: boardGroups(), sorted };
  if (selectedId && !cardById(selectedId)) select();
  else if (selectedGroupId && !groupById(selectedGroupId)) select();
  renderer.setTargets(targets(), animate);
  publishBoards();
}

// 문서 객체를 고친 뒤 화면 상태만 다시 맞춘다(정렬 배치는 그대로).
function syncUi() {
  ui = { ...ui, cards: liveCards(), groups: boardGroups() };
  renderer.setTargets(targets(), false);
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

// 넣기 동작은 시작이 끝날 때까지 기다렸다가 순서대로 실행한다.
async function onFiles({ event } = {}) {
  if (!event || event.cancelled) return;
  const files = Array.isArray(event.files) ? event.files : [];
  if (!files.length) return;
  await ready.run(async () => {
    const { cards, full } = await ingestFiles(files, ingestDeps());
    addCards(cards, full);
  });
}

// --- 동작 ---

p.handle('drop', onFiles);
p.handle('pick', onFiles);

p.handle('add_text', async ({ event } = {}) => {
  const raw = typeof event === 'string' ? event : p.getState('draft');
  if (typeof raw !== 'string' || !raw.trim()) return;
  await ready.run(async () => {
    const { card, full } = await ingestText(raw, ingestDeps());
    addCards(card ? [card] : [], full);
    if (card) p.setState('draft', '');
  });
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
      select({ cardId: e.cardId ?? null, groupId: e.groupId ?? null });
      clearNotice();
    } else if (e.type === 'moved') {
      touchCard(e.cardId, { manual: { ...e.rect } });
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
      clearNotice();
    } else if (e.type === 'membership') {
      setCardGroup(e.cardId, e.groupId);
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
      if (selectedGroupId) publishSelected(); // 카드 수가 바뀐다
    } else if (e.type === 'group_moved') {
      // 묶음과 안의 카드를 한 번의 저장(saveWithRetry 한 번)에 담는다. 디바운스하지 않는다.
      const t = Date.now();
      touchGroup(e.groupId, { rect: { ...e.rect } }, t);
      for (const m of e.cards ?? []) touchCard(m.cardId, { manual: { ...m.rect } }, t);
      syncUi();
      scheduleSave(0);
      clearNotice();
    } else if (e.type === 'group_resized') {
      touchGroup(e.groupId, { rect: { ...e.rect } });
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
      clearNotice();
    } else if (e.type === 'group_toggled') {
      const g = groupById(e.groupId);
      if (g) touchGroup(g.id, { collapsed: !g.collapsed });
      // 접혀서 숨은 카드는 선택을 푼다
      if (g?.collapsed && cardById(selectedId)?.groupId === g.id) select();
      syncUi();
      scheduleSave(DRAG_SAVE_MS);
      clearNotice();
    } else if (e.type === 'notice') {
      setNotice(e.text);
    }
  }
  if (ui.drag || prevDrag) renderer.redraw();
});

// --- 묶음 ---

p.handle('group_add', () => {
  const b = board();
  if (!b) return;
  if (ui.mode !== 'manual') setMode('manual'); // 정렬 모드에서는 묶음이 보이지 않는다
  const size = surfaceSize();
  const c = toWorld(ui.view, { x: size.w / 2, y: size.h / 2 });
  const { w, h } = GROUP_DEFAULT_SIZE;
  const g = newGroup({ rect: { x: c.x - w / 2, y: c.y - h / 2, w, h } });
  if (!Array.isArray(b.groups)) b.groups = [];
  b.groups.push(g);
  refresh(false);
  select({ groupId: g.id });
  scheduleSave();
  clearNotice();
});

p.handle('group_rename', ({ event } = {}) => {
  const raw = typeof event === 'string' ? event : p.getState('group_name');
  const name = typeof raw === 'string' ? raw.trim() : '';
  const g = groupById(selectedGroupId);
  if (!g || !name) return;
  if (name !== g.name) {
    touchGroup(g.id, { name });
    syncUi();
    scheduleSave(DRAG_SAVE_MS);
  }
  p.setState('group_name', name);
  publishSelected();
  clearNotice();
});

p.handle('group_delete', () => {
  const g = groupById(selectedGroupId);
  if (!g) return;
  const t = Date.now();
  // 묶음은 묘비로 남기고, 안의 카드는 groupId를 지운다. 카드 자체는 남는다.
  for (const c of groupCards(g.id)) setCardGroup(c.id, null, t);
  touchGroup(g.id, { deleted: true }, t);
  select();
  refresh(false);
  scheduleSave();
  clearNotice();
});

p.handle('delete_selected', async () => {
  const c = cardById(selectedId);
  if (!c) return;
  touchCard(c.id, { deleted: true });
  select();
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
  select();
  ui = { ...ui, drag: null, view: { x: 0, y: 0, scale: 1 } };
  refresh(false);
  clearNotice();
});

p.handle('board_new', () => {
  const b = newBoard(`보드 ${liveBoards().length + 1}`);
  doc.boards.push(b);
  boardId = b.id;
  p.setState('board', b.id);
  select();
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
  p.setState('rename_open', false); // 동작 목록에 client를 섞을 수 없어 대화상자는 여기서 닫는다
  publishBoards();
  scheduleSave();
  clearNotice();
});

// --- 내보내기 ---

let exporting = false;

function publishExportInfo(text) {
  p.publish({ export_info: text, has_export_info: text !== '' });
}

// 원본 영상을 열어 file id와 크기를 얻는다. 없거나 열지 못하면 null.
async function openOrig(key) {
  if (!key) return null;
  try {
    const f = await p.blobs.open(key);
    return f && f.id ? { id: f.id, size: Number(f.size) } : null;
  } catch {
    return null;
  }
}

// save_prompt는 선언한 client 동작 안에서만 열리므로 이 핸들러가 끝날 때까지 기다린다.
p.handle('export', async () => {
  if (exporting) return;
  exporting = true;
  try {
    await ready.run(async () => {
      const b = board();
      if (!b) return;
      const cards = liveCards();
      const thumbB64 = new Map();
      for (const c of cards) {
        if (!c.hasThumb || !thumbs) continue;
        const v = await thumbs.get(c.id).catch(() => null);
        if (v) thumbB64.set(c.id, v);
      }
      const origs = new Map();
      for (const c of cards) {
        if (c.kind === 'video' && c.includeVideo) origs.set(c.id, await openOrig(c.origKey));
      }
      const plan = planExport(b, {
        thumbSizes: new Map([...thumbB64].map(([id, v]) => [id, (v.length * 3) / 4])),
        origSizes: new Map([...origs].map(([id, f]) => [id, f ? f.size : null])),
      });
      const msg = exportMessages(b, plan);
      publishExportInfo(msg.info);
      if (msg.notice) { setNotice(msg.notice); return; }
      const readers = {
        thumb: async (id) => thumbB64.get(id) ?? null,
        video: async (id) => {
          const f = origs.get(id);
          return f ? p.files.read(f.id) : null;
        },
        viewerJs: VIEWER_JS,
      };
      const snapshot = structuredClone(b);
      const r = await runExport({ name: b.name, files: p.files, chunks: () => buildExportChunks(snapshot, plan, readers) });
      if (r.status === 'done') setNotice(`내보냈어요: ${r.name}`);
    });
  } catch (err) {
    setNotice(`내보내지 못했어요: ${err?.message ?? err}`);
  } finally {
    exporting = false;
  }
});

// --- 시작 ---

p.onSurface(PREVIEW_SURFACE, (surface) => preview.attach(surface));

p.onSurface(SURFACE, (surface) => {
  renderer.attach(surface);
  if (surface) ui = { ...ui, size: { w: surface.cssWidth, h: surface.cssHeight } };
});

// 창을 닫을 때 쉘은 closing 리스너가 돌려준 promise와 이미 보낸 setStorage를 기다린다.
// 디바운스 중인 저장과 읽기 단계에 있는 저장을 여기서 끝낸다.
p.onLifecycle((lifecycle) => (lifecycle?.phase === 'closing' ? saver.flush() : undefined));

function finishBoardsLoad(value) {
  doc = mergeBoards(doc, value);
  if (loaded) return;
  loaded = true;
  refresh(false);
}

// 다른 PC의 변경. 시작하는 동안 온 값도 받으려고 읽기 전에 건다.
p.storage.watch(BOARDS_ENTRY, (value) => {
  if (!loaded) { finishBoardsLoad(value); updateLoading(); return; }
  doc = mergeBoards(doc, value);
  refresh(false);
  if (selectedId || selectedGroupId) publishSelected();
}, () => { /* 시작 읽기의 재시도가 알린다 */ });

// 썸네일 저장소가 생기기 전에 온 shard 값은 모아 두었다가(마지막 값이 이긴다) 저장소가 생기면 적용한다.
const pendingShards = new Map();
function applyShard(id, value) {
  thumbs.reload(id, value);
  renderer.invalidateThumbs();
  if (cardById(selectedId)?.hasThumb) publishSelected();
  updateLoading();
}
for (let i = 0; i < SHARDS; i++) {
  const id = shardIdOf(i);
  p.storage.watch(id, (value) => {
    if (!thumbs) { pendingShards.set(id, value); return; }
    applyShard(id, value);
  }, () => { /* 시작 읽기의 재시도가 알린다 */ });
}

let retrying = false;
function updateLoading() {
  const done = loaded && thumbs && thumbs.missing().length === 0;
  if (done) setLoadingNotice(null);
  else setLoadingNotice(retrying ? RETRYING_NOTICE : LOADING_NOTICE);
  if (loaded && thumbs) ready.open();
}
const onReadFail = () => { if (!retrying) { retrying = true; updateLoading(); } };

async function start() {
  p.publish({ export_info: '', has_export_info: false, board_options: [], board: null, board_label: '' });
  publishPanel(null);
  publishNotice();
  publishMode();
  setTheme(themeKey);
  const saved = p.getState('board');
  if (typeof saved === 'string') boardId = saved;

  // boards와 shard 읽기를 함께 시작한다. 실패한 읽기는 1·2·4초, 그다음 10초마다 다시 한다.
  const boardsLoad = retryRead(() => p.storage.get(BOARDS_ENTRY), { onFail: onReadFail, stop: () => loaded })
    .then((r) => { if (!r.stopped) finishBoardsLoad(r.value); updateLoading(); });

  // 읽은 shard만으로 저장소를 만든다. 못 읽은 shard는 읽힐 때까지 쓰기를 받지 않는다.
  thumbs = await createThumbStore(p.storage, { shards: SHARDS });
  for (const [id, value] of pendingShards) thumbs.reload(id, value);
  pendingShards.clear();
  renderer.invalidateThumbs();
  const missing = thumbs.missing();
  if (missing.length) onReadFail();
  updateLoading();
  await Promise.all([
    boardsLoad,
    ...missing.map((id) => retryRead(() => p.storage.get(id), {
      onFail: onReadFail,
      stop: () => !thumbs.missing().includes(id),
    }).then((r) => { if (!r.stopped) applyShard(id, r.value); })),
  ]);
}

start().catch((err) => setNotice(err?.message ?? '보드를 읽지 못했어요'));

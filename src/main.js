// client 진입점. 플랫폼 핸들러를 순수 모듈에 잇는다.
// 보드 그리기와 조작은 sandbox(board/board.js)가 맡는다. client는 넣기, 링크, blobs, 옆 칸, 내보내기,
// 보드 관리를 맡고, 창 상태로 sandbox와 주고받는다.
// - 읽기: selected {kind, id}|null, view {cx, cy, scale}, paste_inbox {text, n}
// - 쓰기: board(지금 보드 id), mode, cmd {op, n}, selected(묶음 추가와 지우기)

import { createPlatform } from './platform/kaleidoscope.js';
import { newBoard, newGroup, liveGroups, GROUP_DEFAULT_SIZE } from './model.js';
import { BOARDS_ENTRY, shardIdOf, createThumbStore } from './store.js';
import { createDocEditor, cardTextPatch, MEMO_MAX } from './patches.js';
import { ingestFiles, ingestText } from './ingest.js';
import { makeThumb } from './thumb.js';
import { placeNear } from './interaction.js';
import { THEMES, themeName } from './theme.js';
import {
  normSelected, resolveSelected, deleteCardPatches, deleteGroupPatches, staleTombstones, viewCenter,
} from './selection.js';
import { createGate, retryRead, createSaver } from './startup.js';
import { panelOutputs, MEMO_KINDS } from './panel.js';
import { createPreview } from './preview.js';
import { loadBoardHtml, errorHtml } from './boardhtml.js';
import { boardPartIds, exportAssetId } from './manifest.js';

const PREVIEW_SURFACE = 'preview';
// 자산 매니페스트. 진입 로더가 moodboard-manifest를 읽어 둔다(scripts/pack.mjs, src/manifest.js).
const MANIFEST = globalThis.MOODBOARD_MANIFEST;
// 내보내기 코드와 뷰어(src/export-entry.js). client 자산 크기를 줄이려고 따로 올린 javascript 자산이다.
// 내용은 base64(gzip(iife)) 문자열 리터럴 한 문장이고(scripts/pack.mjs), 내보낼 때만 읽어 풀고 eval한다.
const EXPORT_ASSET = exportAssetId(MANIFEST);
const EMBED_STATE = 'yt_embed';
const SHARDS = 128;
const DRAG_SAVE_MS = 400;
const FULL_NOTICE = '썸네일 저장 공간이 가득 찼어요 (약 1,200장)';
const NO_ORIG_NOTICE = '원본은 다른 PC에 있어요';
const DEFAULT_BOARD = '내 보드';
const LOADING_NOTICE = '보드를 불러오는 중이에요';
const RETRYING_NOTICE = '보드를 다 불러오지 못해 다시 읽는 중이에요';
const HEX = /^#[0-9a-f]{6}$/i;

const p = createPlatform(window.kaleidoscope);

// 보드 문서. 편집은 패치로 쌓아 저장한다(patches.js). ed.doc은 저장 값 위에 아직 안 쓴 패치를 얹은 화면용 문서다.
const ed = createDocEditor({ adapter: p.storage });
let boardId = null;
let mode = 'manual';
let selectedId = null; // 창 상태 selected에서 온다(sandbox가 쓴다)
let selectedGroupId = null; // 선택한 묶음. selectedId와 함께 참이 되지 않는다
let boardState; // 마지막으로 쓴 창 상태 board
let notice = null;
let thumbs = null;
let loaded = false; // boards를 한 번이라도 읽었는가
let loadingNotice = LOADING_NOTICE; // 시작 읽기가 다 끝날 때까지 notice 아래에 깔린다
const ready = createGate(); // boards와 썸네일 저장소가 준비되면 열린다

// --- 보드와 카드 ---

const liveBoards = () => ed.doc.boards.filter((b) => !b.deleted);
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
    ed.edit({ kind: 'board', id: b.id, insert: b, t: b.updatedAt });
    boardId = b.id;
    scheduleSave();
  }
  // sandbox 보드는 창 상태 board로 지금 보드를 안다.
  if (loaded && boardId && boardId !== boardState) {
    boardState = boardId;
    p.setState('board', boardId);
  }
}

// 지금 보드의 카드나 묶음 하나를 고치는 패치. 고친 필드만 저장에 실린다.
function touchCard(id, fields, deleteKeys) {
  if (!cardById(id)) return false;
  ed.edit({ kind: 'card', boardId, id, fields, deleteKeys });
  return true;
}

function touchGroup(id, fields) {
  if (!groupById(id)) return false;
  ed.edit({ kind: 'group', boardId, id, fields });
  return true;
}

function touchBoard(fields, deleteKeys) {
  if (!board()) return false;
  ed.edit({ kind: 'board', id: boardId, fields, deleteKeys });
  return true;
}

// --- 저장 ---

// 저장은 한 줄로 세운다. 창을 닫을 때 saver.flush()가 남은 저장을 끝낸다.
// 저장은 새로 읽은 값에 쌓인 패치를 적용해 쓴다. 다른 프레임(sandbox)이 고친 필드를 덮지 않는다.
const saver = createSaver(async () => {
  await ed.save();
  refresh();
}, {
  // 패치는 쓰기가 성공할 때까지 줄에 남는다. 실패하면 조금 뒤 다시 저장한다.
  onError: (err) => {
    setNotice(err?.message ?? '저장하지 못했어요');
    if (ed.pending) saver.schedule(3000);
  },
});

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

const preview = createPreview({ theme: () => THEMES[themeKey] });
let embedState; // 마지막으로 쓴 yt_embed. 같은 값을 다시 쓰지 않는다.

// 옆 칸 출력. web_view의 url은 창 상태만 받으므로 유튜브 주소는 상태 yt_embed에도 쓴다.
// sel: 카드 선택 객체 | {group:{id, name, count}} | null
function publishPanel(sel) {
  const panel = panelOutputs(sel);
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
    label: c.label ?? null,
    memo: c.memo ?? null,
    url: c.url ?? null,
    text: c.text ?? null,
    color: c.color,
    paper: c.paper ?? null,
    paperDefault: THEMES[themeKey].textBg,
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

// 카드 하나 또는 묶음 하나를 고른다. 둘 다 null이면 선택을 푼다. write이면 창 상태 selected에도 쓴다.
function select({ cardId = null, groupId = null } = {}, write = true) {
  const prevGroup = selectedGroupId;
  selectedId = cardId;
  selectedGroupId = cardId ? null : groupId;
  // 이름 입력칸은 묶음을 새로 고를 때만 채운다(입력 중인 글을 덮지 않는다).
  if (selectedGroupId && selectedGroupId !== prevGroup) p.setState('group_name', groupById(selectedGroupId)?.name ?? '');
  if (write) {
    const sel = selectedId ? { kind: 'card', id: selectedId } : selectedGroupId ? { kind: 'group', id: selectedGroupId } : null;
    if (JSON.stringify(normSelected(p.getState('selected'))) !== JSON.stringify(sel)) p.setState('selected', sel);
  }
  publishSelected();
}

// 창 상태 selected(sandbox가 쓴다)를 옆 칸에 옮긴다.
function onSelectedState(value) {
  const s = normSelected(value);
  const cardId = s?.kind === 'card' ? s.id : null;
  const groupId = s?.kind === 'group' ? s.id : null;
  if (cardId === selectedId && groupId === selectedGroupId) return;
  select({ cardId, groupId }, false);
  clearNotice();
}

function publishBoards() {
  const bg = board()?.bg;
  p.publish({
    board_options: liveBoards().map((b) => ({ value: b.id, label: b.name })),
    board: boardId,
    board_label: board()?.name ?? '',
    // 툴바 [배경] color. 보드 bg가 없으면 지금 테마의 바탕을 보인다.
    board_bg: HEX.test(bg ?? '') ? bg : THEMES[themeKey].bg,
    has_board_bg: HEX.test(bg ?? ''),
  });
}

function publishMode() {
  p.publish({ mode, sorted: mode === 'sorted', manual_mode: mode === 'manual' });
}

// --- 테마 ---

// 쉘 테마(시스템이면 OS 설정)를 frame의 prefers-color-scheme으로 받는다.
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let themeKey = themeName(!!darkQuery?.matches);

function setTheme(name) {
  if (name !== themeKey) {
    themeKey = name;
    preview.redraw();
    // [배경]과 [종이 색]의 기본값은 테마를 따른다.
    publishBoards();
    publishSelected();
  }
  p.setState('theme', name);
}
darkQuery?.addEventListener?.('change', (e) => setTheme(themeName(!!e.matches)));

// 지운 카드의 썸네일과 원본은 묘비가 된 지 7일이 지나고 여전히 묘비일 때만 걷어낸다.
// 묘비는 병합에서 뒤집힐 수 있다(다른 PC나 sandbox의 더 늦은 편집). 7일 안에 되살려도 잃는 것이 없다.
// 시작할 때와 그다음 한 시간마다 돈다. 썸네일 저장소가 준비된 뒤에만 돈다.
const GC_EVERY_MS = 3600 * 1000;
const collected = new Set(); // 이번 세션에 걷어낸 카드
function collectGarbage() {
  if (!loaded || !thumbs) return;
  for (const c of staleTombstones(ed.doc, Date.now())) {
    if (collected.has(c.id)) continue;
    collected.add(c.id);
    // 공간 정리는 실패해도 괜찮다.
    if (c.hasThumb) thumbs.remove(c.id).catch(() => {});
    if (c.origKey) p.blobs.remove(c.origKey).catch(() => {});
  }
}

// 고른 것이 지워졌거나 다른 보드의 것이면 참. 아직 모르는 id(다른 PC에서 막 온 카드)는 남긴다.
function selectionGone() {
  const sel = selectedId ? { kind: 'card', id: selectedId } : { kind: 'group', id: selectedGroupId };
  if (resolveSelected(sel, board())) return false;
  const key = sel.kind === 'card' ? 'cards' : 'groups';
  return ed.doc.boards.some((b) => (b[key] ?? []).some((x) => x.id === sel.id));
}

// 문서가 바뀐 뒤 출력을 다시 맞춘다. 고른 것이 사라졌으면 선택을 푼다.
function refresh() {
  ensureBoard();
  if (loaded && (selectedId || selectedGroupId) && selectionGone()) select();
  publishBoards();
}

// 새 카드와 묶음은 sandbox가 알린 화면 가운데(창 상태 view)에 놓는다.
const center = () => viewCenter(p.getState('view'));

// --- 넣기 ---

function ingestDeps() {
  const c = center();
  return {
    readBytes: (id) => p.files.read(id),
    blobPut: (key, fileId) => p.blobs.put(key, fileId),
    makeThumb,
    thumbs,
    now: Date.now,
    placeAt: () => placeNear({ x: c.x, y: c.y, scale: c.scale }, { w: 0, h: 0 }),
    httpRead: (permission, path, query) => p.http.read(permission, path, query),
  };
}

function addCards(cards, full) {
  const b = board();
  if (b && cards.length) {
    ed.edit(cards.map((c) => ({ kind: 'card', boardId: b.id, id: c.id, insert: c, t: c.updatedAt })));
    refresh();
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

async function addText(raw, clearDraft) {
  if (typeof raw !== 'string' || !raw.trim()) return;
  await ready.run(async () => {
    const { card, full } = await ingestText(raw, ingestDeps());
    addCards(card ? [card] : [], full);
    if (card && clearDraft) p.setState('draft', '');
  });
}

p.handle('add_text', ({ event } = {}) => addText(typeof event === 'string' ? event : p.getState('draft'), true));

// sandbox 보드에서 ⌘V로 붙여 넣은 글. n이 바뀔 때만 넣는다(창을 다시 열 때 남은 값은 넣지 않는다).
let pasteSeen = p.getState('paste_inbox')?.n;
function onPasteState(v) {
  if (!v || typeof v !== 'object' || v.n === pasteSeen) return;
  pasteSeen = v.n;
  addText(v.text, false).catch((err) => setNotice(err?.message ?? '넣지 못했어요'));
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  p.setState('mode', mode);
  publishMode();
  clearNotice();
}
p.handle('sort_color', () => setMode('sorted'));
p.handle('sort_manual', () => setMode('manual'));

// 확대와 맞춤은 sandbox가 한다. n은 같은 단추를 다시 눌러도 바뀌게 하는 번호다.
let cmdSeq = 0;
const sendCmd = (op) => p.setState('cmd', { op, n: Date.now() * 1000 + (cmdSeq++ % 1000) });
p.handle('zoom_in', () => sendCmd('zoom_in'));
p.handle('zoom_out', () => sendCmd('zoom_out'));
p.handle('zoom_fit', () => sendCmd('fit'));

// --- 묶음 ---

p.handle('group_add', () => {
  const b = board();
  if (!b) return;
  if (mode !== 'manual') setMode('manual'); // 정렬 모드에서는 묶음이 보이지 않는다
  const c = center();
  const { w, h } = GROUP_DEFAULT_SIZE;
  const g = newGroup({ rect: { x: c.x - w / 2, y: c.y - h / 2, w, h } });
  ed.edit({ kind: 'group', boardId: b.id, id: g.id, insert: g, t: g.updatedAt });
  refresh();
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
    scheduleSave(DRAG_SAVE_MS);
  }
  p.setState('group_name', name);
  publishSelected();
  clearNotice();
});

p.handle('group_delete', () => {
  // 묶음은 묘비로 남기고, 안의 카드는 groupId를 지운다. 카드 자체는 남는다.
  const patches = deleteGroupPatches(board(), selectedGroupId);
  if (!patches.length) return;
  ed.edit(patches);
  select();
  refresh();
  scheduleSave();
  clearNotice();
});

// 썸네일과 원본은 바로 지우지 않는다(collectGarbage가 7일 뒤 걷는다).
p.handle('delete_selected', () => {
  const patches = deleteCardPatches(board(), selectedId);
  if (!patches.length) return;
  ed.edit(patches);
  select();
  refresh();
  scheduleSave();
  clearNotice();
});

p.handle('set_text_color', ({ event } = {}) => {
  const c = cardById(selectedId);
  if (!c || c.kind !== 'text' || typeof event !== 'string' || !HEX.test(event)) return;
  touchCard(c.id, { color: event.toLowerCase() });
  refresh();
  scheduleSave();
  publishSelected();
  clearNotice();
});

// 보드 배경과 글 카드 종이. color 블록은 끄는 동안 값을 여러 번 보내므로 저장은 조금 모아서 한다.
// 기본값으로 돌릴 때는 키를 지운다(저장 스키마는 문자열만 받아 null을 쓰지 않는다).
function setBoardBg(value) {
  if (!(value === null ? touchBoard(undefined, ['bg']) : touchBoard({ bg: value }))) return;
  publishBoards();
  scheduleSave(DRAG_SAVE_MS);
  clearNotice();
}

p.handle('set_board_bg', ({ event } = {}) => {
  if (typeof event !== 'string' || !HEX.test(event)) return;
  setBoardBg(event.toLowerCase());
});

p.handle('reset_board_bg', () => {
  if (board() && 'bg' in board()) setBoardBg(null);
});

function setTextPaper(value) {
  const c = cardById(selectedId);
  if (!c || c.kind !== 'text') return;
  if (value === null) touchCard(c.id, undefined, ['paper']);
  else touchCard(c.id, { paper: value });
  refresh();
  scheduleSave(DRAG_SAVE_MS);
  publishSelected();
  clearNotice();
}

p.handle('set_text_paper', ({ event } = {}) => {
  if (typeof event !== 'string' || !HEX.test(event)) return;
  setTextPaper(event.toLowerCase());
});

p.handle('reset_text_paper', () => {
  const c = cardById(selectedId);
  if (c && 'paper' in c) setTextPaper(null);
});

p.handle('set_text', ({ event } = {}) => {
  const c = cardById(selectedId);
  if (!c || c.kind !== 'text' || typeof event !== 'string') return;
  const first = event.split(/\r?\n/)[0];
  touchCard(c.id, { text: event, title: [...first].slice(0, 40).join('') });
  refresh();
  scheduleSave();
  publishSelected();
  clearNotice();
});

// 카드 이름(label)과 메모(memo). 빈 값이면 키를 지운다. 이름은 Enter, 메모는 입력칸을 떠날 때 온다.
function setCardText(field, event, max) {
  const c = cardById(selectedId);
  if (!c || typeof event !== 'string' || (field === 'memo' && !MEMO_KINDS.has(c.kind))) return;
  const patch = cardTextPatch(boardId, c.id, field, event, max);
  if (patch.fields ? patch.fields[field] !== c[field] : field in c) {
    ed.edit(patch);
    refresh();
    scheduleSave();
  }
  publishSelected();
  clearNotice();
}

p.handle('set_card_label', ({ event } = {}) => setCardText('label', event));
p.handle('set_card_memo', ({ event } = {}) => setCardText('memo', event, MEMO_MAX));

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
  select();
  refresh();
  clearNotice();
});

p.handle('board_new', () => {
  const b = newBoard(`보드 ${liveBoards().length + 1}`);
  ed.edit({ kind: 'board', id: b.id, insert: b, t: b.updatedAt });
  boardId = b.id;
  select();
  refresh();
  scheduleSave();
  clearNotice();
});

p.handle('board_rename', ({ event } = {}) => {
  const raw = typeof event === 'string' ? event : p.getState('board_name');
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || !touchBoard({ name })) return;
  p.setState('board_name', '');
  p.setState('rename_open', false); // 동작 목록에 client를 섞을 수 없어 대화상자는 여기서 닫는다
  publishBoards();
  scheduleSave();
  clearNotice();
});

// --- 내보내기 ---

let exporting = false;
let exportMod = null;

async function loadExport() {
  if (exportMod) return exportMod;
  const text = new TextDecoder().decode(await p.assetBytes(EXPORT_ASSET)).trim();
  const bytes = Uint8Array.from(atob(JSON.parse(text.replace(/;$/, ''))), (ch) => ch.charCodeAt(0));
  const js = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  (0, eval)(js); // var moodboardExport = ...
  exportMod = globalThis.moodboardExport;
  if (!exportMod?.runExport) throw new Error('내보내기 자산을 읽지 못했어요');
  return exportMod;
}

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
      const { planExport, buildExportChunks, exportMessages, runExport, VIEWER_JS } = await loadExport();
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

p.onState((state) => {
  onSelectedState(state.selected);
  onPasteState(state.paste_inbox);
});

// 창을 닫을 때 쉘은 closing 리스너가 돌려준 promise와 이미 보낸 setStorage를 기다린다.
// 디바운스 중인 저장과 읽기 단계에 있는 저장을 여기서 끝낸다.
p.onLifecycle((lifecycle) => (lifecycle?.phase === 'closing' ? saver.flush() : undefined));

// 시작 읽기. 그보다 먼저 온 변경(watch)이 있으면 그 값이 더 새로우므로 읽은 값은 버린다.
function finishBoardsLoad(value) {
  if (loaded) return;
  ed.receive(value);
  loaded = true;
  refresh();
  collectGarbage();
}

// 다른 PC의 변경. 시작하는 동안 온 값도 받으려고 읽기 전에 건다.
p.storage.watch(BOARDS_ENTRY, (value) => {
  if (!loaded) { finishBoardsLoad(value); updateLoading(); return; }
  ed.receive(value);
  refresh();
  if (selectedId || selectedGroupId) publishSelected();
}, () => { /* 시작 읽기의 재시도가 알린다 */ });

// 썸네일 저장소가 생기기 전에 온 shard 값은 모아 두었다가(마지막 값이 이긴다) 저장소가 생기면 적용한다.
const pendingShards = new Map();
function applyShard(id, value) {
  thumbs.reload(id, value);
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
  if (p.getState('mode') === 'sorted') { mode = 'sorted'; publishMode(); }
  onSelectedState(p.getState('selected'));

  // boards와 shard 읽기를 함께 시작한다. 실패한 읽기는 1·2·4초, 그다음 10초마다 다시 한다.
  const boardsLoad = retryRead(() => p.storage.get(BOARDS_ENTRY), { onFail: onReadFail, stop: () => loaded })
    .then((r) => { if (!r.stopped) finishBoardsLoad(r.value); updateLoading(); });

  // 읽은 shard만으로 저장소를 만든다. 못 읽은 shard는 읽힐 때까지 쓰기를 받지 않는다.
  thumbs = await createThumbStore(p.storage, { shards: SHARDS });
  for (const [id, value] of pendingShards) thumbs.reload(id, value);
  pendingShards.clear();
  collectGarbage();
  setInterval(collectGarbage, GC_EVERY_MS);
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

// --- sandbox 보드 HTML ---
// sandbox 블록은 assets.bytes를 못 써서 client가 보드 코드 조각을 모두 읽어 board_html로 한 번만 낸다.
// 값이 바뀔 때마다 프레임이 다시 시작하므로 client 수명 동안 한 번만 낸다. 조각 id 목록은 매니페스트의 board.
let boardHtmlStarted = false;
async function publishBoardHtml() {
  if (boardHtmlStarted) return;
  boardHtmlStarted = true;
  let html;
  try {
    html = await loadBoardHtml(boardPartIds(MANIFEST), p.assetBytes);
  } catch (err) {
    console.error('moodboard: 보드 코드를 읽지 못했습니다', err);
    html = errorHtml(err?.message ?? String(err));
  }
  p.publish({ board_html: html });
}

publishBoardHtml();
start().catch((err) => setNotice(err?.message ?? '보드를 읽지 못했어요'));

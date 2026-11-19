// 보드 되돌리기와 다시 하기. sandbox 보드(board/board.js)가 쓰는 순수 도구.
//
// 편집은 client(옆 칸, 붙여넣기, 파일 넣기)와 보드 양쪽에서 일어나고 모두 boards 문서로 모인다.
// 그래서 편집 명령을 따로 적지 않고, 보드가 보는 문서의 지금 보드를 바뀔 때마다 찍어 두었다가
// 그 찍은 모양으로 되돌리는 패치(patches.js)를 만든다.
//
// boardSnapshot(board) -> snapshot|null: 살아 있는 카드와 묶음, 보드의 name·bg. id와 updatedAt은 뺀다.
// restorePatches(board, snapshot) -> patch[]: board(묘비 포함)를 snapshot 모양으로 되돌리는 패치.
//   snapshot에 없는 산 레코드는 묘비(deleted: true)로, 묘비이거나 걷혀 없는 레코드는 되살리거나 다시 넣는다.
// createHistory(limit) -> {observe(snapshot), undo() -> snapshot|null, redo() -> snapshot|null}
//   observe는 직전 기록과 모양이 같으면 무시하고, 다르면 다시 하기 줄을 버리고 쌓는다. 다른 보드면 새로 시작한다.

export const HISTORY_LIMIT = 100;
const BOARD_KEYS = ['name', 'bg'];
const SKIP = new Set(['id', 'updatedAt']);

export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const fieldsOf = (rec) => {
  const out = {};
  for (const k of Object.keys(rec)) if (!SKIP.has(k)) out[k] = rec[k];
  return out;
};

function liveById(list) {
  const out = {};
  for (const r of Array.isArray(list) ? list : []) if (r && typeof r.id === 'string' && !r.deleted) out[r.id] = fieldsOf(r);
  return out;
}

function boardMeta(board) {
  const out = {};
  for (const k of BOARD_KEYS) if (board[k] !== undefined) out[k] = board[k];
  return out;
}

export function boardSnapshot(board) {
  if (!board || typeof board.id !== 'string') return null;
  return structuredClone({ id: board.id, meta: boardMeta(board), cards: liveById(board.cards), groups: liveById(board.groups) });
}

// cur를 want로 만드는 {fields, deleteKeys}. 같으면 null.
function diffFields(cur, want) {
  const fields = {};
  for (const [k, v] of Object.entries(want)) if (stableJson(cur[k]) !== stableJson(v)) fields[k] = structuredClone(v);
  const deleteKeys = Object.keys(cur).filter((k) => !Object.hasOwn(want, k));
  if (!Object.keys(fields).length && !deleteKeys.length) return null;
  return {
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(deleteKeys.length ? { deleteKeys } : {}),
  };
}

export function restorePatches(board, snap) {
  if (!board || !snap || board.id !== snap.id) return [];
  const out = [];
  const meta = diffFields(boardMeta(board), snap.meta);
  if (meta) out.push({ kind: 'board', id: board.id, ...meta });
  for (const [kind, key] of [['group', 'groups'], ['card', 'cards']]) {
    const want = snap[key];
    const have = new Map((Array.isArray(board[key]) ? board[key] : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
    for (const [id, rec] of Object.entries(want)) {
      const cur = have.get(id);
      if (!cur) {
        out.push({ kind, boardId: board.id, id, insert: { ...structuredClone(rec), id } });
        continue;
      }
      const d = diffFields(fieldsOf(cur), rec);
      if (d) out.push({ kind, boardId: board.id, id, ...d });
    }
    for (const [id, cur] of have) {
      if (!cur.deleted && !Object.hasOwn(want, id)) out.push({ kind, boardId: board.id, id, fields: { deleted: true } });
    }
  }
  return out;
}

export function createHistory(limit = HISTORY_LIMIT) {
  let entries = [];
  let at = -1;
  return {
    observe(snap) {
      if (!snap) return;
      const json = stableJson(snap);
      if (at >= 0 && entries[at].snap.id !== snap.id) { entries = []; at = -1; }
      if (at >= 0 && entries[at].json === json) return;
      entries = entries.slice(0, at + 1);
      entries.push({ snap, json });
      if (entries.length > limit) entries.shift();
      at = entries.length - 1;
    },
    undo() {
      if (at <= 0) return null;
      at -= 1;
      return entries[at].snap;
    },
    redo() {
      if (at >= entries.length - 1) return null;
      at += 1;
      return entries[at].snap;
    },
  };
}

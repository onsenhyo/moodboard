// 창 상태 selected와 지우기. client(main.js)와 sandbox 보드(board/board.js)가 함께 쓰는 순수 도구.
//
// selected = {kind:'card'|'group', id} | null. 보드가 고를 때 쓰고, client는 옆 칸을 그릴 때 읽는다.
// normSelected(v) -> selected: 모양이 틀리면 null.
// resolveSelected(selected, board) -> {card} | {group, count} | null: 지금 보드에 살아 있는 것만.
//   접힌 묶음 안의 카드도 돌려준다(옆 칸은 그대로 보인다).
// deleteCardPatches(board, id) -> patch[]: 카드를 묘비(deleted: true)로 만드는 패치(patches.js). 없으면 [].
// deleteGroupPatches(board, id) -> patch[]: 묶음은 묘비, 안의 카드는 groupId 키를 지운다(카드는 남는다).
// staleTombstones(doc, now, minAgeMs) -> card[]: 지운 지 7일(기본) 넘은 카드 묘비.
// collectCard(card, {thumbs, gifs, blobs}) -> Promise[]: 묘비 카드 하나의 썸네일, 움직이는 GIF, 원본을 걷는다.
// viewCenter(view) -> {x, y}: 창 상태 view {cx, cy, scale}의 가운데. 없으면 기본 자리.
// pickBoard(doc, wantedId, currentId) -> board|null: 넣기를 받을 때 고른 보드. 그 사이 지워졌으면 지금 보드.
// orphanMedia({doc, patches, thumbs, gifs, blobKeys, now, minAgeMs}) -> {thumbs, gifs, blobs}: 문서에 카드가 없는
//   썸네일·GIF(카드 id)와 원본(blobs 키). 묘비를 30일 뒤 걷으면(store.js pruneTombstones) 걷기 전에 collectCard를
//   못 돌린 카드의 저장 공간이 남는다. 그것을 한 세션에 한 번 걷는다(main.js reconcileMedia).

export const DEFAULT_CENTER = Object.freeze({ x: 480, y: 300 });

export function normSelected(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.kind !== 'card' && v.kind !== 'group') return null;
  if (typeof v.id !== 'string' || !v.id) return null;
  return { kind: v.kind, id: v.id };
}

const live = (list) => (Array.isArray(list) ? list : []).filter((x) => x && !x.deleted);

export function resolveSelected(selected, board) {
  const s = normSelected(selected);
  if (!s || !board) return null;
  if (s.kind === 'group') {
    const group = live(board.groups).find((g) => g.id === s.id);
    if (!group) return null;
    return { group, count: live(board.cards).filter((c) => c.groupId === group.id).length };
  }
  const card = live(board.cards).find((c) => c.id === s.id);
  return card ? { card } : null;
}

export function deleteCardPatches(board, id) {
  const c = live(board?.cards).find((x) => x.id === id);
  return c ? [{ kind: 'card', boardId: board.id, id, fields: { deleted: true } }] : [];
}

export function deleteGroupPatches(board, id) {
  const g = live(board?.groups).find((x) => x.id === id);
  if (!g) return [];
  const out = live(board.cards)
    .filter((c) => c.groupId === id)
    .map((c) => ({ kind: 'card', boardId: board.id, id: c.id, deleteKeys: ['groupId'] }));
  out.push({ kind: 'group', boardId: board.id, id, fields: { deleted: true } });
  return out;
}

// 지운 지 minAgeMs 넘은 카드 묘비와, 지운 지 minAgeMs 넘은 보드 묘비의 카드 전부.
// client는 이 카드의 썸네일과 원본만 걷어낸다.
// 묘비는 병합에서 뒤집힐 수 있으므로(더 늦은 편집이 이긴다) 지운 바로 뒤에는 걷지 않는다.
export const GC_AGE_MS = 7 * 24 * 3600 * 1000;
export function staleTombstones(doc, now, minAgeMs = GC_AGE_MS) {
  const out = [];
  const old = (x) => now - (x.updatedAt ?? 0) >= minAgeMs;
  for (const b of doc?.boards ?? []) {
    const boardGone = !!b && b.deleted === true && old(b);
    for (const c of b?.cards ?? []) {
      if (c && (boardGone || (c.deleted === true && old(c)))) out.push(c);
    }
  }
  return out;
}

// 묘비 카드 하나의 저장 공간을 걷어낸다. 실패는 삼킨다(다음 세션에 다시 걷는다).
// GIF는 anim이 없어도 지운다(병합으로 필드가 빠졌어도 남은 사본을 걷는다. 없으면 아무 일도 없다).
export function collectCard(card, { thumbs, gifs, blobs } = {}) {
  const jobs = [];
  const run = (fn) => { try { jobs.push(Promise.resolve(fn()).catch(() => {})); } catch { /* 무시 */ } };
  if (card.hasThumb && thumbs) run(() => thumbs.remove(card.id));
  if (gifs) run(() => gifs.remove(card.id));
  if (card.origKey && blobs) run(() => blobs.remove(card.origKey));
  return jobs;
}

export function viewCenter(view) {
  if (view && Number.isFinite(view.cx) && Number.isFinite(view.cy) && view.scale > 0) {
    return { x: view.cx, y: view.cy, scale: view.scale };
  }
  return { ...DEFAULT_CENTER, scale: 1 };
}

export function pickBoard(doc, wantedId, currentId) {
  const boards = live(doc?.boards);
  return boards.find((b) => b.id === wantedId) ?? boards.find((b) => b.id === currentId) ?? null;
}

// 묘비든 지운 보드의 카드든 문서에 남아 있는 카드는 지우지 않는다(묘비는 collectCard가 7일 뒤 걷는다).
// 줄의 패치(아직 저장하지 않은 새 카드)도 쓰는 것으로 친다.
// 썸네일과 GIF는 writtenAt(thumbs, gifs: Map<cardId, writtenAtMs>)이 minAgeMs보다 오래된 것만 고른다.
// 다른 PC는 shard를 먼저 쓰고 boards를 나중에 쓰므로, 막 쓴 사본은 문서에 아직 카드가 없을 수 있다.
// 원본(blobs)은 이 PC의 것이라 시각이 없다. 넣는 중에는 부르지 않는다(main.js). 키는 orig/<cardId>.<ext>.
// doc 모양이 틀리면(읽지 못한 문서) 아무것도 고르지 않는다.
export const ORIG_PREFIX = 'orig/';
export function orphanMedia({ doc, patches = [], thumbs = new Map(), gifs = new Map(), blobKeys = [], now, minAgeMs = GC_AGE_MS } = {}) {
  const none = { thumbs: [], gifs: [], blobs: [] };
  if (!doc || !Array.isArray(doc.boards) || !Number.isFinite(now)) return none;
  const known = new Set();
  for (const b of doc.boards) for (const c of b?.cards ?? []) if (c?.id) known.add(c.id);
  for (const p of patches) if (p?.kind === 'card' && p.id) known.add(p.id);
  const old = (t) => Number.isFinite(t) && now - t >= minAgeMs;
  const pickIds = (m) => [...m].filter(([id, t]) => !known.has(id) && old(t)).map(([id]) => id);
  const cardOfKey = (key) => {
    const name = key.slice(ORIG_PREFIX.length);
    const dot = name.indexOf('.');
    return dot < 0 ? name : name.slice(0, dot);
  };
  return {
    thumbs: pickIds(thumbs),
    gifs: pickIds(gifs),
    blobs: blobKeys.filter((k) => typeof k === 'string' && k.startsWith(ORIG_PREFIX) && k.length > ORIG_PREFIX.length
      && !known.has(cardOfKey(k))),
  };
}

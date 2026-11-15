// 창 상태 selected와 지우기. client(main.js)와 sandbox 보드(board/board.js)가 함께 쓰는 순수 도구.
//
// selected = {kind:'card'|'group', id} | null. 보드가 고를 때 쓰고, client는 옆 칸을 그릴 때 읽는다.
// normSelected(v) -> selected: 모양이 틀리면 null.
// resolveSelected(selected, board) -> {card} | {group, count} | null: 지금 보드에 살아 있는 것만.
//   접힌 묶음 안의 카드도 돌려준다(옆 칸은 그대로 보인다).
// deleteCard(board, id, t) -> 지운 카드 | null: 묘비(deleted: true)로 남긴다.
// deleteGroup(board, id, t) -> 지운 묶음 | null: 묶음은 묘비, 안의 카드는 groupId 키를 지운다(카드는 남는다).
// viewCenter(view) -> {x, y}: 창 상태 view {cx, cy, scale}의 가운데. 없으면 기본 자리.

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

export function deleteCard(board, id, t = Date.now()) {
  const c = live(board?.cards).find((x) => x.id === id);
  if (!c) return null;
  c.deleted = true;
  c.updatedAt = t;
  return c;
}

export function deleteGroup(board, id, t = Date.now()) {
  const g = live(board?.groups).find((x) => x.id === id);
  if (!g) return null;
  for (const c of live(board.cards)) {
    if (c.groupId !== id) continue;
    delete c.groupId;
    c.updatedAt = t;
  }
  g.deleted = true;
  g.updatedAt = t;
  return g;
}

export function viewCenter(view) {
  if (view && Number.isFinite(view.cx) && Number.isFinite(view.cy) && view.scale > 0) {
    return { x: view.cx, y: view.cy, scale: view.scale };
  }
  return { ...DEFAULT_CENTER, scale: 1 };
}

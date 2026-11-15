export const TEXT_DEFAULT_COLOR = '#9e9e9e';

export function newCard(fields) {
  return {
    id: crypto.randomUUID(),
    title: '',
    color: TEXT_DEFAULT_COLOR,
    manual: { x: 0, y: 0, w: 240, h: 180 },
    hasThumb: false,
    includeVideo: false,
    updatedAt: Date.now(),
    ...fields,
  };
}

export function newBoard(name) {
  return { id: crypto.randomUUID(), name, cards: [], groups: [], updatedAt: Date.now() };
}

// --- 묶음 ---

export const GROUP_DEFAULT_NAME = '새 묶음';
export const GROUP_DEFAULT_SIZE = Object.freeze({ w: 400, h: 300 });
export const GROUP_MIN_SIZE = Object.freeze({ w: 160, h: 100 });

export function newGroup({ name, rect }, now = Date.now) {
  return {
    id: crypto.randomUUID(),
    name: name ?? GROUP_DEFAULT_NAME,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    collapsed: false,
    updatedAt: now(),
  };
}

export function liveGroups(board) {
  return (board?.groups ?? []).filter((g) => !g.deleted);
}

// 카드의 groupId가 살아 있는 묶음을 가리킬 때만 그 id. 지운 묶음이나 없는 묶음이면 null.
export function effectiveGroupId(board, card) {
  const id = card?.groupId;
  if (typeof id !== 'string') return null;
  return liveGroups(board).some((g) => g.id === id) ? id : null;
}

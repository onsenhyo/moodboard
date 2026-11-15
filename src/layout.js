import { colorSortKey } from './color.js';

const RESIZE_PX = 12;

// 색 정렬 격자의 칸 크기와 간격. 앱(main.js)과 내보낸 뷰어가 함께 쓴다.
export const SORT_CELL = 200;
export const SORT_GAP = 16;

function compareKeys(a, b) {
  return a.group - b.group || a.hue - b.hue || b.light - a.light;
}

function fitInCell(manual, cell) {
  const w = manual?.w, h = manual?.h;
  if (!(w > 0) || !(h > 0)) return { w: cell, h: cell };
  const k = cell / Math.max(w, h);
  return { w: w * k, h: h * k };
}

export function sortedLayout(cards, { cols, cell, gap }) {
  const keyed = cards.map(card => ({ card, key: colorSortKey(card.color) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  const out = new Map();
  const step = cell + gap;
  let row = 0, col = 0, prevGroup = null;
  for (const { card, key } of keyed) {
    if (prevGroup !== null && key.group !== prevGroup && col !== 0) { row++; col = 0; }
    prevGroup = key.group;
    const { w, h } = fitInCell(card.manual, cell);
    out.set(card.id, { x: col * step + (cell - w) / 2, y: row * step + (cell - h) / 2, w, h });
    if (++col >= cols) { col = 0; row++; }
  }
  return out;
}

export function toScreen(view, rect) {
  return {
    x: (rect.x - view.x) * view.scale,
    y: (rect.y - view.y) * view.scale,
    w: rect.w * view.scale,
    h: rect.h * view.scale,
  };
}

export function toWorld(view, point) {
  return { x: point.x / view.scale + view.x, y: point.y / view.scale + view.y };
}

export function hitTest(cards, rectOf, worldPoint, scale = 1) {
  const { x, y } = worldPoint;
  const zone = RESIZE_PX / scale;
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i];
    const r = rectOf(card);
    if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
    const resize = x >= r.x + r.w - zone && y >= r.y + r.h - zone;
    return { card, zone: resize ? 'resize' : 'body' };
  }
  return null;
}

// 묶음 상자. 제목줄은 rect 위쪽 28 화면 px, 그 왼쪽 24px는 접기 단추다.
export const GROUP_TITLE_PX = 28;
export const GROUP_TOGGLE_PX = 24;
export const MIN_GROUP_W = 160;
export const MIN_GROUP_H = 100;

const liveGroups = (groups) => (groups ?? []).filter(g => g && !g.deleted);

// 위(배열 끝)부터 검사한다. 접힌 묶음은 제목줄만 맞는다.
export function hitTestGroup(groups, worldPoint, scale = 1) {
  const { x, y } = worldPoint;
  const title = GROUP_TITLE_PX / scale, toggle = GROUP_TOGGLE_PX / scale, zone = RESIZE_PX / scale;
  const list = liveGroups(groups);
  for (let i = list.length - 1; i >= 0; i--) {
    const group = list[i];
    const r = group.rect;
    const h = group.collapsed ? Math.min(r.h, title) : r.h;
    if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + h) continue;
    const inTitle = y <= r.y + title;
    if (inTitle && x <= r.x + toggle) return { group, zone: 'toggle' };
    if (!group.collapsed && x >= r.x + r.w - zone && y >= r.y + r.h - zone) return { group, zone: 'resize' };
    return { group, zone: inTitle ? 'title' : 'body' };
  }
  return null;
}

// 카드 중심이 들어가는 묶음 중 위(배열 끝) 것의 id. 접힌 묶음은 뺀다.
export function memberOf(groups, rect) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const list = liveGroups(groups);
  for (let i = list.length - 1; i >= 0; i--) {
    const g = list[i];
    if (g.collapsed) continue;
    const r = g.rect;
    if (cx >= r.x && cy >= r.y && cx <= r.x + r.w && cy <= r.y + r.h) return g.id;
  }
  return null;
}

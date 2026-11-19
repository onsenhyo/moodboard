// 캔버스 포인터 조작의 순수 상태 기계.
//
// reduce(state, event) -> {state, effects[]}
// - event: canvas on_pointer의 arg.event 그대로.
//   {phase:'down'|'move'|'up'|'cancel', pointer_id, x, y, buttons, shift, alt, ctrl, meta, pan?}, x·y는 0~1.
//   down의 pan이 참이면(가운데 단추, 스페이스를 누른 채) 무엇 위에서 눌렀든 화면을 옮긴다.
//   묶음은 제목줄이든 몸통이든 끌면 옮겨지고(안의 카드도 함께), 클릭하면 고른다. 빈 바탕을 끌면 화면을 옮긴다.
// - state = {
//     mode: 'manual'|'sorted',
//     view: {x, y, scale},           // 화면 = (월드 − view.xy) × scale
//     size: {w, h},                  // 그려진 표면의 CSS px
//     cards: Card[],                 // 지금 보드의 카드(그리는 순서). 접힌 묶음의 카드도 든다.
//     groups: Group[],               // 묶음 상자(그리는 순서). deleted인 것은 없는 것으로 본다.
//     sorted: Map<cardId, rect>|null,// 정렬 모드의 배치
//     drag: null | {...},            // 진행 중인 끌기
//   }
// - effects: {type:'select', cardId|null} | {type:'select', cardId:null, groupId}
//          | {type:'moved', cardId, rect} | {type:'membership', cardId, groupId|null}
//          | {type:'group_moved', groupId, rect, cards:[{cardId, rect}]}
//          | {type:'group_resized', groupId, rect} | {type:'group_toggled', groupId}
//          | {type:'notice', text}
//   moved와 group_*는 손을 뗄 때(up) 한 번만 낸다. 끄는 동안의 자리는 state.drag.rect
//   (묶음을 끌 때는 drag.cards도)로 그린다.
//   membership은 카드 moved 바로 뒤에, 놓은 자리의 묶음이 카드의 groupId와 다를 때만 낸다.
//   정렬 모드에서는 묶음을 숨기므로 묶음은 맞지 않는다.

import { toWorld, hitTest, hitTestGroup, memberOf, MIN_GROUP_W, MIN_GROUP_H } from './layout.js';

export const SORT_NOTICE = '내 배치로 바꾸면 옮길 수 있어요';
export const MIN_CARD = 48;
export const CLICK_PX = 4;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

const NEW_W = 240;
const NEW_H = 180;
const JITTER_PX = 40;

export function initialState() {
  return { mode: 'manual', view: { x: 0, y: 0, scale: 1 }, size: { w: 1, h: 1 }, cards: [], groups: [], sorted: null, drag: null };
}

export function rectOf(state, card) {
  if (state.mode === 'sorted') return state.sorted?.get(card.id) ?? card.manual;
  return card.manual;
}

const toPx = (state, e) => ({ x: e.x * state.size.w, y: e.y * state.size.h });

const groupById = (state, id) => (state.groups ?? []).find(g => g && g.id === id && !g.deleted) ?? null;

// 그려지고 맞는 카드. 수동 모드에서는 접힌 묶음의 카드를 뺀다.
export function visibleCards(state) {
  if (state.mode === 'sorted') return state.cards;
  return state.cards.filter(c => !(c.groupId && groupById(state, c.groupId)?.collapsed));
}

const members = (state, groupId) =>
  state.cards.filter(c => c.groupId === groupId).map(c => ({ cardId: c.id, rect: { ...c.manual } }));

function groupDown(state, e, p, hit) {
  const g = hit.group;
  const base = {
    pointerId: e.pointer_id, start: p, moved: false, noticed: false, cardId: null,
    groupId: g.id, origView: { ...state.view }, orig: { ...g.rect }, rect: { ...g.rect },
  };
  if (hit.zone === 'resize') return { ...base, kind: 'group_resize' };
  const cards = members(state, g.id);
  return { ...base, kind: 'group', toggle: hit.zone === 'toggle', origCards: cards, cards };
}

function panDrag(state, e, p) {
  return { kind: 'pan', pointerId: e.pointer_id, start: p, moved: false, noticed: false, cardId: null, orig: null, origView: { ...state.view }, rect: null };
}

function onDown(state, e) {
  const p = toPx(state, e);
  if (e.pan) return { state: { ...state, drag: panDrag(state, e, p) }, effects: [] };
  const world = toWorld(state.view, p);
  const hit = hitTest(visibleCards(state), (c) => rectOf(state, c), world, state.view.scale);
  if (!hit && state.mode !== 'sorted') {
    const g = hitTestGroup(state.groups, world, state.view.scale);
    if (g) return { state: { ...state, drag: groupDown(state, e, p, g) }, effects: [] };
  }
  if (!hit) return { state: { ...state, drag: panDrag(state, e, p) }, effects: [] };
  const kind = state.mode === 'sorted' ? 'blocked' : hit.zone === 'resize' ? 'resize' : 'card';
  const rect = rectOf(state, hit.card);
  const drag = {
    ...panDrag(state, e, p), kind, cardId: hit.card.id, orig: { ...rect }, rect: { ...rect },
  };
  return { state: { ...state, drag }, effects: [] };
}

function onMove(state, e) {
  const d = state.drag;
  const p = toPx(state, e);
  const dx = p.x - d.start.x, dy = p.y - d.start.y;
  const moved = d.moved || Math.hypot(dx, dy) >= CLICK_PX;
  if (!moved) return { state, effects: [] };
  const s = d.origView.scale;
  const effects = [];
  const next = { ...d, moved };
  if (d.kind === 'pan') {
    return { state: { ...state, drag: next, view: { x: d.origView.x - dx / s, y: d.origView.y - dy / s, scale: s } }, effects };
  }
  if (d.kind === 'blocked') {
    if (!d.noticed) { next.noticed = true; effects.push({ type: 'notice', text: SORT_NOTICE }); }
  } else if (d.kind === 'card') {
    next.rect = { ...d.orig, x: d.orig.x + dx / s, y: d.orig.y + dy / s };
  } else if (d.kind === 'resize') {
    next.rect = { ...d.orig, w: Math.max(MIN_CARD, d.orig.w + dx / s), h: Math.max(MIN_CARD, d.orig.h + dy / s) };
  } else if (d.kind === 'group') {
    const mx = dx / s, my = dy / s;
    next.rect = { ...d.orig, x: d.orig.x + mx, y: d.orig.y + my };
    next.cards = d.origCards.map(c => ({ cardId: c.cardId, rect: { ...c.rect, x: c.rect.x + mx, y: c.rect.y + my } }));
  } else if (d.kind === 'group_resize') {
    next.rect = { ...d.orig, w: Math.max(MIN_GROUP_W, d.orig.w + dx / s), h: Math.max(MIN_GROUP_H, d.orig.h + dy / s) };
  }
  return { state: { ...state, drag: next }, effects };
}

function onUp(state, e) {
  let { state: s } = onMove(state, e);
  const d = s.drag;
  s = { ...s, drag: null };
  if (!d.moved) {
    if (d.kind === 'group' && d.toggle) return { state: s, effects: [{ type: 'group_toggled', groupId: d.groupId }] };
    if (d.groupId) return { state: s, effects: [{ type: 'select', cardId: null, groupId: d.groupId }] };
    return { state: s, effects: [{ type: 'select', cardId: d.cardId }] };
  }
  if (d.kind === 'card' || d.kind === 'resize') {
    const effects = [{ type: 'moved', cardId: d.cardId, rect: d.rect }];
    const was = state.cards.find(c => c.id === d.cardId)?.groupId ?? null;
    const now = memberOf(state.groups, d.rect);
    if (now !== was) {
      effects.push({ type: 'membership', cardId: d.cardId, groupId: now });
    }
    return { state: s, effects };
  }
  if (d.kind === 'group') {
    return { state: s, effects: [{ type: 'group_moved', groupId: d.groupId, rect: d.rect, cards: d.cards }] };
  }
  if (d.kind === 'group_resize') {
    return { state: s, effects: [{ type: 'group_resized', groupId: d.groupId, rect: d.rect }] };
  }
  return { state: s, effects: [] };
}

export function reduce(state, e) {
  if (!e || typeof e !== 'object') return { state, effects: [] };
  const d = state.drag;
  switch (e.phase) {
    case 'down':
      if (d) return { state, effects: [] }; // 두 번째 손가락은 무시
      return onDown(state, e);
    case 'move':
      if (!d || e.pointer_id !== d.pointerId) return { state, effects: [] };
      // 누르지 않은 move는 up을 놓친 경우다. 끝난 것으로 본다.
      if (!(e.buttons & 1)) return onUp(state, e);
      return onMove(state, e);
    case 'up':
      if (!d || e.pointer_id !== d.pointerId) return { state, effects: [] };
      return onUp(state, e);
    case 'cancel':
      if (!d || e.pointer_id !== d.pointerId) return { state, effects: [] };
      return { state: { ...state, drag: null, view: d.kind === 'pan' ? d.origView : state.view }, effects: [] };
    default:
      return { state, effects: [] };
  }
}

// 새 카드의 왼쪽 위 월드 좌표. 카드 중심을 화면 가운데 ±40px에 둔다.
export function placeNear(view, size, rnd = Math.random, w = NEW_W, h = NEW_H) {
  const c = toWorld(view, { x: size.w / 2, y: size.h / 2 });
  const j = () => ((rnd() * 2 - 1) * JITTER_PX) / view.scale;
  return { x: c.x - w / 2 + j(), y: c.y - h / 2 + j() };
}

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// 화면 점 anchor를 고정한 채 배율을 factor배 한다.
export function zoomAt(view, factor, anchor) {
  const w = toWorld(view, anchor);
  const scale = clampScale(view.scale * factor);
  return { x: w.x - anchor.x / scale, y: w.y - anchor.y / scale, scale };
}

// 모든 rect가 화면에 들어오는 view. 카드가 없으면 원점·배율 1.
export function fitView(rects, size, padPx = 40) {
  if (!rects.length) return { x: 0, y: 0, scale: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const aw = Math.max(1, size.w - 2 * padPx), ah = Math.max(1, size.h - 2 * padPx);
  const scale = clampScale(Math.min(aw / bw, ah / bh));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x: cx - size.w / 2 / scale, y: cy - size.h / 2 / scale, scale };
}

// 정렬 배치의 열 수. 카드 수에 맞춰 대략 가로가 긴 격자를 만든다.
export function sortCols(n) {
  return Math.max(2, Math.ceil(Math.sqrt(Math.max(1, n) * 1.6)));
}

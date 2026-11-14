import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialState, SORT_NOTICE, MIN_CARD, placeNear, zoomAt, fitView } from '../src/interaction.js';

// 화면 1000×500 px, view 원점·배율 1이면 정규화 좌표 x·y에 1000·500을 곱한 값이 월드 좌표다.
const SIZE = { w: 1000, h: 500 };
const card = (id, x, y, w = 200, h = 100) => ({ id, manual: { x, y, w, h } });

function base(over = {}) {
  return { ...initialState(), size: SIZE, cards: [card('a', 100, 100)], ...over };
}

const ev = (phase, px, py, extra = {}) => ({
  phase, pointer_id: 1, x: px / SIZE.w, y: py / SIZE.h, buttons: phase === 'up' ? 0 : 1,
  shift: false, alt: false, ctrl: false, meta: false, ...extra,
});

function run(state, events) {
  const effects = [];
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

test('수동 모드: 카드 몸통을 끌면 moved', () => {
  const { state, effects } = run(base(), [ev('down', 150, 150), ev('move', 180, 170), ev('move', 200, 190), ev('up', 200, 190)]);
  assert.deepEqual(effects, [{ type: 'moved', cardId: 'a', rect: { x: 150, y: 140, w: 200, h: 100 } }]);
  assert.equal(state.drag, null);
});

test('끄는 동안 drag.rect가 따라오고 effect는 up에서만', () => {
  let s = base();
  s = reduce(s, ev('down', 150, 150)).state;
  const r = reduce(s, ev('move', 170, 150));
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.state.drag.rect, { x: 120, y: 100, w: 200, h: 100 });
});

test('모서리를 끌면 w와 h만 바뀐다', () => {
  // 카드 오른쪽 아래 (300,200), 손잡이 12px 안쪽.
  const { effects } = run(base(), [ev('down', 295, 195), ev('move', 345, 225), ev('up', 345, 225)]);
  assert.deepEqual(effects, [{ type: 'moved', cardId: 'a', rect: { x: 100, y: 100, w: 250, h: 130 } }]);
});

test('크기 조절은 48 아래로 줄지 않는다', () => {
  const { effects } = run(base(), [ev('down', 295, 195), ev('move', 0, 0), ev('up', 0, 0)]);
  assert.deepEqual(effects, [{ type: 'moved', cardId: 'a', rect: { x: 100, y: 100, w: MIN_CARD, h: MIN_CARD } }]);
});

test('빈 곳을 끌면 view만 바뀌고 effect 없음', () => {
  const s0 = base({ view: { x: 0, y: 0, scale: 2 } });
  const { state, effects } = run(s0, [ev('down', 900, 400), ev('move', 880, 390), ev('move', 860, 380), ev('up', 860, 380)]);
  assert.deepEqual(effects, []);
  assert.deepEqual(state.view, { x: 20, y: 10, scale: 2 });
});

test('정렬 모드: 카드를 끌면 좌표 그대로, notice 한 번', () => {
  const sorted = new Map([['a', { x: 0, y: 0, w: 200, h: 200 }]]);
  const s0 = base({ mode: 'sorted', sorted });
  const { state, effects } = run(s0, [ev('down', 50, 50), ev('move', 80, 80), ev('move', 120, 120), ev('up', 120, 120)]);
  assert.deepEqual(effects, [{ type: 'notice', text: '내 배치로 바꾸면 옮길 수 있어요' }]);
  assert.equal(SORT_NOTICE, '내 배치로 바꾸면 옮길 수 있어요');
  assert.deepEqual(state.cards[0].manual, { x: 100, y: 100, w: 200, h: 100 });
  assert.deepEqual(state.view, s0.view);
});

test('클릭(4px 미만)하면 select', () => {
  const { effects } = run(base(), [ev('down', 150, 150), ev('move', 152, 151), ev('up', 153, 151)]);
  assert.deepEqual(effects, [{ type: 'select', cardId: 'a' }]);
});

test('빈 곳 클릭은 select null', () => {
  const { effects } = run(base(), [ev('down', 800, 400), ev('up', 800, 400)]);
  assert.deepEqual(effects, [{ type: 'select', cardId: null }]);
});

test('정렬 모드에서도 클릭은 select', () => {
  const sorted = new Map([['a', { x: 0, y: 0, w: 200, h: 200 }]]);
  const { effects } = run(base({ mode: 'sorted', sorted }), [ev('down', 50, 50), ev('up', 50, 50)]);
  assert.deepEqual(effects, [{ type: 'select', cardId: 'a' }]);
});

test('cancel은 아무것도 남기지 않는다', () => {
  const { state, effects } = run(base(), [ev('down', 150, 150), ev('move', 200, 200), ev('cancel', 200, 200)]);
  assert.deepEqual(effects, []);
  assert.equal(state.drag, null);
});

test('버튼 없는 move와 다른 포인터는 무시', () => {
  const s0 = base();
  const hover = reduce(s0, ev('move', 150, 150, { buttons: 0 }));
  assert.deepEqual(hover.effects, []);
  assert.equal(hover.state.drag, null);
  let s = reduce(s0, ev('down', 150, 150)).state;
  const other = reduce(s, ev('move', 400, 400, { pointer_id: 2 }));
  assert.deepEqual(other.state.drag, s.drag);
});

test('placeNear: 화면 가운데 ±40px, 카드 중심 기준', () => {
  const view = { x: 100, y: 50, scale: 2 };
  // 화면 가운데 (500,250) → 월드 (350,175). 카드 240×180의 중심을 거기에.
  assert.deepEqual(placeNear(view, SIZE, () => 0.5), { x: 230, y: 85 });
  const lo = placeNear(view, SIZE, () => 0);
  assert.deepEqual(lo, { x: 230 - 20, y: 85 - 20 }); // 40px / scale 2 = 20
});

test('zoomAt은 기준점을 고정하고 fitView는 모든 카드를 담는다', () => {
  const v = zoomAt({ x: 0, y: 0, scale: 1 }, 2, { x: 500, y: 250 });
  assert.deepEqual(v, { x: 250, y: 125, scale: 2 });
  const f = fitView([{ x: 0, y: 0, w: 1000, h: 500 }], SIZE, 0);
  assert.deepEqual(f, { x: 0, y: 0, scale: 1 });
});

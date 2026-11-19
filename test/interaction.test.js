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

import { visibleCards } from '../src/interaction.js';

const grp = (id, x, y, w = 400, h = 300, over = {}) => ({ id, name: id, rect: { x, y, w, h }, collapsed: false, updatedAt: 1, ...over });
const member = (id, x, y, groupId) => ({ ...card(id, x, y, 100, 80), groupId });

// 묶음 g: (400,100)~(800,400). 제목줄 y 100~128, toggle x 400~424, resize (788,388)~.
function gbase(over = {}) {
  return base({
    groups: [grp('g', 400, 100)],
    cards: [card('a', 100, 100), member('m1', 450, 200, 'g'), member('m2', 600, 250, 'g')],
    ...over,
  });
}

test('initialState.groups는 빈 배열', () => {
  assert.deepEqual(initialState().groups, []);
});

test('제목줄을 끌면 group_moved, 멤버만 같은 dx·dy', () => {
  const { state, effects } = run(gbase(), [ev('down', 500, 110), ev('move', 530, 120), ev('move', 550, 150), ev('up', 550, 150)]);
  assert.deepEqual(effects, [{
    type: 'group_moved', groupId: 'g', rect: { x: 450, y: 140, w: 400, h: 300 },
    cards: [
      { cardId: 'm1', rect: { x: 500, y: 240, w: 100, h: 80 } },
      { cardId: 'm2', rect: { x: 650, y: 290, w: 100, h: 80 } },
    ],
  }]);
  assert.equal(state.drag, null);
});

test('제목줄 끄는 동안 drag.rect와 drag.cards가 따라온다', () => {
  let s = reduce(gbase(), ev('down', 500, 110)).state;
  const r = reduce(s, ev('move', 520, 110));
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.state.drag.rect, { x: 420, y: 100, w: 400, h: 300 });
  assert.deepEqual(r.state.drag.cards, [
    { cardId: 'm1', rect: { x: 470, y: 200, w: 100, h: 80 } },
    { cardId: 'm2', rect: { x: 620, y: 250, w: 100, h: 80 } },
  ]);
});

test('배율 2에서 제목줄 끌기는 dx/scale만큼', () => {
  const s1 = gbase({ view: { x: 400, y: 100, scale: 2 } });
  // 화면 (200,10) → 월드 (500,105): 제목줄(14 월드 단위)
  const { effects } = run(s1, [ev('down', 200, 10), ev('move', 240, 30), ev('up', 240, 30)]);
  assert.equal(effects[0].type, 'group_moved');
  assert.deepEqual(effects[0].rect, { x: 420, y: 110, w: 400, h: 300 });
});

test('접힌 묶음의 멤버도 함께 옮긴다', () => {
  const s0 = gbase({ groups: [grp('g', 400, 100, 400, 300, { collapsed: true })] });
  const { effects } = run(s0, [ev('down', 500, 110), ev('move', 510, 110), ev('up', 510, 110)]);
  assert.deepEqual(effects[0].cards.map(c => c.cardId), ['m1', 'm2']);
  assert.deepEqual(effects[0].cards[0].rect, { x: 460, y: 200, w: 100, h: 80 });
});

test('모서리를 끌면 group_resized, 최소 160×100', () => {
  const big = run(gbase(), [ev('down', 795, 395), ev('move', 845, 425), ev('up', 845, 425)]);
  assert.deepEqual(big.effects, [{ type: 'group_resized', groupId: 'g', rect: { x: 400, y: 100, w: 450, h: 330 } }]);
  const small = run(gbase(), [ev('down', 795, 395), ev('move', 0, 0), ev('up', 0, 0)]);
  assert.deepEqual(small.effects, [{ type: 'group_resized', groupId: 'g', rect: { x: 400, y: 100, w: 160, h: 100 } }]);
});

test('toggle을 클릭하면 group_toggled', () => {
  const { effects } = run(gbase(), [ev('down', 410, 110), ev('up', 411, 111)]);
  assert.deepEqual(effects, [{ type: 'group_toggled', groupId: 'g' }]);
});

test('묶음 제목줄·몸통 클릭은 select {groupId}', () => {
  const title = run(gbase(), [ev('down', 700, 110), ev('up', 700, 110)]);
  assert.deepEqual(title.effects, [{ type: 'select', cardId: null, groupId: 'g' }]);
  const body = run(gbase(), [ev('down', 700, 350), ev('up', 700, 350)]);
  assert.deepEqual(body.effects, [{ type: 'select', cardId: null, groupId: 'g' }]);
});

test('묶음 몸통을 끌어도 묶음과 안의 카드가 옮겨지고 화면은 그대로다', () => {
  const s0 = gbase();
  const { state, effects } = run(s0, [ev('down', 700, 350), ev('move', 680, 340), ev('up', 680, 340)]);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, 'group_moved');
  assert.deepEqual(effects[0].rect, { x: 380, y: 90, w: 400, h: 300 });
  assert.deepEqual(effects[0].cards.map(c => c.rect.x), [430, 580]);
  assert.deepEqual(state.view, s0.view);
});

test('pan을 붙여 누르면 카드나 묶음 위에서도 화면만 옮긴다', () => {
  const s0 = gbase();
  for (const [x, y] of [[700, 350], [470, 220], [700, 110]]) {
    const down = { ...ev('down', x, y), pan: true };
    const { state, effects } = run(s0, [down, ev('move', x - 20, y - 10), ev('up', x - 20, y - 10)]);
    assert.deepEqual(effects, []);
    assert.deepEqual(state.view, { x: 20, y: 10, scale: 1 });
  }
});

test('묶음 안의 카드가 묶음보다 먼저 맞는다', () => {
  const { effects } = run(gbase(), [ev('down', 470, 220), ev('up', 470, 220)]);
  assert.deepEqual(effects, [{ type: 'select', cardId: 'm1' }]);
});

test('카드를 묶음 안에 놓으면 membership {groupId}', () => {
  // 카드 a (100,100,200,100)를 +400,+100 → (500,200), 중심 (600,250)
  const { effects } = run(gbase(), [ev('down', 150, 150), ev('move', 550, 250), ev('up', 550, 250)]);
  assert.deepEqual(effects, [
    { type: 'moved', cardId: 'a', rect: { x: 500, y: 200, w: 200, h: 100 } },
    { type: 'membership', cardId: 'a', groupId: 'g' },
  ]);
});

test('카드를 묶음 밖에 놓으면 membership {groupId:null}', () => {
  // m1 (450,200,100,80)을 -400 → (50,200), 중심 (100,240)
  const { effects } = run(gbase(), [ev('down', 470, 220), ev('move', 70, 220), ev('up', 70, 220)]);
  assert.deepEqual(effects, [
    { type: 'moved', cardId: 'm1', rect: { x: 50, y: 200, w: 100, h: 80 } },
    { type: 'membership', cardId: 'm1', groupId: null },
  ]);
});

test('같은 묶음 안에서 옮기면 membership 없음', () => {
  const { effects } = run(gbase(), [ev('down', 470, 220), ev('move', 490, 230), ev('up', 490, 230)]);
  assert.deepEqual(effects, [{ type: 'moved', cardId: 'm1', rect: { x: 470, y: 210, w: 100, h: 80 } }]);
});

test('크기 조절로 중심이 묶음에 들어가도 membership', () => {
  // 카드 a (100,100,200,100), 모서리를 +500,+200 → w 700, h 300, 중심 (450,250)
  const { effects } = run(gbase(), [ev('down', 295, 195), ev('move', 795, 395), ev('up', 795, 395)]);
  assert.deepEqual(effects[1], { type: 'membership', cardId: 'a', groupId: 'g' });
});

test('겹친 묶음: 배열 끝 묶음의 id', () => {
  const s0 = gbase({ groups: [grp('g', 400, 100), grp('h', 500, 150, 400, 300)] });
  // 카드 a 중심을 (600,250)으로
  const { effects } = run(s0, [ev('down', 150, 150), ev('move', 550, 250), ev('up', 550, 250)]);
  assert.deepEqual(effects[1], { type: 'membership', cardId: 'a', groupId: 'h' });
  const s1 = gbase({ groups: [grp('h', 500, 150, 400, 300), grp('g', 400, 100)] });
  const r1 = run(s1, [ev('down', 150, 150), ev('move', 550, 250), ev('up', 550, 250)]);
  assert.deepEqual(r1.effects[1], { type: 'membership', cardId: 'a', groupId: 'g' });
});

test('hitTest 접힌 묶음: 안의 카드는 맞지 않고 visibleCards에도 없다', () => {
  const s0 = gbase({ groups: [grp('g', 400, 100, 400, 300, { collapsed: true })] });
  assert.deepEqual(visibleCards(s0).map(c => c.id), ['a']);
  const { effects } = run(s0, [ev('down', 470, 220), ev('up', 470, 220)]);
  assert.deepEqual(effects, [{ type: 'select', cardId: null }]);
  // 펼친 묶음이면 모두 보인다
  assert.deepEqual(visibleCards(gbase()).map(c => c.id), ['a', 'm1', 'm2']);
});

test('visibleCards: 정렬 모드에서는 모두, 지운 묶음은 없는 것으로', () => {
  const collapsed = [grp('g', 400, 100, 400, 300, { collapsed: true })];
  assert.equal(visibleCards(gbase({ groups: collapsed, mode: 'sorted', sorted: new Map() })).length, 3);
  const gone = [grp('g', 400, 100, 400, 300, { collapsed: true, deleted: true })];
  assert.equal(visibleCards(gbase({ groups: gone })).length, 3);
});

test('정렬 중 묶음 끌기: group_moved 없고 notice, 묶음 자리는 맞지 않는다', () => {
  // 정렬 배치에서 m1이 묶음 제목줄 자리(500,110)에 있다.
  const sorted = new Map([['a', { x: 0, y: 0, w: 100, h: 100 }], ['m1', { x: 450, y: 100, w: 100, h: 100 }], ['m2', { x: 600, y: 300, w: 100, h: 100 }]]);
  const s0 = gbase({ mode: 'sorted', sorted });
  const onCard = run(s0, [ev('down', 500, 110), ev('move', 550, 150), ev('up', 550, 150)]);
  assert.deepEqual(onCard.effects, [{ type: 'notice', text: '내 배치로 바꾸면 옮길 수 있어요' }]);
  assert.ok(!onCard.effects.some(e => e.type === 'group_moved'));
  // 카드가 없는 제목줄 자리: 묶음이 숨었으므로 pan
  const onTitle = run(s0, [ev('down', 700, 110), ev('move', 750, 150), ev('up', 750, 150)]);
  assert.deepEqual(onTitle.effects, []);
  assert.deepEqual(onTitle.state.view, { x: -50, y: -40, scale: 1 });
  // 모서리·toggle 클릭도 묶음에 닿지 않는다
  const toggle = run(s0, [ev('down', 410, 110), ev('up', 410, 110)]);
  assert.deepEqual(toggle.effects, [{ type: 'select', cardId: null }]);
});

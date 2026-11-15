import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortedLayout, toScreen, toWorld, hitTest } from '../src/layout.js';

const card = (id, color, w = 100, h = 100) => ({ id, color, manual: { x: 0, y: 0, w, h } });
const opts = { cols: 4, cell: 100, gap: 10 };

test('빨강→초록→파랑, 회색은 다음 줄 첫 칸', () => {
  const cards = ['#ff0000', '#0000ff', '#808080', '#00ff00'].map((c, i) => card('c' + i, c));
  const m = sortedLayout(cards, opts);
  assert.deepEqual(m.get('c0'), { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(m.get('c3'), { x: 110, y: 0, w: 100, h: 100 });
  assert.deepEqual(m.get('c1'), { x: 220, y: 0, w: 100, h: 100 });
  assert.deepEqual(m.get('c2'), { x: 0, y: 110, w: 100, h: 100 });
});

test('줄 바꿈과 같은 hue는 밝은 것 먼저', () => {
  const cards = [card('dark', '#800000'), card('light', '#ff8080'), card('a', '#00ff00'), card('b', '#0000ff'), card('c', '#ff00ff')];
  const m = sortedLayout(cards, { cols: 2, cell: 100, gap: 10 });
  assert.deepEqual([m.get('light').x, m.get('light').y], [0, 0]);
  assert.deepEqual([m.get('dark').x, m.get('dark').y], [110, 0]);
  assert.deepEqual([m.get('a').x, m.get('a').y], [0, 110]);
  assert.deepEqual([m.get('b').x, m.get('b').y], [110, 110]);
  assert.deepEqual([m.get('c').x, m.get('c').y], [0, 220]);
});

test('유채색이 줄 끝을 채우면 무채색은 빈 줄 없이 다음 줄', () => {
  const cards = [card('r', '#ff0000'), card('g', '#00ff00'), card('k', '#000000')];
  const m = sortedLayout(cards, { cols: 2, cell: 100, gap: 10 });
  assert.deepEqual([m.get('k').x, m.get('k').y], [0, 110]);
});

test('무채색만 있으면 첫 줄부터', () => {
  const m = sortedLayout([card('k', '#000000')], opts);
  assert.deepEqual(m.get('k'), { x: 0, y: 0, w: 100, h: 100 });
});

test('비율 유지하고 칸 가운데', () => {
  const m = sortedLayout([card('wide', '#ff0000', 240, 180), card('tall', '#00ff00', 50, 200), card('zero', '#0000ff', 0, 10)], opts);
  assert.deepEqual(m.get('wide'), { x: 0, y: 12.5, w: 100, h: 75 });
  assert.deepEqual(m.get('tall'), { x: 110 + 37.5, y: 0, w: 25, h: 100 });
  assert.deepEqual(m.get('zero'), { x: 220, y: 0, w: 100, h: 100 });
});

test('toScreen/toWorld', () => {
  const view = { x: 100, y: 50, scale: 2 };
  assert.deepEqual(toScreen(view, { x: 110, y: 60, w: 30, h: 40 }), { x: 20, y: 20, w: 60, h: 80 });
  assert.deepEqual(toWorld(view, { x: 20, y: 20 }), { x: 110, y: 60 });
  const p = { x: 7.5, y: -3 };
  assert.deepEqual(toWorld(view, toScreen(view, { ...p, w: 0, h: 0 })), p);
});

test('hitTest: 겹치면 배열 뒤쪽 카드', () => {
  const a = { id: 'a', r: { x: 0, y: 0, w: 100, h: 100 } };
  const b = { id: 'b', r: { x: 50, y: 50, w: 100, h: 100 } };
  const rectOf = c => c.r;
  assert.deepEqual(hitTest([a, b], rectOf, { x: 60, y: 60 }), { card: b, zone: 'body' });
  assert.deepEqual(hitTest([b, a], rectOf, { x: 60, y: 60 }), { card: a, zone: 'body' });
  assert.deepEqual(hitTest([a, b], rectOf, { x: 10, y: 10 }), { card: a, zone: 'body' });
  assert.equal(hitTest([a, b], rectOf, { x: 200, y: 10 }), null);
});

test('hitTest: 오른쪽 아래 12px는 resize, scale로 나눈다', () => {
  const a = { id: 'a', r: { x: 0, y: 0, w: 100, h: 100 } };
  const rectOf = c => c.r;
  assert.equal(hitTest([a], rectOf, { x: 95, y: 95 }).zone, 'resize');
  assert.equal(hitTest([a], rectOf, { x: 100, y: 100 }).zone, 'resize');
  assert.equal(hitTest([a], rectOf, { x: 85, y: 95 }).zone, 'body');
  assert.equal(hitTest([a], rectOf, { x: 95, y: 50 }).zone, 'body');
  // scale 2: 구역은 6 월드 단위
  assert.equal(hitTest([a], rectOf, { x: 93, y: 95 }, 2).zone, 'body');
  assert.equal(hitTest([a], rectOf, { x: 95, y: 95 }, 2).zone, 'resize');
  // scale 0.5: 구역은 24 월드 단위
  assert.equal(hitTest([a], rectOf, { x: 80, y: 80 }, 0.5).zone, 'resize');
});

import { hitTestGroup, memberOf } from '../src/layout.js';

const grp = (id, x, y, w = 400, h = 300, over = {}) => ({ id, name: id, rect: { x, y, w, h }, collapsed: false, updatedAt: 1, ...over });

test('hitTestGroup: toggle, title, resize, body', () => {
  const g = grp('g', 100, 100);
  assert.deepEqual(hitTestGroup([g], { x: 110, y: 110 }), { group: g, zone: 'toggle' });
  assert.deepEqual(hitTestGroup([g], { x: 130, y: 110 }), { group: g, zone: 'title' });
  assert.deepEqual(hitTestGroup([g], { x: 300, y: 127 }), { group: g, zone: 'title' });
  assert.deepEqual(hitTestGroup([g], { x: 300, y: 129 }), { group: g, zone: 'body' });
  assert.deepEqual(hitTestGroup([g], { x: 495, y: 395 }), { group: g, zone: 'resize' });
  assert.equal(hitTestGroup([g], { x: 50, y: 50 }), null);
  assert.equal(hitTestGroup([g], { x: 501, y: 200 }), null);
});

test('hitTestGroup: 구역은 scale로 나눈다', () => {
  const g = grp('g', 0, 0);
  // scale 2: 제목줄 14, toggle 12, resize 6 월드 단위
  assert.equal(hitTestGroup([g], { x: 11, y: 5 }, 2).zone, 'toggle');
  assert.equal(hitTestGroup([g], { x: 13, y: 5 }, 2).zone, 'title');
  assert.equal(hitTestGroup([g], { x: 50, y: 15 }, 2).zone, 'body');
  assert.equal(hitTestGroup([g], { x: 393, y: 295 }, 2).zone, 'body');
  assert.equal(hitTestGroup([g], { x: 395, y: 295 }, 2).zone, 'resize');
  // scale 0.5: 제목줄 56
  assert.equal(hitTestGroup([g], { x: 100, y: 50 }, 0.5).zone, 'title');
});

test('hitTestGroup: 겹치면 배열 끝, 접힌 묶음은 제목줄만, 지운 묶음은 없다', () => {
  const a = grp('a', 0, 0), b = grp('b', 200, 200);
  assert.equal(hitTestGroup([a, b], { x: 300, y: 250 }).group, b);
  assert.equal(hitTestGroup([b, a], { x: 300, y: 250 }).group, a);
  const c = grp('c', 0, 0, 400, 300, { collapsed: true });
  assert.equal(hitTestGroup([c], { x: 100, y: 10 }).zone, 'title');
  assert.equal(hitTestGroup([c], { x: 10, y: 10 }).zone, 'toggle');
  assert.equal(hitTestGroup([c], { x: 100, y: 100 }), null);
  assert.equal(hitTestGroup([c], { x: 395, y: 295 }), null);
  const d = grp('d', 0, 0, 400, 300, { deleted: true });
  assert.equal(hitTestGroup([d], { x: 100, y: 100 }), null);
  assert.equal(hitTestGroup([a, d], { x: 100, y: 100 }).group, a);
});

test('memberOf: 카드 중심, 배열 끝, 접힌·지운 묶음 제외', () => {
  const a = grp('a', 0, 0), b = grp('b', 200, 200);
  assert.equal(memberOf([a, b], { x: 50, y: 50, w: 100, h: 100 }), 'a');
  assert.equal(memberOf([a, b], { x: 250, y: 220, w: 100, h: 100 }), 'b');
  assert.equal(memberOf([b, a], { x: 250, y: 220, w: 100, h: 100 }), 'a');
  // 걸쳐 있어도 중심이 밖이면 null
  assert.equal(memberOf([a], { x: 350, y: 0, w: 200, h: 100 }), null);
  assert.equal(memberOf([], { x: 0, y: 0, w: 10, h: 10 }), null);
  assert.equal(memberOf([a, { ...b, collapsed: true }], { x: 250, y: 220, w: 100, h: 100 }), 'a');
  assert.equal(memberOf([a, { ...b, deleted: true }], { x: 250, y: 220, w: 100, h: 100 }), 'a');
});

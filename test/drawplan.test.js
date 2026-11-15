import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawList, cardChrome, groupBox, groupLabel, groupMembers, groupToggle, CAPTION_WORDS, captionFor } from '../src/drawplan.js';
import { hitTestGroup, toWorld, GROUP_TOGGLE_PX, GROUP_TITLE_PX } from '../src/layout.js';
import { THEMES } from '../src/theme.js';

const rect = (x, y, w = 100, h = 80) => ({ x, y, w, h });
const card = (id, extra = {}) => ({ id, kind: 'image', manual: rect(0, 0), hasThumb: true, ...extra });

const scene = (over = {}) => ({
  mode: 'manual',
  cards: [card('a'), card('b', { groupId: 'g1' }), card('c', { groupId: 'g2' })],
  groups: [
    { id: 'g1', name: '하나', rect: rect(0, 0, 400, 300), collapsed: false },
    { id: 'g2', name: '둘', rect: rect(500, 0, 400, 300), collapsed: true },
    { id: 'g3', name: '지움', rect: rect(0, 500), collapsed: false, deleted: true },
  ],
  selectedId: null,
  selectedGroupId: null,
  ...over,
});

test('drawList: 바탕 → 묶음 → 보이는 카드 순서이고, 접힌 묶음의 카드와 지운 묶음은 빠진다', () => {
  assert.deepEqual(drawList(scene()), [
    { kind: 'background' },
    { kind: 'group', id: 'g1' },
    { kind: 'group', id: 'g2' },
    { kind: 'card', id: 'a' },
    { kind: 'card', id: 'b' },
  ]);
});

test('drawList: 정렬 모드에서는 묶음을 그리지 않고 모든 카드를 그린다', () => {
  const l = drawList(scene({ mode: 'sorted', selectedGroupId: 'g1' }));
  assert.deepEqual(l.map((x) => x.kind), ['background', 'card', 'card', 'card']);
});

test('drawList: 선택선은 맨 끝에 그린다(카드 또는 묶음)', () => {
  assert.deepEqual(drawList(scene({ selectedId: 'b' })).at(-1), { kind: 'selection', target: 'card', id: 'b' });
  assert.deepEqual(drawList(scene({ selectedGroupId: 'g2' })).at(-1), { kind: 'selection', target: 'group', id: 'g2' });
  // 숨은 카드나 지운 묶음은 선택선이 없다
  assert.equal(drawList(scene({ selectedId: 'c' })).at(-1).kind, 'card');
  assert.equal(drawList(scene({ selectedGroupId: 'g3' })).at(-1).kind, 'card');
});

test('captionFor: image는 캡션이 없고 youtube·pinterest·video만 종류 이름', () => {
  assert.equal(captionFor({ kind: 'image' }), null);
  assert.equal(captionFor({ kind: 'youtube' }), 'youtube');
  assert.equal(captionFor({ kind: 'pinterest' }), 'pinterest');
  assert.equal(captionFor({ kind: 'video' }), 'video');
  assert.equal(captionFor({ kind: 'link' }), null);
  assert.equal(captionFor({ kind: 'text' }), null);
  assert.equal(captionFor(null), null);
  assert.deepEqual(Object.keys(CAPTION_WORDS).sort(), ['pinterest', 'video', 'youtube']);
});

test('cardChrome: 라이트 image 카드는 사방 4px 매트이고 캡션이 없다, 그림자 2겹', () => {
  const s = rect(10, 20, 200, 150);
  const c = cardChrome(THEMES.light, card('a', { kind: 'image' }), s, 1);
  assert.deepEqual(c.outer, s);
  assert.deepEqual(c.inner, { x: 14, y: 24, w: 192, h: 142 });
  assert.equal(c.matBg, '#ffffff');
  assert.equal(c.caption, null);
  assert.equal(c.shadows.length, 2);
  assert.deepEqual(c.badgeAt, { x: 20, y: 30 });
});

test('cardChrome: 라이트 youtube·pinterest·video 카드는 아래 20px에 캡션', () => {
  const s = rect(10, 20, 200, 150);
  for (const kind of ['youtube', 'pinterest', 'video']) {
    const c = cardChrome(THEMES.light, card('a', { kind }), s, 1);
    assert.deepEqual(c.inner, { x: 14, y: 24, w: 192, h: 126 }, kind);
    assert.deepEqual(c.caption, { text: kind, x: 16, y: 165 }, kind);
  }
});

test('cardChrome: 매트는 배율을 따르고, 아랫단이 얇으면 캡션을 쓰지 않는다', () => {
  const c = cardChrome(THEMES.light, card('a'), rect(0, 0, 100, 75), 0.5);
  assert.deepEqual(c.inner, { x: 2, y: 2, w: 96, h: 71 });
  assert.equal(c.caption, null);
  const y = cardChrome(THEMES.light, card('a', { kind: 'youtube' }), rect(0, 0, 100, 75), 0.5);
  assert.deepEqual(y.inner, { x: 2, y: 2, w: 96, h: 63 });
  assert.equal(y.caption, null, '10px 아랫단에는 글자를 쓰지 않는다');
});

test('cardChrome: 링크 카드는 캡션이 없다', () => {
  const link = cardChrome(THEMES.light, card('a', { kind: 'link' }), rect(0, 0, 200, 150));
  assert.equal(link.caption, null);
  assert.ok(link.matBg);
});

test('cardChrome: 다크 사진 카드는 꽉 차고 그림자 1겹', () => {
  const s = rect(10, 20, 200, 150);
  const c = cardChrome(THEMES.dark, card('a'), s);
  assert.deepEqual(c.inner, s);
  assert.equal(c.matBg, null);
  assert.equal(c.caption, null);
  assert.equal(c.shadows.length, 1);
});

test('cardChrome: 썸네일 없는 카드는 매트가 없다', () => {
  const s = rect(0, 0, 200, 150);
  const c = cardChrome(THEMES.light, card('t', { kind: 'text', hasThumb: false }), s);
  assert.deepEqual(c.inner, s);
  assert.equal(c.matBg, null);
});

test('groupBox: 접힌 묶음은 28px 제목줄만', () => {
  const s = rect(0, 0, 300, 200);
  assert.deepEqual(groupBox({ collapsed: false }, s), s);
  assert.deepEqual(groupBox({ collapsed: true }, s), { x: 0, y: 0, w: 300, h: 28 });
});

test('groupLabel: 펼침은 이름만(상자 위), 접힘은 이름 · N장, 대문자로 바꾸지 않는다', () => {
  assert.equal(groupLabel(THEMES.dark, { name: 'Warm', collapsed: false }, 3), 'Warm');
  assert.equal(groupLabel(THEMES.dark, { name: 'Warm', collapsed: true }, 3), 'Warm · 3장');
  assert.equal(groupLabel(THEMES.light, { name: 'Warm', collapsed: true }, 0), 'Warm · 0장');
});

test('groupToggle: 글리프는 상자 안 왼쪽 위 24×28 접기 영역 가운데', () => {
  const s = rect(50, 70, 300, 200);
  const open = groupToggle({ collapsed: false }, s);
  assert.equal(open.glyph, '▾');
  assert.deepEqual(open.zone, { x: 50, y: 70, w: GROUP_TOGGLE_PX, h: GROUP_TITLE_PX });
  assert.equal(open.cx, 50 + 12);
  assert.equal(open.cy, 70 + 14);
  const shut = groupToggle({ collapsed: true }, groupBox({ collapsed: true }, s));
  assert.equal(shut.glyph, '▸');
  assert.deepEqual(shut.zone, open.zone);
});

test('groupToggle: 글리프 중심을 누르면 interaction의 접기 판정에 맞는다', () => {
  for (const scale of [0.5, 1, 2]) {
    for (const collapsed of [false, true]) {
      const view = { x: -10, y: -20, scale };
      const g = { id: 'g', rect: rect(100, 100, 400, 300), collapsed };
      const s = { x: (100 - view.x) * scale, y: (100 - view.y) * scale, w: 400 * scale, h: 300 * scale };
      const tg = groupToggle(g, groupBox(g, s));
      const hit = hitTestGroup([g], toWorld(view, { x: tg.cx, y: tg.cy }), scale);
      assert.equal(hit?.zone, 'toggle', `scale ${scale} collapsed ${collapsed}`);
    }
  }
});

test('groupMembers: groupId가 같은 살아 있는 카드', () => {
  const cards = [card('a', { groupId: 'g' }), card('b'), card('c', { groupId: 'g', deleted: true })];
  assert.deepEqual(groupMembers(cards, 'g').map((c) => c.id), ['a']);
});

test('render.js에 둥근 모서리 코드가 없다', () => {
  const src = readFileSync(new URL('../src/render.js', import.meta.url), 'utf8');
  assert.ok(!/roundRect|arcTo/.test(src));
});

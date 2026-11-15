import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawList, cardChrome, groupBox, groupLabel, groupMembers, CAPTION_WORDS } from '../src/drawplan.js';
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

test('cardChrome: 라이트 사진 카드는 흰 매트(6, 아래 22)와 종류 캡션, 그림자 2겹', () => {
  const s = rect(10, 20, 200, 150);
  const c = cardChrome(THEMES.light, card('a', { kind: 'youtube' }), s, 1);
  assert.deepEqual(c.outer, s);
  assert.deepEqual(c.inner, { x: 16, y: 26, w: 188, h: 122 });
  assert.equal(c.matBg, '#ffffff');
  assert.equal(c.caption.text, 'youtube');
  assert.equal(c.caption.y, 20 + 150 - 5);
  assert.equal(c.shadows.length, 2);
  assert.deepEqual(c.badgeAt, { x: 22, y: 32 });
});

test('cardChrome: 매트는 배율을 따르고, 아랫단이 얇으면 캡션을 뺀다', () => {
  const c = cardChrome(THEMES.light, card('a'), rect(0, 0, 100, 75), 0.5);
  assert.deepEqual(c.inner, { x: 3, y: 3, w: 94, h: 61 });
  assert.equal(c.caption, null);
});

test('cardChrome: 캡션 단어는 youtube/pinterest/image/video뿐이다', () => {
  assert.deepEqual(Object.keys(CAPTION_WORDS).sort(), ['image', 'pinterest', 'video', 'youtube']);
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

test('groupLabel: 펼침은 ▾ 이름, 접힘은 ▸ 이름 · N장, 라이트는 대문자', () => {
  assert.equal(groupLabel(THEMES.dark, { name: 'Warm', collapsed: false }, 3), '▾ Warm');
  assert.equal(groupLabel(THEMES.dark, { name: 'Warm', collapsed: true }, 3), '▸ Warm · 3장');
  assert.equal(groupLabel(THEMES.light, { name: 'Warm', collapsed: true }, 0), '▸ WARM · 0장');
});

test('groupMembers: groupId가 같은 살아 있는 카드', () => {
  const cards = [card('a', { groupId: 'g' }), card('b'), card('c', { groupId: 'g', deleted: true })];
  assert.deepEqual(groupMembers(cards, 'g').map((c) => c.id), ['a']);
});

test('render.js에 둥근 모서리 코드가 없다', () => {
  const src = readFileSync(new URL('../src/render.js', import.meta.url), 'utf8');
  assert.ok(!/roundRect|arcTo/.test(src));
});

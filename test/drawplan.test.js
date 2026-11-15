import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawList, cardChrome, groupBox, groupLabel, groupMembers, groupToggle, CAPTION_WORDS, captionFor, footText, wrapLines, fitLine, scaleFont } from '../src/drawplan.js';
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

// 글자마다 폭 10인 measure
const m10 = (t) => [...t].length * 10;

test('captionFor: label이 종류 이름보다 앞서고, label 없는 image는 캡션이 없다', () => {
  assert.equal(captionFor({ kind: 'youtube', label: '참고 영상' }), '참고 영상');
  assert.equal(captionFor({ kind: 'image', label: ' 바다 ' }), '바다');
  assert.equal(captionFor({ kind: 'image' }), null);
  assert.equal(captionFor({ kind: 'image', label: '   ' }), null, '공백뿐인 label은 없는 것');
  assert.equal(captionFor({ kind: 'video', label: '' }), 'video');
});

test('footText: 라이트는 캡션이나 메모가 있으면, 다크는 label이나 메모가 있을 때만', () => {
  const L = THEMES.light, D = THEMES.dark;
  assert.equal(footText(L, { kind: 'image' }), null);
  assert.deepEqual(footText(L, { kind: 'youtube' }), { caption: 'youtube', label: false, memo: null });
  assert.deepEqual(footText(L, { kind: 'image', memo: '메모' }), { caption: null, label: false, memo: '메모' });
  assert.deepEqual(footText(L, { kind: 'image', label: '이름', memo: '메모' }), { caption: '이름', label: true, memo: '메모' });
  assert.equal(footText(D, { kind: 'youtube' }), null, '다크는 종류 이름만으로 띠를 만들지 않는다');
  assert.deepEqual(footText(D, { kind: 'youtube', memo: 'm' }), { caption: 'youtube', label: false, memo: 'm' });
  assert.deepEqual(footText(D, { kind: 'image', label: 'a' }), { caption: 'a', label: true, memo: null });
});

test('wrapLines: 맞으면 한 줄, 넘치면 글자 단위로 나누고 2줄을 넘으면 마지막 줄 끝에 …', () => {
  assert.deepEqual(wrapLines('', 50, 2, m10), []);
  assert.deepEqual(wrapLines(null, 50, 2, m10), []);
  assert.deepEqual(wrapLines('abc', 50, 2, m10), ['abc']);
  assert.deepEqual(wrapLines('abcdefg', 50, 2, m10), ['abcde', 'fg']);
  const cut = wrapLines('abcdefghijklmno', 50, 2, m10);
  assert.deepEqual(cut, ['abcde', 'fghi…']);
  for (const l of cut) assert.ok(m10(l) <= 50, l);
  assert.deepEqual(wrapLines('가나다라마바사', 30, 2, m10), ['가나다', '라마…']);
});

test('wrapLines: 줄바꿈을 지키고, 줄이 남으면 짧은 마지막 줄에도 …', () => {
  assert.deepEqual(wrapLines('ab\ncd', 50, 2, m10), ['ab', 'cd']);
  assert.deepEqual(wrapLines('ab\ncd\nef', 50, 2, m10), ['ab', 'cd…']);
  assert.deepEqual(wrapLines('ab\r\ncd', 50, 2, m10), ['ab', 'cd']);
  assert.deepEqual(wrapLines('a\nb', 50, 1, m10), ['a…']);
  assert.deepEqual(wrapLines('abc', 0, 2, m10), []);
});

test('fitLine: 넘치면 …로 자르고, 아주 좁으면 …만', () => {
  assert.equal(fitLine('abc', 30, m10), 'abc');
  assert.equal(fitLine('abcdef', 30, m10), 'ab…');
  assert.equal(fitLine('abc', 5, m10), '…');
  assert.equal(scaleFont('600 11px X', 2), '600 22px X');
});

test('cardChrome: 라이트 label과 메모가 있으면 매트 아랫단이 캡션 + 메모 줄만큼 커진다', () => {
  const s = rect(0, 0, 200, 200);
  const c = cardChrome(THEMES.light, card('a', { label: '이름', memo: 'x'.repeat(40) }), s, 1, m10);
  // 글 폭 = 200 - 6*2 = 188 → 18자씩 2줄(…). 아랫단 3 + 14 + 13*2 + 3 = 46
  assert.equal(c.inner.h, 200 - 4 - 46);
  assert.deepEqual(c.lines.map((l) => l.text), ['이름', 'x'.repeat(18), 'x'.repeat(17) + '…']);
  assert.equal(c.lines[0].color, THEMES.light.labelColor);
  assert.equal(c.lines[1].color, THEMES.light.memoColor);
  assert.deepEqual(c.foot, { x: 0, y: 154, w: 200, h: 46, bg: null });
  // 메모만 있는 image: 캡션 줄 없이 메모 한 줄
  const m = cardChrome(THEMES.light, card('b', { memo: '짧다' }), s, 1, m10);
  assert.equal(m.inner.h, 200 - 4 - (3 + 13 + 3));
  assert.deepEqual(m.lines.map((l) => l.text), ['짧다']);
});

test('cardChrome: 다크 label·메모는 사진 아래 카드 안 띠(stripBg)에 쓴다', () => {
  const s = rect(10, 20, 200, 150);
  const c = cardChrome(THEMES.dark, card('a', { kind: 'youtube', label: '참고', memo: '메모' }), s, 1, m10);
  const fh = 3 + 14 + 13 + 3;
  assert.deepEqual(c.inner, { x: 10, y: 20, w: 200, h: 150 - fh });
  assert.deepEqual(c.foot, { x: 10, y: 20 + 150 - fh, w: 200, h: fh, bg: THEMES.dark.stripBg });
  assert.equal(c.lines[0].x, 18);
  assert.deepEqual(c.lines.map((l) => l.text), ['참고', '메모']);
});

test('cardChrome: 아랫단은 카드 높이의 60%를 넘지 않고 줄은 배율을 따른다', () => {
  const c = cardChrome(THEMES.dark, card('a', { label: 'a', memo: 'b\nc' }), rect(0, 0, 200, 50), 1, m10);
  assert.equal(c.foot.h, 30);
  assert.equal(c.inner.h, 20);
  const z = cardChrome(THEMES.light, card('a', { label: 'a' }), rect(0, 0, 400, 400), 2, m10);
  assert.equal(z.inner.h, 400 - 8 - 40);
  assert.equal(z.lines[0].font, scaleFont(THEMES.light.captionFont, 2));
});

test('cardChrome: 라이트 image 카드는 사방 4px 매트이고 캡션이 없다, 그림자 2겹', () => {
  const s = rect(10, 20, 200, 150);
  const c = cardChrome(THEMES.light, card('a', { kind: 'image' }), s, 1);
  assert.deepEqual(c.outer, s);
  assert.deepEqual(c.inner, { x: 14, y: 24, w: 192, h: 142 });
  assert.equal(c.matBg, '#ffffff');
  assert.equal(c.foot, null);
  assert.deepEqual(c.lines, []);
  assert.equal(c.shadows.length, 2);
  assert.deepEqual(c.badgeAt, { x: 20, y: 30 });
});

test('cardChrome: 라이트 youtube·pinterest·video 카드는 아래 20px에 캡션', () => {
  const s = rect(10, 20, 200, 150);
  for (const kind of ['youtube', 'pinterest', 'video']) {
    const c = cardChrome(THEMES.light, card('a', { kind }), s, 1);
    assert.deepEqual(c.inner, { x: 14, y: 24, w: 192, h: 126 }, kind);
    assert.equal(c.lines.length, 1, kind);
    assert.deepEqual({ ...c.lines[0], font: undefined }, { text: kind, x: 16, y: 160, font: undefined, color: THEMES.light.captionColor }, kind);
  }
});

test('cardChrome: 매트는 배율을 따르고, 아랫단이 얇으면 캡션을 쓰지 않는다', () => {
  const c = cardChrome(THEMES.light, card('a'), rect(0, 0, 100, 75), 0.5);
  assert.deepEqual(c.inner, { x: 2, y: 2, w: 96, h: 71 });
  assert.deepEqual(c.lines, []);
  const y = cardChrome(THEMES.light, card('a', { kind: 'youtube' }), rect(0, 0, 100, 75), 0.5);
  assert.deepEqual(y.inner, { x: 2, y: 2, w: 96, h: 63 });
  assert.deepEqual(y.lines, [], '10px 아랫단에는 글자를 쓰지 않는다');
});

test('cardChrome: 링크 카드는 캡션이 없다', () => {
  const link = cardChrome(THEMES.light, card('a', { kind: 'link' }), rect(0, 0, 200, 150));
  assert.deepEqual(link.lines, []);
  assert.ok(link.matBg);
});

test('cardChrome: 다크 사진 카드는 꽉 차고 그림자 1겹', () => {
  const s = rect(10, 20, 200, 150);
  const c = cardChrome(THEMES.dark, card('a'), s);
  assert.deepEqual(c.inner, s);
  assert.equal(c.matBg, null);
  assert.equal(c.foot, null);
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

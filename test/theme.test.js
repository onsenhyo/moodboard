import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, themeName, groupDotColor } from '../src/theme.js';
import { colorSortKey } from '../src/color.js';

const KEYS = ['bg', 'grid', 'mat', 'shadow', 'captionFont', 'captionColor', 'badgeBg', 'badgeInk',
  'textBg', 'textInk', 'textFont', 'textAccentBar', 'groupFill', 'groupLine', 'groupLabelFont',
  'groupLabelInk', 'groupLabelUpper', 'groupDot', 'selectLine'];

test('두 테마 모두 브리프의 키를 가진다', () => {
  for (const name of ['light', 'dark']) {
    for (const k of KEYS) assert.ok(k in THEMES[name], `${name}.${k}`);
  }
});

test('바탕색', () => {
  assert.equal(THEMES.light.bg, '#f4f1ec');
  assert.equal(THEMES.dark.bg, '#141416');
});

test('다크는 18px 점 격자, 라이트는 격자 없음', () => {
  assert.deepEqual(THEMES.dark.grid, { step: 18, dot: '#2a2a2e', r: 1 });
  assert.equal(THEMES.light.grid, null);
});

test('라이트 매트는 6px, 아래 22px. 다크는 매트 없음', () => {
  assert.deepEqual(THEMES.light.mat, { pad: 6, bottom: 22 });
  assert.equal(THEMES.dark.mat, null);
});

test('그림자: 라이트 2겹, 다크 1겹', () => {
  assert.deepEqual(THEMES.light.shadow, [
    { blur: 2, y: 1, color: 'rgba(0,0,0,.08)' },
    { blur: 20, y: 8, color: 'rgba(0,0,0,.08)' },
  ]);
  assert.deepEqual(THEMES.dark.shadow, [{ blur: 30, y: 10, color: 'rgba(0,0,0,.6)' }]);
});

test('불리언 토큰', () => {
  assert.equal(THEMES.light.groupLabelUpper, true);
  assert.equal(THEMES.dark.groupLabelUpper, false);
  assert.equal(THEMES.light.groupDot, false);
  assert.equal(THEMES.dark.groupDot, true);
  assert.equal(THEMES.light.textAccentBar, false);
  assert.equal(THEMES.dark.textAccentBar, true);
});

test('글꼴은 px 크기와 대체 글꼴 목록을 가진다', () => {
  assert.match(THEMES.light.textFont, /italic.*13px.*Georgia, 'Times New Roman', serif/);
  assert.match(THEMES.dark.textFont, /13px.*system-ui, -apple-system, sans-serif/);
  assert.match(THEMES.light.groupLabelFont, /11px.*Georgia/);
  assert.match(THEMES.dark.groupLabelFont, /11px.*system-ui/);
  assert.match(THEMES.light.captionFont, /11px.*Georgia/);
});

test('스펙 표의 색', () => {
  assert.equal(THEMES.light.captionColor, '#666');
  assert.equal(THEMES.light.badgeInk, '#555');
  assert.equal(THEMES.dark.badgeInk, '#eee');
  assert.equal(THEMES.light.textBg, '#fffdf7');
  assert.equal(THEMES.light.textInk, '#3a352d');
  assert.equal(THEMES.dark.textBg, '#232327');
  assert.equal(THEMES.dark.textInk, '#e9e6df');
  assert.equal(THEMES.light.groupLine, '#cfc7ba');
  assert.equal(THEMES.light.groupLabelInk, '#8a7f6e');
  assert.equal(THEMES.dark.groupLabelInk, '#bdbdc4');
  assert.equal(THEMES.light.selectLine, '#3a352d');
  assert.equal(THEMES.dark.selectLine, '#e9e6df');
});

test('렌더러 동등성용 추가 키', () => {
  for (const name of ['light', 'dark']) {
    const t = THEMES[name];
    for (const k of ['placeholderBg', 'placeholderInk', 'loadingBg', 'linkBg', 'linkInk', 'linkMuted',
      'noteBg', 'noteInk', 'uiFont', 'groupDotFallback']) assert.ok(k in t, `${name}.${k}`);
  }
});

test('themeName', () => {
  assert.equal(themeName(true), 'dark');
  assert.equal(themeName(false), 'light');
});

test('groupDotColor: 빨강·주황 카드는 hue 0~40°', () => {
  const hex = groupDotColor([{ color: '#e6241e' }, { color: '#e67e22' }, { color: '#f39c12' }]);
  assert.match(hex, /^#[0-9a-f]{6}$/);
  const { hue, group } = colorSortKey(hex);
  assert.equal(group, 0);
  assert.ok(hue >= 0 && hue <= 40, `hue ${hue}`);
});

test('groupDotColor: 회색만 있으면 #9e9e9e', () => {
  assert.equal(groupDotColor([{ color: '#808080' }, { color: '#cccccc' }]), '#9e9e9e');
});

test('groupDotColor: 빈 배열은 #9e9e9e', () => {
  assert.equal(groupDotColor([]), '#9e9e9e');
});

test('groupDotColor: 짝수 개면 아래쪽 가운데 hue, HSL(h,.55,.55)', () => {
  // hue 120(초록), 240(파랑) -> 120 선택 -> hsl(120,.55,.55) = #4dcb4d
  assert.equal(groupDotColor([{ color: '#0000ff' }, { color: '#00ff00' }]), '#4dcb4d');
  // 회색은 무시한다
  assert.equal(groupDotColor([{ color: '#00ff00' }, { color: '#808080' }]), '#4dcb4d');
});

test('groupDotColor: 색이 없는 카드는 건너뛴다', () => {
  assert.equal(groupDotColor([{}, { color: null }]), '#9e9e9e');
});

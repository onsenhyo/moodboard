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

test('바탕색은 쉘 surface-solid', () => {
  assert.equal(THEMES.light.bg, '#f7f3f7');
  assert.equal(THEMES.dark.bg, '#2a2230');
});

test('두 테마 모두 20px 점 격자를 경계선 색으로', () => {
  assert.deepEqual(THEMES.light.grid, { step: 20, dot: 'rgba(73,57,89,.14)', r: 1 });
  assert.deepEqual(THEMES.dark.grid, { step: 20, dot: 'rgba(230,214,240,.13)', r: 1 });
});

test('라이트 매트는 4px, 아래 4px. 다크는 매트 없음', () => {
  assert.deepEqual(THEMES.light.mat, { pad: 4, bottom: 4 });
  assert.equal(THEMES.dark.mat, null);
});

test('그림자: 라이트 2겹, 다크 1겹', () => {
  assert.deepEqual(THEMES.light.shadow, [
    { blur: 12, y: 4, color: 'rgba(48,42,54,.10)' },
    { blur: 2, y: 1, color: 'rgba(48,42,54,.06)' },
  ]);
  assert.deepEqual(THEMES.dark.shadow, [{ blur: 16, y: 6, color: 'rgba(0,0,0,.35)' }]);
});

test('불리언 토큰: 두 테마 모두 대문자 없음, 점 있음, 색 띠 있음', () => {
  for (const name of ['light', 'dark']) {
    assert.equal(THEMES[name].groupLabelUpper, false);
    assert.equal(THEMES[name].groupDot, true);
    assert.equal(THEMES[name].textAccentBar, true);
  }
});

test('글꼴은 쉘 UI 글꼴 목록이고 Georgia나 serif 글꼴이 없다', () => {
  for (const name of ['light', 'dark']) {
    for (const [k, v] of Object.entries(THEMES[name])) {
      if (typeof v !== 'string') continue;
      assert.ok(!v.includes('Georgia'), `${name}.${k}`);
      assert.ok(!/(^|[ ,])serif/.test(v), `${name}.${k}`);
    }
    assert.match(THEMES[name].textFont, /13px 'DM Sans Variable', 'Pretendard Variable'.*sans-serif/);
    assert.match(THEMES[name].groupLabelFont, /^600 12px 'DM Sans Variable'/);
  }
});

test('쉘 팔레트의 색', () => {
  assert.equal(THEMES.light.textBg, '#ffffff');
  assert.equal(THEMES.light.textBorder, 'rgba(73,57,89,.14)');
  assert.equal(THEMES.light.textInk, '#302a36');
  assert.equal(THEMES.dark.textBg, '#342b3b');
  assert.equal(THEMES.dark.textInk, '#ece3f2');
  assert.equal(THEMES.light.groupFill, 'rgba(255,255,255,.36)');
  assert.equal(THEMES.dark.groupFill, 'rgba(255,255,255,.07)');
  assert.equal(THEMES.light.groupLine, 'rgba(73,57,89,.14)');
  assert.equal(THEMES.light.groupLabelInk, '#675a70');
  assert.equal(THEMES.dark.groupLabelInk, '#b8a7c5');
  assert.equal(THEMES.light.badgeBg, 'rgba(255,255,255,.5)');
  assert.equal(THEMES.light.badgeInk, '#302a36');
  assert.equal(THEMES.dark.badgeInk, '#ece3f2');
});

test('선택선은 쉘 accent(검정 없음)', () => {
  assert.equal(THEMES.light.selectLine, '#6f569a');
  assert.equal(THEMES.dark.selectLine, '#c6aee3');
  assert.equal(THEMES.light.selectLine, THEMES.light.accent);
  assert.equal(THEMES.dark.selectLine, THEMES.dark.accent);
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

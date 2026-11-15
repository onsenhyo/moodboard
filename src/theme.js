// 캔버스와 내보낸 페이지가 함께 쓰는 테마 토큰. 브라우저 API를 쓰지 않는다.
//
// THEMES = {light, dark}: 스펙 4장 표의 값. 글꼴은 ctx.font에 바로 넣을 수 있는 CSS 문자열이다.
// themeName(isDark) -> 'light'|'dark'
// groupDotColor(cards) -> '#rrggbb': 채도 있는 카드 색의 hue 중앙값을 HSL(h, .55, .55)로 바꾼 값.

import { colorSortKey } from './color.js';

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = 'system-ui, -apple-system, sans-serif';
const GRAY = '#9e9e9e';

const light = {
  bg: '#f4f1ec',
  grid: null,
  mat: { pad: 6, bottom: 22 },
  matBg: '#ffffff',
  shadow: [
    { blur: 2, y: 1, color: 'rgba(0,0,0,.08)' },
    { blur: 20, y: 8, color: 'rgba(0,0,0,.08)' },
  ],
  captionFont: `11px ${SERIF}`,
  captionColor: '#666',
  badgeBg: 'rgba(255,255,255,.9)',
  badgeInk: '#555',
  badgeFont: `600 10px ${SANS}`,
  textBg: '#fffdf7',
  textInk: '#3a352d',
  textFont: `italic 13px ${SERIF}`,
  textAccentBar: false,
  textAccentWidth: 3,
  loadingBg: '#e9e4dc',
  placeholderBg: '#ddd6cb',
  placeholderInk: '#3a352d',
  placeholderFont: `12px ${SERIF}`,
  linkBg: '#fffdf7',
  linkInk: '#3a352d',
  linkMuted: '#8a7f6e',
  linkTitleFont: `600 14px ${SERIF}`,
  linkUrlFont: `11px ${SERIF}`,
  noteBg: 'rgba(30,28,25,.62)',
  noteInk: '#ffffff',
  noteFont: `11px ${SERIF}`,
  groupFill: 'rgba(255,255,255,.35)',
  groupLine: '#cfc7ba',
  groupLabelFont: `600 11px ${SERIF}`,
  groupLabelInk: '#8a7f6e',
  groupLabelUpper: true,
  groupLabelSpacing: '0.08em',
  groupLabelGap: 4,
  groupDot: false,
  groupDotFallback: GRAY,
  selectLine: '#3a352d',
  selectWidth: 2,
  uiFont: `12px ${SERIF}`,
};

const dark = {
  bg: '#141416',
  grid: { step: 18, dot: '#2a2a2e', r: 1 },
  mat: null,
  matBg: null,
  shadow: [{ blur: 30, y: 10, color: 'rgba(0,0,0,.6)' }],
  captionFont: `11px ${SANS}`,
  captionColor: null,
  badgeBg: 'rgba(0,0,0,.55)',
  badgeInk: '#eee',
  badgeFont: `600 10px ${SANS}`,
  textBg: '#232327',
  textInk: '#e9e6df',
  textFont: `13px ${SANS}`,
  textAccentBar: true,
  textAccentWidth: 3,
  loadingBg: '#1e1e22',
  placeholderBg: '#2c2c31',
  placeholderInk: '#e9e6df',
  placeholderFont: `12px ${SANS}`,
  linkBg: '#232327',
  linkInk: '#e9e6df',
  linkMuted: '#9a9aa2',
  linkTitleFont: `600 14px ${SANS}`,
  linkUrlFont: `11px ${SANS}`,
  noteBg: 'rgba(0,0,0,.62)',
  noteInk: '#ffffff',
  noteFont: `11px ${SANS}`,
  groupFill: 'rgba(255,255,255,.04)',
  groupLine: 'rgba(255,255,255,.10)',
  groupLabelFont: `600 11px ${SANS}`,
  groupLabelInk: '#bdbdc4',
  groupLabelUpper: false,
  groupLabelSpacing: '0px',
  groupLabelGap: 6,
  groupDot: true,
  groupDotFallback: GRAY,
  selectLine: '#e9e6df',
  selectWidth: 2,
  uiFont: `12px ${SANS}`,
};

export const THEMES = { light, dark };

export function themeName(isDark) {
  return isDark ? 'dark' : 'light';
}

const hex2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0');

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return '#' + rgb.map((v) => hex2(v + m)).join('');
}

export function groupDotColor(cards) {
  const hues = [];
  for (const card of cards ?? []) {
    const c = card?.color;
    if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}/.test(c)) continue;
    const k = colorSortKey(c);
    if (k.group === 0) hues.push(k.hue);
  }
  if (!hues.length) return GRAY;
  hues.sort((a, b) => a - b);
  return hslToHex(hues[(hues.length - 1) >> 1], 0.55, 0.55);
}

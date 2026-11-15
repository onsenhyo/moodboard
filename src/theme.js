// 캔버스와 내보낸 페이지가 함께 쓰는 테마 토큰. 브라우저 API를 쓰지 않는다.
//
// THEMES = {light, dark}: 쉘 팔레트에 맞춘 값(스펙 2026-11-15 수정). 글꼴은 ctx.font에 바로 넣을 수 있는 CSS 문자열이다.
// themeName(isDark) -> 'light'|'dark'
// groupDotColor(cards) -> '#rrggbb': 채도 있는 카드 색의 hue 중앙값을 HSL(h, .55, .55)로 바꾼 값.

import { colorSortKey } from './color.js';

// 쉘(kaleidoscope ui/src/styles/foundation.css)의 --ks-font-family와 같은 글꼴 목록.
// 프레임 안에는 DM Sans와 Pretendard가 없을 수 있으므로 시스템 글꼴로 이어진다.
const UI = "'DM Sans Variable', 'Pretendard Variable', 'Segoe UI', 'Malgun Gothic', system-ui, -apple-system, sans-serif";
const GRAY = '#9e9e9e';

// 쉘 색 토큰. 캔버스 바탕은 surface-solid라서 창의 한 부분으로 읽힌다.
export const SHELL = {
  light: {
    background: '#e4dde3', surface: 'rgba(255,255,255,.36)', surfaceRaised: 'rgba(255,255,255,.5)',
    surfaceSolid: '#f7f3f7', border: 'rgba(73,57,89,.14)', text: '#302a36', muted: '#675a70',
    accent: '#6f569a', accentSoft: '#a58cbb', accentContrast: '#ffffff',
  },
  dark: {
    background: '#1d1822', surface: 'rgba(255,255,255,.07)', surfaceRaised: 'rgba(255,255,255,.11)',
    surfaceSolid: '#2a2230', border: 'rgba(230,214,240,.13)', text: '#ece3f2', muted: '#b8a7c5',
    accent: '#c6aee3', accentSoft: '#a47dba', accentContrast: '#241b2c',
  },
};

function make(k, o) {
  return {
    bg: k.surfaceSolid,
    // 점 격자: 세계 좌표 20px 간격, 끌고 확대하면 함께 움직인다.
    grid: { step: 20, dot: k.border, r: 1 },
    mat: o.mat,
    matBg: o.mat ? '#ffffff' : null,
    shadow: o.shadow,
    captionFont: `11px ${UI}`,
    captionColor: null, // 캡션 줄은 없다
    badgeBg: k.surfaceRaised,
    badgeInk: k.text,
    badgeFont: `600 10px ${UI}`,
    textBg: o.textBg,
    textInk: k.text,
    textFont: `13px ${UI}`,
    textBorder: o.textBorder,
    textAccentBar: true,
    textAccentWidth: 3,
    loadingBg: o.loadingBg,
    placeholderBg: o.placeholderBg,
    placeholderInk: k.muted,
    placeholderFont: `12px ${UI}`,
    linkBg: o.textBg,
    linkBorder: o.textBorder,
    linkInk: k.text,
    linkMuted: k.muted,
    linkTitleFont: `600 14px ${UI}`,
    linkUrlFont: `11px ${UI}`,
    noteBg: 'rgba(48,42,54,.72)',
    noteInk: '#ffffff',
    noteFont: `11px ${UI}`,
    groupFill: k.surface,
    groupLine: k.border,
    groupLabelFont: `600 12px ${UI}`,
    groupLabelInk: k.muted,
    groupLabelUpper: false,
    groupLabelSpacing: '0px',
    groupLabelGap: 6,
    groupDot: true,
    groupDotFallback: GRAY,
    selectLine: k.accent,
    selectWidth: 2,
    uiFont: `12px ${UI}`,
    accent: k.accent,
    accentContrast: k.accentContrast,
    surfaceRaised: k.surfaceRaised,
    border: k.border,
    muted: k.muted,
    surfaceSolid: k.surfaceSolid,
  };
}

const light = make(SHELL.light, {
  mat: { pad: 4, bottom: 4 },
  shadow: [
    { blur: 12, y: 4, color: 'rgba(48,42,54,.10)' },
    { blur: 2, y: 1, color: 'rgba(48,42,54,.06)' },
  ],
  textBg: '#ffffff',
  textBorder: SHELL.light.border,
  loadingBg: '#efe9ef',
  placeholderBg: '#efe9ef',
});

const dark = make(SHELL.dark, {
  mat: null,
  shadow: [{ blur: 16, y: 6, color: 'rgba(0,0,0,.35)' }],
  textBg: '#342b3b',
  textBorder: null,
  loadingBg: '#30283a',
  placeholderBg: '#30283a',
});

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

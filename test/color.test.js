import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dominantColor, colorSortKey } from '../src/color.js';

function pixels(parts) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  const a = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const { rgba, n } of parts) for (let k = 0; k < n; k++) { a.set(rgba, i); i += 4; }
  return a;
}

test('빨강 70% + 회색 30%이면 빨강 근처', () => {
  const hex = dominantColor(pixels([{ rgba: [230, 20, 20, 255], n: 70 }, { rgba: [128, 128, 128, 255], n: 30 }]));
  const { hue, group } = colorSortKey(hex);
  assert.equal(group, 0);
  assert.ok(hue <= 10 || hue >= 350, `hue ${hue}`);
});

test('채도 가중치: 회색 75% + 진파랑 25%이면 파랑이 이긴다', () => {
  // count만 보면 회색이 이긴다. 75×0.3=22.5 < 25×1.3=32.5
  const hex = dominantColor(pixels([{ rgba: [128, 128, 128, 255], n: 75 }, { rgba: [0, 0, 160, 255], n: 25 }]));
  assert.equal(hex, '#0000a0');
});

test('같은 버킷의 평균색, 소문자 hex', () => {
  assert.equal(dominantColor(pixels([{ rgba: [0xa0, 0x10, 0x20, 255], n: 1 }, { rgba: [0xae, 0x1e, 0x2e, 255], n: 1 }])), '#a71727');
});

test('투명 픽셀은 무시한다', () => {
  const hex = dominantColor(pixels([{ rgba: [128, 128, 128, 255], n: 2 }, { rgba: [255, 0, 0, 100], n: 50 }]));
  assert.equal(hex, '#808080');
});

test('모두 투명이면 #9e9e9e', () => {
  assert.equal(dominantColor(pixels([{ rgba: [255, 0, 0, 0], n: 10 }])), '#9e9e9e');
  assert.equal(dominantColor(new Uint8ClampedArray(0)), '#9e9e9e');
});

test('colorSortKey', () => {
  assert.deepEqual(colorSortKey('#ff0000'), { group: 0, hue: 0, light: 0.5 });
  const g = colorSortKey('#00ff00');
  assert.equal(g.group, 0); assert.equal(g.hue, 120);
  assert.equal(colorSortKey('#0000ff').hue, 240);
  assert.equal(colorSortKey('#808080').group, 1);
  assert.equal(colorSortKey('#9e9e9e').group, 1);
  assert.equal(colorSortKey('#ffffff').light, 1);
  assert.equal(colorSortKey('#FF0000').group, 0);
});

test('채도 0.15 경계', () => {
  // #998282: l≈0.555, s≈0.12 → 무채색. #a07070: s≈0.21 → 유채색
  assert.equal(colorSortKey('#998282').group, 1);
  assert.equal(colorSortKey('#a07070').group, 0);
});

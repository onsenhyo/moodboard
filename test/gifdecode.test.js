import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGif, parseGif, lzwDecode, interlaceRows, gifDelayMs, gifSize, GIF_MAX_PIXELS } from '../src/gifdecode.js';

// --- 손으로 만드는 작은 GIF ---

const u16 = (n) => [n & 255, n >> 8];

// 표준 LZW 부호기(사전을 키우고, 꽉 차면 clear). 코드 크기가 자라는 경로와 KwKwK 경로를 함께 지난다.
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let size = minCodeSize + 1, next = eoi + 1;
  const dict = new Map();
  const out = [];
  let acc = 0, bits = 0;
  const emit = (c) => { acc |= c << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } };
  emit(clear);
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = w * 4096 + k;
    if (dict.has(key)) { w = dict.get(key); continue; }
    emit(w);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else { emit(clear); dict.clear(); size = minCodeSize + 1; next = eoi + 1; }
    w = k;
  }
  emit(w);
  emit(eoi);
  if (bits) out.push(acc & 255);
  return out;
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) { const s = bytes.slice(i, i + 255); out.push(s.length, ...s); }
  out.push(0);
  return out;
}

const flat = (pal) => pal.flat();
const palBits = (n) => Math.max(0, Math.ceil(Math.log2(Math.max(2, n))) - 1);
const padPal = (pal) => { const n = 1 << (palBits(pal.length) + 1); return [...pal, ...Array(n - pal.length).fill([0, 0, 0])]; };

// frames: [{x,y,w,h, idx, delay, disposal, transparent, interlaced, local}]
function makeGif({ w, h, global, frames, version = '89a' }) {
  const out = [...Buffer.from('GIF' + version), ...u16(w), ...u16(h)];
  if (global) { const g = padPal(global); out.push(0x80 | palBits(global.length), 0, 0, ...flat(g)); } else out.push(0, 0, 0);
  for (const f of frames) {
    if (version === '89a') {
      const pf = ((f.disposal ?? 0) << 2) | (f.transparent != null ? 1 : 0);
      out.push(0x21, 0xf9, 4, pf, ...u16(f.delay ?? 0), f.transparent ?? 0, 0);
    }
    let lf = f.interlaced ? 0x40 : 0;
    let local = [];
    if (f.local) { lf |= 0x80 | palBits(f.local.length); local = flat(padPal(f.local)); }
    out.push(0x2c, ...u16(f.x ?? 0), ...u16(f.y ?? 0), ...u16(f.w ?? w), ...u16(f.h ?? h), lf, ...local);
    // 비월이면 번호 순서대로 줄을 다시 늘어놓는다.
    let idx = f.idx;
    if (f.interlaced) {
      const fw = f.w ?? w;
      idx = interlaceRows(f.h ?? h).flatMap((r) => idx.slice(r * fw, r * fw + fw));
    }
    const mcs = Math.max(2, palBits((f.local ?? global).length) + 1);
    out.push(mcs, ...subBlocks(lzwEncode(idx, mcs)));
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

const px = (rgba, W, x, y) => Array.from(rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
const RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255], WHITE = [255, 255, 255];

test('gifDelayMs: 0이나 2cs 미만은 10cs(100ms)', () => {
  assert.equal(gifDelayMs(0), 100);
  assert.equal(gifDelayMs(1), 100);
  assert.equal(gifDelayMs(2), 20);
  assert.equal(gifDelayMs(30), 300);
});

test('두 프레임: 프레임 수, 길이, 프레임마다 다른 색', () => {
  const W = 4, H = 3;
  const gif = makeGif({
    w: W, h: H, global: [RED, BLUE],
    frames: [{ idx: Array(W * H).fill(0), delay: 30 }, { idx: Array(W * H).fill(1), delay: 0 }],
  });
  const g = openGif(gif);
  assert.equal(g.count, 2);
  assert.deepEqual([g.width, g.height], [W, H]);
  assert.deepEqual(g.delays, [300, 100]);
  const f0 = g.frameAt(0), f1 = g.frameAt(1);
  assert.equal(f0.length, W * H * 4);
  assert.deepEqual(px(f0, W, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(f0, W, 3, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(f1, W, 2, 1), [0, 0, 255, 255]);
  // 앞으로 되돌아가도(처음부터 다시 겹쳐) 같다
  assert.deepEqual(px(g.frameAt(0), W, 1, 1), [255, 0, 0, 255]);
});

test('투명 + 처분 2: 앞 프레임 자리를 투명으로 비우고, 투명 번호는 아래를 남긴다', () => {
  const W = 4, H = 4;
  // 0: 빨강 바탕 전체(처분 1, 남긴다)
  // 1: 가운데 2×2 초록, 왼쪽 위 픽셀은 투명 번호(2) — 처분 2
  // 2: 오른쪽 아래 1×1 파랑
  const gif = makeGif({
    w: W, h: H, global: [RED, GREEN, WHITE, BLUE],
    frames: [
      { idx: Array(16).fill(0), disposal: 1, delay: 5 },
      { x: 1, y: 1, w: 2, h: 2, idx: [2, 1, 1, 1], transparent: 2, disposal: 2, delay: 5 },
      { x: 3, y: 3, w: 1, h: 1, idx: [3], delay: 5 },
    ],
  });
  const g = openGif(gif);
  assert.equal(g.count, 3);
  const f1 = g.frameAt(1);
  assert.deepEqual(px(f1, W, 1, 1), [255, 0, 0, 255]); // 투명 → 아래 빨강
  assert.deepEqual(px(f1, W, 2, 1), [0, 255, 0, 255]);
  assert.deepEqual(px(f1, W, 2, 2), [0, 255, 0, 255]);
  const f2 = g.frameAt(2);
  assert.deepEqual(px(f2, W, 1, 1), [0, 0, 0, 0]); // 처분 2로 비운 자리
  assert.deepEqual(px(f2, W, 2, 2), [0, 0, 0, 0]);
  assert.deepEqual(px(f2, W, 0, 0), [255, 0, 0, 255]); // 바깥은 그대로
  assert.deepEqual(px(f2, W, 3, 3), [0, 0, 255, 255]);
});

test('처분 3: 그리기 전 화면으로 되돌린다', () => {
  const W = 2, H = 1;
  const gif = makeGif({
    w: W, h: H, global: [RED, GREEN],
    frames: [
      { idx: [0, 0] },
      { x: 0, y: 0, w: 1, h: 1, idx: [1], disposal: 3 },
      { x: 1, y: 0, w: 1, h: 1, idx: [1] },
    ],
  });
  const g = openGif(gif);
  assert.deepEqual(px(g.frameAt(1), W, 0, 0), [0, 255, 0, 255]);
  const f2 = g.frameAt(2);
  assert.deepEqual(px(f2, W, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(f2, W, 1, 0), [0, 255, 0, 255]);
});

test('비월: 줄 순서를 되돌려 제자리에 그린다', () => {
  const W = 3, H = 9;
  const pal = [RED, GREEN, BLUE, WHITE];
  const idx = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) idx.push(y % 4);
  const g = openGif(makeGif({ w: W, h: H, global: pal, frames: [{ idx, interlaced: true }] }));
  assert.ok(parseGif(makeGif({ w: W, h: H, global: pal, frames: [{ idx, interlaced: true }] })).frames[0].interlaced);
  const f = g.frameAt(0);
  for (let y = 0; y < H; y++) assert.deepEqual(px(f, W, 1, y), [...pal[y % 4], 255], `줄 ${y}`);
  assert.deepEqual(interlaceRows(9), [0, 8, 4, 2, 6, 1, 3, 5, 7]);
});

test('지역 팔레트: 프레임 팔레트가 전역 팔레트를 덮는다, GIF87a', () => {
  const W = 2, H = 2;
  const gif = makeGif({
    version: '87a', w: W, h: H, global: [RED, GREEN],
    frames: [
      { idx: [0, 1, 1, 0] },
      { idx: [0, 1, 1, 0], local: [BLUE, WHITE] },
    ],
  });
  const g = openGif(gif);
  assert.equal(g.count, 2);
  assert.deepEqual(g.delays, [100, 100]);
  assert.deepEqual(px(g.frameAt(0), W, 1, 0), [0, 255, 0, 255]);
  const f1 = g.frameAt(1);
  assert.deepEqual(px(f1, W, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(f1, W, 1, 0), [255, 255, 255, 255]);
});

test('LZW: 긴 반복(KwKwK, 코드 크기 증가, 사전 가득 참)도 그대로 풀린다', () => {
  const n = 64 * 80;
  const idx = Array.from({ length: n }, (_, i) => (i * 7 + (i >> 5)) % 16 < 3 ? 0 : (i * 13) % 16);
  const bytes = lzwEncode(idx, 4);
  const out = new Uint8Array(n);
  assert.equal(lzwDecode(new Uint8Array(bytes), [0, bytes.length], 4, out), n);
  assert.deepEqual(Array.from(out), idx);
  const same = Array(5000).fill(3);
  const b2 = lzwEncode(same, 2);
  const o2 = new Uint8Array(5000);
  assert.equal(lzwDecode(new Uint8Array(b2), [0, b2.length], 2, o2), 5000);
  assert.ok(o2.every((v) => v === 3));
});

test('깨진 입력: GIF가 아니거나 프레임이 없으면 던진다', () => {
  assert.throws(() => openGif(new Uint8Array([1, 2, 3])));
  assert.throws(() => openGif(new Uint8Array([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b])));
});

// --- 크기 한도 ---

// 머리만 있는 35바이트 GIF: 화면 W×H, 그림 하나(x,y,w,h), LZW 데이터는 clear+eoi뿐.
function tinyGif(W, H, { x = 0, y = 0, w = W, h = H } = {}) {
  return new Uint8Array([
    ...Buffer.from('GIF89a'), ...u16(W), ...u16(H), 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
    0x2c, ...u16(x), ...u16(y), ...u16(w), ...u16(h), 0, 2, 2, 0x44, 0x01, 0, 0x3b,
  ]);
}

test('gifSize: 머리의 가로·세로만 읽는다. GIF가 아니면 null', () => {
  assert.deepEqual(gifSize(tinyGif(12000, 12000)), { width: 12000, height: 12000 });
  assert.deepEqual(gifSize(new Uint8Array([...Buffer.from('GIF87a'), 3, 0, 2, 0]).buffer), { width: 3, height: 2 });
  assert.equal(gifSize(new Uint8Array([1, 2, 3])), null);
  assert.equal(gifSize(new Uint8Array([...Buffer.from('GIF89a'), 3, 0])), null);
});

test('화면이 GIF_MAX_PIXELS를 넘으면 openGif가 던진다(12000×12000을 만들지 않는다)', () => {
  assert.equal(GIF_MAX_PIXELS, 4_000_000);
  const bomb = tinyGif(12000, 12000);
  assert.equal(bomb.length, 35);
  assert.throws(() => parseGif(bomb), /너무 큽니다/);
  assert.throws(() => openGif(bomb), /너무 큽니다/);
  // 딱 한도면 연다
  assert.equal(openGif(tinyGif(2000, 2000)).width, 2000);
});

test('그림 사각형이 화면보다 크면 던지고, 화면 밖으로 삐져나오면 잘라 그린다', () => {
  // 1×1 화면에 65535×65535 그림: 색 번호 버퍼를 만들지 않고 던진다
  assert.throws(() => openGif(tinyGif(1, 1, { w: 65535, h: 65535 })), /그림이 화면보다 큽니다/);
  // 3×1 화면, x=2에 2×1 그림: 화면 안 한 픽셀만 그린다
  const gif = makeGif({ w: 3, h: 1, global: [RED, GREEN], frames: [{ idx: [0, 0, 0] }, { x: 2, y: 0, w: 2, h: 1, idx: [1, 1] }] });
  const g = openGif(gif);
  const f = g.frameAt(1);
  assert.equal(f.length, 3 * 4);
  assert.deepEqual(px(f, 3, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(f, 3, 2, 0), [0, 255, 0, 255]);
});

test('view(i): 같은 작업 버퍼를 돌려준다(다음 호출까지만 유효). frameAt은 새 배열', () => {
  const W = 2, H = 1;
  const g = openGif(makeGif({ w: W, h: H, global: [RED, BLUE], frames: [{ idx: [0, 0] }, { idx: [1, 1] }] }));
  const v0 = g.view(0);
  assert.deepEqual(px(v0, W, 0, 0), [255, 0, 0, 255]);
  const v1 = g.view(1);
  assert.equal(v1, v0);
  assert.deepEqual(px(v1, W, 1, 0), [0, 0, 255, 255]);
  const a = g.frameAt(0), b = g.frameAt(0);
  assert.notEqual(a, b);
  assert.notEqual(a, g.view(1));
  assert.deepEqual(px(a, W, 0, 0), [255, 0, 0, 255]);
});

// --- 잘린 입력 ---

test('잘린 GIF: 다 읽은 프레임까지만 쓴다. 한 프레임도 없으면 던진다', () => {
  const W = 2, H = 1;
  const full = makeGif({ w: W, h: H, global: [RED, BLUE], frames: [{ idx: [0, 0], delay: 7 }, { idx: [1, 1], delay: 9 }] });
  // 끝 바이트(0x3b)를 떼고, 둘째 프레임 데이터 중간에서도 잘라 본다
  for (const cut of [1, 3, 6, 12]) {
    const g = openGif(full.subarray(0, full.length - cut));
    assert.ok(g.count >= 1, `cut ${cut}`);
    assert.deepEqual(px(g.frameAt(0), W, 0, 0), [255, 0, 0, 255]);
  }
  assert.equal(openGif(full.subarray(0, full.length - 1)).count, 2);
  // 둘째 그림 머리(0x2c) 바로 뒤에서 자르면 첫 프레임만
  const second = full.lastIndexOf(0x2c);
  const g1 = openGif(full.subarray(0, second + 3));
  assert.equal(g1.count, 1);
  assert.deepEqual(g1.delays, [70]);
  // 첫 프레임 데이터 도중에 자르면 프레임이 없어 던진다
  const first = full.indexOf(0x2c);
  assert.throws(() => openGif(full.subarray(0, first + 12)), /잘렸|프레임이 없습니다/);
  // 팔레트가 잘려도 던진다
  assert.throws(() => openGif(full.subarray(0, 15)));
});

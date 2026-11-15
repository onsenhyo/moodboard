// GIF를 직접 푼다(GIF87a/89a). WebCodecs ImageDecoder가 없거나 GIF를 못 풀 때 gifanim.js가 쓴다(WKWebView).
// DOM을 쓰지 않아 node 테스트로 확인한다.
//
// openGif(bytes) -> {width, height, count, delays, frameAt(i), view(i)}
// - 처음에는 구조만 읽는다(블록 위치, 팔레트, 그래픽 제어 확장). 픽셀은 frameAt/view에서 푼다(lazy).
// - delays[i]: ms. 0이나 2cs 미만은 브라우저처럼 10cs(100ms)로 본다.
// - frameAt(i) -> Uint8ClampedArray(width×height×4, RGBA): 프레임 0..i를 처분 방법(0–3)대로 겹친 화면.
//   앞에서부터 차례로 겹치므로 지금 위치보다 앞을 달라면 처음부터 다시 겹친다. 돌려주는 배열은 새것이다.
// - view(i): frameAt과 같은 화면이지만 복사하지 않고 작업 버퍼를 그대로 돌려준다. 늘 같은 배열이고
//   다음 view/frameAt 호출에서 바뀌므로 그 전에 다 써야 한다(ImageData로 감싸 곧바로 비트맵을 만들 때).
//   작업 버퍼는 화면 한 장(처분 3이 있으면 두 장)과 색 번호 버퍼 하나만 두고 호출마다 다시 쓴다.
// 크기 한도: 화면(가로×세로)이 GIF_MAX_PIXELS를 넘거나 그림 사각형이 화면보다 크면 던진다(머리만 보고
//   큰 버퍼를 만들지 않는다). 화면 밖으로 삐져나온 부분은 잘라 그린다. gifSize(bytes)는 머리만 읽는다.
// 형식이 깨졌으면 openGif가 던진다. 파일이 중간에 잘렸으면 끝까지 읽은 프레임만 쓴다(하나도 없으면 던진다).
// 프레임 데이터가 모자라면 남은 픽셀을 그리지 않는다.

export const MIN_DELAY_CS = 2;
export const DEFAULT_DELAY_CS = 10;
// 화면 픽셀 한도. RGBA 화면 한 장이 16MB, 처분 3까지 두 장이면 32MB.
export const GIF_MAX_PIXELS = 4_000_000;

// 머리(10바이트)의 화면 가로·세로. GIF가 아니거나 짧으면 null.
export function gifSize(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 10) return null;
  const sig = String.fromCharCode(...u8.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { width: u8[6] | (u8[7] << 8), height: u8[8] | (u8[9] << 8) };
}

// 파일이 끝나서 더 읽을 수 없을 때. parseGif가 받아 읽은 프레임까지만 쓴다.
class Truncated extends Error {}

export function gifDelayMs(cs) {
  return (cs < MIN_DELAY_CS ? DEFAULT_DELAY_CS : cs) * 10;
}

function readPalette(u8, p, n) {
  if (p + n * 3 > u8.length) throw new Truncated('GIF: 팔레트가 잘렸습니다');
  return u8.subarray(p, p + n * 3);
}

// 데이터 하위 블록을 건너뛰고 끝 위치를 돌려준다. ranges가 있으면 [시작, 끝]을 모은다.
function skipSubBlocks(u8, p, ranges) {
  for (;;) {
    if (p >= u8.length) throw new Truncated('GIF: 블록이 잘렸습니다');
    const n = u8[p++];
    if (n === 0) return p;
    if (ranges) ranges.push(p, Math.min(p + n, u8.length));
    p += n;
  }
}

export function parseGif(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = String.fromCharCode(...u8.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('GIF가 아닙니다');
  if (u8.length < 13) throw new Error('GIF: 머리가 잘렸습니다');
  const width = u8[6] | (u8[7] << 8);
  const height = u8[8] | (u8[9] << 8);
  if (!width || !height) throw new Error('GIF: 크기가 0입니다');
  if (width * height > GIF_MAX_PIXELS) throw new Error(`GIF: 화면이 너무 큽니다(${width}×${height})`);
  const flags = u8[10];
  let p = 13;
  let globalPalette = null;
  if (flags & 0x80) {
    const n = 1 << ((flags & 7) + 1);
    globalPalette = readPalette(u8, p, n);
    p += n * 3;
  }
  const frames = [];
  let gce = null;
  try {
    while (p < u8.length) {
      const b = u8[p++];
      if (b === 0x3b) break; // 끝
      if (b === 0x21) {
        const label = u8[p++];
        if (label === 0xf9 && u8[p] >= 4) {
          const pf = u8[p + 1];
          gce = {
            disposal: (pf >> 2) & 7,
            transparent: pf & 1 ? u8[p + 4] : -1,
            delayCs: u8[p + 2] | (u8[p + 3] << 8),
          };
        }
        p = skipSubBlocks(u8, p);
      } else if (b === 0x2c) {
        if (p + 9 > u8.length) throw new Truncated('GIF: 그림 머리가 잘렸습니다');
        const x = u8[p] | (u8[p + 1] << 8);
        const y = u8[p + 2] | (u8[p + 3] << 8);
        const w = u8[p + 4] | (u8[p + 5] << 8);
        const h = u8[p + 6] | (u8[p + 7] << 8);
        const f = u8[p + 8];
        p += 9;
        if (w * h > width * height) throw new Error(`GIF: 그림이 화면보다 큽니다(${w}×${h})`);
        let palette = globalPalette;
        if (f & 0x80) {
          const n = 1 << ((f & 7) + 1);
          palette = readPalette(u8, p, n);
          p += n * 3;
        }
        if (p >= u8.length) throw new Truncated('GIF: 그림 데이터가 잘렸습니다');
        const minCodeSize = u8[p++];
        const ranges = [];
        p = skipSubBlocks(u8, p, ranges);
        const delayCs = gce ? gce.delayCs : 0;
        frames.push({
          x, y, w, h, interlaced: !!(f & 0x40), palette, minCodeSize, ranges,
          disposal: gce ? gce.disposal : 0,
          transparent: gce ? gce.transparent : -1,
          delayCs, delay: gifDelayMs(delayCs),
        });
        gce = null;
      } else {
        break; // 모르는 블록: 여기까지만 쓴다
      }
    }
  } catch (err) {
    // 잘렸으면 다 읽은 프레임까지만 쓴다. 하나도 없으면 그대로 던진다.
    if (!(err instanceof Truncated) || !frames.length) throw err;
  }
  if (!frames.length) throw new Error('GIF: 프레임이 없습니다');
  return { u8, width, height, frames };
}

// LZW를 풀어 색 번호를 out(길이 n)에 채운다. 채운 개수를 돌려준다.
export function lzwDecode(u8, ranges, minCodeSize, out) {
  const n = out.length;
  if (minCodeSize < 1 || minCodeSize > 11) throw new Error('GIF: LZW 코드 크기가 이상합니다');
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let c = 0; c < clear; c++) { suffix[c] = c; first[c] = c; prefix[c] = -1; }
  let size = minCodeSize + 1;
  let mask = (1 << size) - 1;
  let next = eoi + 1;
  let prev = -1;
  let acc = 0, bits = 0, pos = 0;
  let ri = 0, rp = ranges[0] ?? 0, re = ranges[1] ?? 0;
  while (pos < n) {
    while (bits < size) {
      while (rp >= re) {
        ri += 2;
        if (ri >= ranges.length) return pos;
        rp = ranges[ri]; re = ranges[ri + 1];
      }
      acc |= u8[rp++] << bits;
      bits += 8;
    }
    const code = acc & mask;
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCodeSize + 1; mask = (1 << size) - 1; next = eoi + 1; prev = -1;
      continue;
    }
    if (code === eoi) break;
    let c, sp = 0;
    if (prev === -1) {
      if (code >= clear) return pos; // 깨짐
      out[pos++] = code;
      prev = code;
      continue;
    }
    if (code < next) {
      c = code;
    } else if (code === next) {
      stack[sp++] = first[prev];
      c = prev;
    } else {
      return pos; // 깨짐
    }
    const head = first[c];
    while (c >= 0) { stack[sp++] = suffix[c]; c = prefix[c]; }
    while (sp > 0 && pos < n) out[pos++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = code === next ? first[prev] : head;
      first[next] = first[prev];
      next++;
      if (next > mask && size < 12) { size++; mask = (1 << size) - 1; }
    }
    prev = code;
  }
  return pos;
}

// 비월(interlace) 줄 순서: 번호 순서의 k번째 줄이 실제 몇 번째 줄인지.
export function interlaceRows(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let r = start; r < h; r += step) rows.push(r);
  }
  return rows;
}

// idxBuf: 색 번호 버퍼(화면 크기). 그림 사각형은 화면보다 크지 않으므로(parseGif) 들어간다.
function drawFrame(gif, f, screen, idxBuf) {
  const { u8, width: W, height: H } = gif;
  const idx = idxBuf.subarray(0, f.w * f.h);
  const got = lzwDecode(u8, f.ranges, f.minCodeSize, idx);
  const pal = f.palette;
  const rows = f.interlaced ? interlaceRows(f.h) : null;
  const t = f.transparent;
  for (let k = 0; k < f.h; k++) {
    if (k * f.w >= got) break;
    const sy = f.y + (rows ? rows[k] : k);
    if (sy >= H) continue;
    const base = k * f.w;
    for (let i = 0; i < f.w; i++) {
      if (base + i >= got) break;
      const sx = f.x + i;
      if (sx >= W) break;
      const ci = idx[base + i];
      if (ci === t) continue;
      const o = (sy * W + sx) * 4;
      if (pal && ci * 3 + 2 < pal.length) {
        screen[o] = pal[ci * 3]; screen[o + 1] = pal[ci * 3 + 1]; screen[o + 2] = pal[ci * 3 + 2];
      } else {
        screen[o] = 0; screen[o + 1] = 0; screen[o + 2] = 0;
      }
      screen[o + 3] = 255;
    }
  }
}

function clearRect(gif, f, screen) {
  const { width: W, height: H } = gif;
  const x1 = Math.min(W, f.x + f.w), y1 = Math.min(H, f.y + f.h);
  for (let y = f.y; y < y1; y++) screen.fill(0, (y * W + f.x) * 4, (y * W + x1) * 4);
}

export function openGif(bytes) {
  const gif = parseGif(bytes);
  const { width: W, height: H, frames } = gif;
  const screen = new Uint8ClampedArray(W * H * 4);
  let idxBuf = null; // 색 번호 버퍼. 처음 그릴 때 만들고 다시 쓴다.
  let saved = null; // 처분 3: 지금 프레임을 그리기 전 화면
  let at = -1; // screen에 그려진 마지막 프레임
  return {
    width: W,
    height: H,
    count: frames.length,
    delays: frames.map((f) => f.delay),
    frameAt(i) {
      return this.view(i).slice();
    },
    view(i) {
      if (!(i >= 0 && i < frames.length)) throw new RangeError('GIF: 프레임 번호가 범위 밖입니다');
      if (i < at) { screen.fill(0); saved = null; at = -1; }
      while (at < i) {
        // 앞 프레임의 처분을 적용하고 다음 프레임을 그린다.
        if (at >= 0) {
          const pf = frames[at];
          if (pf.disposal === 2) clearRect(gif, pf, screen);
          else if (pf.disposal === 3 && saved) screen.set(saved);
        }
        at++;
        const f = frames[at];
        if (f.disposal === 3) { if (!saved) saved = new Uint8ClampedArray(screen.length); saved.set(screen); }
        if (!idxBuf) idxBuf = new Uint8Array(W * H);
        drawFrame(gif, f, screen, idxBuf);
      }
      return screen;
    },
  };
}

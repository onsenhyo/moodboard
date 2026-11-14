// 브라우저 전용 썸네일 만들기. 테스트하지 않는다(ingest.js는 이 함수를 deps.makeThumb으로 받는다).
//
// makeThumb(bytes, mime) -> Promise<{jpegB64, pixels, width, height}|null>
// - jpegB64: data: 접두 없는 JPEG base64. 긴 변 640px·품질 0.75에서 시작해 길이가 100,000자 이하가 될
//   때까지 품질 0.5, 다음에 긴 변 480px로 낮춘다.
// - pixels: 64×64로 줄인 RGBA(Uint8ClampedArray). 대표 색 계산용.
// - width, height: 만든 썸네일의 크기(카드 비율용).
// 열 수 없거나 그릴 수 없으면 null. 영상의 64×64 표본이 모두 거의 검정(모든 채널 < 8)이거나
// 480px·품질 0.5에서도 base64가 100,000자를 넘으면 null(자리표시 카드).

const B64_MAX = 100_000;
const STEPS = [
  { side: 640, quality: 0.75 },
  { side: 640, quality: 0.5 },
  { side: 480, quality: 0.5 },
];
const PIXELS_SIDE = 64;
const VIDEO_TIMEOUT_MS = 10_000;
const FRAME_WAIT_MS = 500;

export async function makeThumb(bytes, mime) {
  try {
    if (!bytes || bytes.byteLength === 0) return null;
    const blob = new Blob([bytes], { type: mime });
    if (mime === 'video/mp4') return await fromVideo(blob);
    if (typeof mime === 'string' && mime.startsWith('image/')) return await fromImage(blob);
    return null;
  } catch {
    return null;
  }
}

async function fromImage(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    return await render(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close?.();
  }
}

function fromVideo(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  const once = (type) => new Promise((resolve, reject) => {
    const ok = () => { video.removeEventListener('error', bad); resolve(); };
    const bad = () => { video.removeEventListener(type, ok); reject(new Error('video error')); };
    video.addEventListener(type, ok, { once: true });
    video.addEventListener('error', bad, { once: true });
  });

  // seeked 직후 바로 그리면 빈(검은) 장면이 나온다. 다음 프레임이 나올 때까지(최대 500ms) 기다린다.
  const nextFrame = () => new Promise((resolve) => {
    const t = setTimeout(resolve, FRAME_WAIT_MS);
    const done = () => { clearTimeout(t); resolve(); };
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(done);
    else requestAnimationFrame(() => requestAnimationFrame(done));
  });

  const work = (async () => {
    const meta = once('loadedmetadata');
    video.src = url;
    await meta;
    const w = video.videoWidth, h = video.videoHeight;
    if (!(w > 0 && h > 0)) return null;
    const d = video.duration;
    const t = Number.isFinite(d) && d > 0 ? Math.min(1, d) : 0;
    const seeked = once('seeked');
    video.currentTime = t;
    await seeked;
    await nextFrame();
    return render(video, w, h, { rejectBlack: true });
  })();

  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), VIDEO_TIMEOUT_MS); });
  return Promise.race([work, timeout]).finally(cleanup);
}

async function render(source, srcW, srcH, { rejectBlack = false } = {}) {
  if (!(srcW > 0 && srcH > 0)) return null;
  const pixels = samplePixels(source);
  // 디코드하지 못한 영상(hvc1 등)은 검은 장면을 낸다. 그런 장면은 자리표시 카드로 보낸다.
  if (rejectBlack && isNearBlack(pixels)) return null;
  let last = null;
  for (const { side, quality } of STEPS) {
    const scale = Math.min(1, side / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const jpegB64 = toBase64(await jpeg.arrayBuffer());
    last = { jpegB64, width: w, height: h };
    if (jpegB64.length <= B64_MAX) break;
  }
  // 480px·품질 0.5에서도 크면 저장하지 않는다.
  if (!last || last.jpegB64.length > B64_MAX) return null;
  return { ...last, pixels };
}

const BLACK_MAX = 8;
function isNearBlack(px) {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] >= BLACK_MAX || px[i + 1] >= BLACK_MAX || px[i + 2] >= BLACK_MAX) return false;
  }
  return true;
}

function samplePixels(source) {
  const c = new OffscreenCanvas(PIXELS_SIDE, PIXELS_SIDE);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, PIXELS_SIDE, PIXELS_SIDE);
  return ctx.getImageData(0, 0, PIXELS_SIDE, PIXELS_SIDE).data;
}

function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(s);
}

// 보드에서 작은 GIF(card.anim)를 움직인다. sandbox 보드(board/board.js)가 render.js에 넘긴다.
//
// 순수한 부분(그리기 루프를 돌릴지, 재생 위치, 프레임 길이)은 위쪽에 두고 node 테스트로 확인한다.
//
// createGifPlayer({load, onFrame, budgetBytes, useDecoder}) -> {frame, retain, invalidate}
// - load(cardId) -> Promise<base64|null|undefined>. gif 저장소(gifs_00..31)의 원본. 없으면 정지 썸네일을 그린다.
// - onFrame(): 첫 프레임이 준비됐을 때. 다시 그리게 한다.
// - frame(card, t) -> CanvasImageSource|null: 지금 그릴 프레임. 처음 부르면 그때 읽고 디코드한다(lazy).
// - retain(ids): 지금 화면에 있는 anim 카드 id. 나머지 카드의 디코더와 프레임 캐시를 놓는다.
// - invalidate(): gif shard가 바뀌었을 때. 원본이 없던 카드를 다음 frame에서 다시 읽는다.
//
// 디코드: WebCodecs ImageDecoder가 있으면 프레임을 하나씩(지금 프레임의 다음 것만) 디코드해 ImageBitmap으로 모은다.
// 모은 프레임이 budgetBytes(가로×세로×4로 잰다)를 넘으면 그 카드는 지금 프레임과 다음 프레임만 남긴다.
// ImageDecoder가 없으면 blob 주소의 <img>를 보이지 않게 문서에 붙여 두고 그대로 그린다. HTML 표준은 drawImage가
// 움직이는 그림의 첫 프레임을 쓰라고 해서 Chrome에서는 멈춘 채로 보인다(headless 확인). WebKit은 아직 확인하지 못했다.

export const ANIM_FPS = 30;
export const ANIM_FRAME_MS = 1000 / ANIM_FPS;
export const ANIM_BUDGET_BYTES = 64 * 1024 * 1024;
const LAG_RESET_MS = 1000;

// 다음 그리기까지 기다릴 ms. 루프를 돌리지 않으면 null.
// 움직이는 카드가 화면에 하나라도 있고, 표면과 페이지가 보일 때만 돈다.
export function animDelay({ animating, surfaceVisible, pageVisible, sinceLastMs = 0, frameMs = ANIM_FRAME_MS }) {
  if (!animating || !surfaceVisible || !pageVisible) return null;
  return Math.max(0, frameMs - Math.max(0, sinceLastMs));
}

// GIF 프레임 길이. 브라우저처럼 10ms 이하(0 포함)는 100ms로 본다.
export function frameDelay(ms) {
  return Number.isFinite(ms) && ms > 10 ? ms : 100;
}

// 재생 위치를 t까지 옮긴다. player = {cur, due}(due: 지금 프레임이 끝나는 시각).
// durOf(i)는 프레임 i가 준비됐으면 길이(ms), 아니면 null. 다음 프레임이 아직 없으면 지금 프레임에 머문다.
// 한참 밀렸으면(탭을 돌아왔을 때) 따라잡지 않고 지금부터 다시 센다. 바뀌었으면 참.
export function advance(player, t, count, durOf) {
  if (count <= 1) return false;
  if (player.due === undefined) {
    const d = durOf(player.cur);
    if (d == null) return false;
    player.due = t + d;
    return false;
  }
  let changed = false;
  for (let guard = 0; t >= player.due && guard < count; guard++) {
    const next = (player.cur + 1) % count;
    const d = durOf(next);
    // 다음 프레임이 아직 없으면 머문다. 준비되면 그때부터 센다(밀린 프레임을 건너뛰지 않는다).
    if (d == null) { player.due = t; break; }
    player.cur = next;
    player.due = t - player.due > LAG_RESET_MS ? t + d : player.due + d;
    changed = true;
  }
  return changed;
}

// --- 브라우저 ---

function b64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

let imgHost = null;
function hiddenHost() {
  if (imgHost?.isConnected) return imgHost;
  imgHost = document.createElement('div');
  imgHost.setAttribute('aria-hidden', 'true');
  imgHost.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none';
  document.body.append(imgHost);
  return imgHost;
}

export function createGifPlayer({
  load, onFrame = () => {}, budgetBytes = ANIM_BUDGET_BYTES,
  useDecoder = typeof ImageDecoder === 'function',
} = {}) {
  const entries = new Map(); // cardId -> entry
  let gen = 0; // invalidate 횟수
  let used = 0; // 모든 카드의 프레임 캐시 바이트

  function closeEntry(e) {
    e.dead = true;
    for (const f of e.frames ?? []) f?.bmp?.close?.();
    used -= e.bytes ?? 0;
    e.bytes = 0;
    try { e.decoder?.close(); } catch { /* 이미 닫힘 */ }
    if (e.img) { e.img.remove(); URL.revokeObjectURL(e.url); }
  }

  async function open(id, e) {
    let b64;
    try { b64 = await load(id); } catch { b64 = null; }
    if (e.dead) return;
    if (typeof b64 !== 'string' || !b64) { e.state = 'missing'; e.gen = gen; return; }
    const bytes = b64ToBytes(b64);
    if (useDecoder) {
      try {
        const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
        e.decoder = decoder;
        await decoder.tracks.ready; // 이 전에는 selectedTrack이 null이다
        await decoder.completed; // 데이터를 다 받아야 frameCount가 끝 값이 된다
        if (e.dead) return;
        e.count = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
        e.frames = new Array(e.count).fill(null);
        e.state = 'ready';
        decodeFrame(e, 0);
        return;
      } catch {
        try { e.decoder?.close(); } catch { /* 무시 */ }
        e.decoder = null;
        if (e.dead) return;
      }
    }
    // 대체: <img>. 문서에 붙어 있어야 WebKit이 움직이는 경우가 있어 보이지 않는 상자에 둔다.
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
    const img = new Image();
    img.decoding = 'async';
    e.url = url;
    e.img = img;
    img.onload = () => { if (!e.dead) { e.state = 'img'; onFrame(); } };
    img.onerror = () => { if (!e.dead) e.state = 'failed'; };
    img.src = url;
    img.style.cssText = 'display:block;width:1px;height:1px'; // 칠해지는 자리가 있어야 프레임이 넘어간다
    hiddenHost().append(img);
  }

  function decodeFrame(e, i) {
    if (e.dead || e.decoding || e.frames[i]) return;
    e.decoding = true;
    e.decoder.decode({ frameIndex: i })
      .then(async ({ image }) => {
        try {
          if (e.dead) return;
          const dur = frameDelay((image.duration ?? 0) / 1000); // VideoFrame.duration은 µs
          const bmp = await createImageBitmap(image);
          if (e.dead) { bmp.close(); return; }
          const size = bmp.width * bmp.height * 4;
          e.frames[i] = { bmp, dur, size };
          e.bytes = (e.bytes ?? 0) + size;
          used += size;
          // 예산을 넘으면 이 카드는 지금 프레임과 방금 것만 남긴다(다음 바퀴에 다시 디코드).
          if (used > budgetBytes) {
            e.frames.forEach((f, j) => {
              if (!f || j === i || j === e.player.cur) return;
              f.bmp.close();
              e.bytes -= f.size;
              used -= f.size;
              e.frames[j] = null;
            });
          }
          if (i === 0) onFrame();
        } finally {
          image.close();
        }
      })
      .catch(() => { if (i === 0) e.state = 'failed'; })
      .finally(() => { e.decoding = false; });
  }

  function frame(card, t) {
    let e = entries.get(card.id);
    if (e && e.state === 'missing' && e.gen !== gen) { entries.delete(card.id); e = null; }
    if (!e) {
      e = { state: 'loading', player: { cur: 0, due: undefined }, frames: null, bytes: 0, dead: false };
      entries.set(card.id, e);
      open(card.id, e);
      return null;
    }
    if (e.state === 'img') return e.img;
    if (e.state !== 'ready') return null;
    const durOf = (i) => (e.frames[i] ? e.frames[i].dur : null);
    advance(e.player, t, e.count, durOf);
    // 지금 프레임이 없으면(예산으로 놓았으면) 그것부터, 아니면 다음 프레임만 미리 디코드한다.
    if (!e.frames[e.player.cur]) decodeFrame(e, e.player.cur);
    else if (e.count > 1) decodeFrame(e, (e.player.cur + 1) % e.count);
    return e.frames[e.player.cur]?.bmp ?? null;
  }

  return {
    frame,
    retain(ids) {
      for (const [id, e] of entries) {
        if (!ids.has(id)) { closeEntry(e); entries.delete(id); }
      }
    },
    invalidate() { gen++; },
    get bytes() { return used; },
  };
}

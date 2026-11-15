// 보드(sandbox)에 끌어다 놓은 파일을 창 상태로 client에 옮기는 순수 도구. 브라우저 API를 쓰지 않는다.
//
// 왜 창 상태인가: 보드는 sandbox iframe이라 Finder에서 끌어온 drag 이벤트가 iframe 문서에만 온다. 쉘의
// drag guard(kaleidoscope ui/src/shell-drag-guard.ts)는 쉘 문서에 걸려 있어 보드 위의 drop을 보지 못한다.
// sandbox 브리지(ui/src/blocks/sandbox.tsx)는 state와 storage만 처리하고 blobs.put이나 file_drop은 받지 않는다.
// 그래서 sandbox가 File을 읽어 조각으로 나눠 창 상태 drop_inbox에 쓰고, client가 drop_ack로 받았다고 알린다.
//
// 한도: 창 상태 전체(선언한 모든 키의 JSON)가 64KiB(WINDOW_STATE_MAX_BYTES, crates/contract/src/lib.rs)를 넘으면
// 패치 전체가 거부된다. sandbox는 자기 state_keys만 보므로(draft, board_name, group_name, yt_embed, theme 등은
// 못 본다) 보이는 키만 센 값은 실제보다 작다. 그래서 조각은 원본 16KiB(base64 21,848자)로 작게 두고, 보이는 키와
// 조각을 합쳐 SANDBOX_STATE_LIMIT(64KiB − 16KiB) 안일 때만 쓴다. 못 보는 키에는 16KiB 넘게 남는다.
// 보내는 쪽은 조각마다 File.slice로 그 범위만 읽어 base64로 바꾼다(streamMessages). 메모리는 조각 하나로 묶인다.
// 조각마다 core 쓰기와 동기화가 두 번(조각, 받음) 돌므로 한 파일은 DROP_MAX_BYTES까지만 옮긴다.
//
// drop_inbox = {batch, seq, attempt, index, total, name, mime, size, part, parts, b64, x, y, reduced}
//   batch: 끌어 놓기 한 번의 id. seq: batch 안의 조각 순번(0부터, 파일을 넘어 이어진다).
//   index/total: 파일 순번과 개수. part/parts: 파일 안의 조각 순번과 개수. x, y: 놓은 자리(월드 좌표).
//   attempt: 같은 조각을 다시 보낼 때 값이 바뀌게 하는 번호. reduced: 큰 이미지를 줄인 사본이면 true.
// drop_ack = {batch, seq, ok, error?}

export const DROP_STATE = 'drop_inbox';
export const DROP_ACK = 'drop_ack';
export const CHUNK_BYTES = 16 * 1024;
export const CHUNK_B64_MAX = Math.ceil(CHUNK_BYTES / 3) * 4;
export const DROP_MAX_BYTES = 8 * 1024 * 1024;
export const WINDOW_STATE_MAX_BYTES = 64 * 1024;
// sandbox가 보는 키만으로 셀 때의 한도. 못 보는 키(client가 쓰는 draft 등)에 STATE_RESERVE를 남긴다.
export const STATE_RESERVE = 16 * 1024;
export const SANDBOX_STATE_LIMIT = WINDOW_STATE_MAX_BYTES - STATE_RESERVE;
const CASCADE_PX = 24;
const CARD_W = 240;
const CARD_H = 180;

// file_drop과 같은 받는 형식(scripts/gen-app.mjs의 accept).
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/mp4',
};

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

// 받는 파일이면 mime, 아니면 null. mime이 비었거나 octet-stream이면 확장자로 정한다(macOS Finder).
// file_drop처럼 image/*는 목록의 확장자만, 영상은 mp4와 m4v만 받는다.
export function dropMime(name, type) {
  const ext = extOf(name);
  const byExt = EXT_MIME[ext] ?? null;
  const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
  if (!t || t === 'application/octet-stream') return byExt;
  if (t.startsWith('image/')) return byExt && byExt.startsWith('image/') ? t : null;
  if (t === 'video/mp4' || t === 'video/x-m4v') return byExt === 'video/mp4' ? 'video/mp4' : null;
  return null;
}

export function isImageMime(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}

// --- base64 ---

export function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// --- 조각 ---

export function chunkCount(size, chunk = CHUNK_BYTES) {
  return Math.max(1, Math.ceil(Math.max(0, size) / chunk));
}

// 파일 하나의 조각 범위 [{part, start, end}]. 빈 파일도 조각 하나를 보낸다.
export function chunkRanges(size, chunk = CHUNK_BYTES) {
  const parts = chunkCount(size, chunk);
  const out = [];
  for (let part = 0; part < parts; part++) {
    out.push({ part, start: part * chunk, end: Math.min(size, (part + 1) * chunk) });
  }
  return out;
}

// files = [{name, mime, size, reduced?}] -> 조각마다 b64를 뺀 drop_inbox 값과 읽을 범위 [{...msg, start, end}].
export function chunkPlan(batch, files, at, chunk = CHUNK_BYTES) {
  const out = [];
  let seq = 0;
  files.forEach((f, index) => {
    const size = Math.max(0, f.size | 0);
    const ranges = chunkRanges(size, chunk);
    for (const r of ranges) {
      out.push({
        batch, seq: seq++, attempt: 0, index, total: files.length,
        name: f.name, mime: f.mime, size, part: r.part, parts: ranges.length,
        x: at.x, y: at.y, reduced: !!f.reduced, start: r.start, end: r.end,
      });
    }
  });
  return out;
}

const toMessage = ({ start, end, ...h }, bytes) => {
  const { x, y, reduced, ...head } = h;
  return { ...head, b64: bytesToB64(bytes), x, y, reduced };
};

// 보낼 drop_inbox 값을 하나씩 낸다. 다음 값을 달라고 할 때 그 조각만 읽는다.
// read(file, start, end) -> Promise<Uint8Array>(브라우저에서는 file.slice(start, end).arrayBuffer()).
export async function* streamMessages(batch, files, at, read, chunk = CHUNK_BYTES) {
  for (const h of chunkPlan(batch, files, at, chunk)) {
    const raw = await read(files[h.index], h.start, h.end);
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.length !== h.end - h.start) throw Object.assign(new Error('read'), { code: 'read' });
    yield toMessage(h, bytes);
  }
}

// files = [{name, mime, bytes(Uint8Array), reduced?}] -> 보낼 drop_inbox 값의 목록(attempt 0). 시험과 작은 값용.
export function chunkMessages(batch, files, at, chunk = CHUNK_BYTES) {
  const sized = files.map((f) => ({ ...f, size: f.bytes.length }));
  return chunkPlan(batch, sized, at, chunk).map((h) => toMessage(h, files[h.index].bytes.subarray(h.start, h.end)));
}

// 다른 키와 합친 창 상태가 한도 안인가(쓰기 전에 sandbox가 본다).
export function stateFits(state, limit = WINDOW_STATE_MAX_BYTES) {
  return new TextEncoder().encode(JSON.stringify(state)).length <= limit;
}

// 붙여 넣은 글을 paste_inbox에 쓸 값. 보이는 창 상태(state, 옛 paste_inbox는 바뀌므로 뺀다)와 합쳐
// SANDBOX_STATE_LIMIT를 넘으면 null(쓰면 패치 전체가 거부된다).
export function pasteValue(state, text, n, limit = SANDBOX_STATE_LIMIT) {
  const value = { text, n };
  return stateFits({ ...(state ?? {}), paste_inbox: value }, limit) ? value : null;
}

// 보내는 중이 아닌데 drop_inbox에 값이 남아 있는가(창이 옮기는 도중에 닫혀 비우기를 못 한 경우).
export function leftoverInbox(value, busy) {
  return value != null && !busy;
}

// 옮기기가 실패했을 때 보일 글. code: state_full | timeout | read | 받는 쪽 거부 코드.
export function dropErrorText(code) {
  if (code === 'state_full') return '창 상태가 가득 차 파일을 옮기지 못했어요. 긴 글을 줄이거나 파일 추가 단추를 써 주세요';
  if (code === 'timeout') {
    return '파일을 옮기지 못했어요. 받았다는 응답이 없어요(창 상태가 가득 찼을 수 있어요). '
      + '다시 끌어 놓거나 파일 추가 단추를 써 주세요';
  }
  if (code === 'read') return '파일을 읽지 못했어요(옮기는 동안 바뀌었을 수 있어요). 다시 끌어 놓아 주세요';
  return '파일을 옮기지 못했어요. 파일 추가 단추를 써 주세요';
}

// --- 받는 쪽 ---

const isInt = (v) => Number.isInteger(v) && v >= 0;

function validMessage(m) {
  return m && typeof m === 'object' && typeof m.batch === 'string' && isInt(m.seq) && isInt(m.index)
    && isInt(m.total) && m.index < m.total && isInt(m.part) && isInt(m.parts) && m.part < m.parts
    && isInt(m.size) && typeof m.name === 'string' && typeof m.mime === 'string' && typeof m.b64 === 'string'
    && m.b64.length <= CHUNK_B64_MAX && Number.isFinite(m.x) && Number.isFinite(m.y);
}

// client가 drop_inbox를 받아 파일로 모은다. receive(msg) -> {ack, file?} | null.
//   ack은 drop_ack에 쓸 값이다. 같은 조각이 다시 오면(받음을 놓친 경우) 다시 받았다고 알린다.
//   file = {batch, index, total, name, mime, bytes, x, y, reduced}: 파일의 마지막 조각이 오면 한 번.
// initial: 창을 다시 열 때 남아 있던 값. 그 batch는 받지 않는다.
export function createReceiver({ initial, maxBytes = DROP_MAX_BYTES } = {}) {
  const stale = initial && typeof initial === 'object' ? initial.batch : undefined;
  let cur = null; // {batch, seq(다음에 받을 순번), index, parts: Uint8Array[], size, name, mime}
  let lastAck = null;
  let failed = null; // 실패한 batch

  const reply = (m, ok, error) => {
    lastAck = { batch: m.batch, seq: m.seq, ok, ...(error ? { error } : {}) };
    return { ack: lastAck };
  };

  return {
    receive(m) {
      if (!m || typeof m !== 'object' || m.batch === stale) return null;
      if (!validMessage(m)) return typeof m.batch === 'string' && isInt(m.seq) ? reply(m, false, 'invalid') : null;
      if (m.batch === failed) return reply(m, false, 'failed');
      // 이미 받은 조각(받음이 늦게 갔거나 다시 보낸 것)
      if (lastAck && lastAck.batch === m.batch && lastAck.seq === m.seq) return { ack: { ...lastAck } };
      if (!cur || cur.batch !== m.batch) {
        if (m.seq !== 0) { failed = m.batch; return reply(m, false, 'order'); }
        cur = { batch: m.batch, seq: 0, index: -1 };
      }
      if (m.seq !== cur.seq) { failed = m.batch; cur = null; return reply(m, false, 'order'); }
      if (m.part === 0) {
        if (m.size > maxBytes) { failed = m.batch; cur = null; return reply(m, false, 'too_large'); }
        Object.assign(cur, { index: m.index, chunks: [], got: 0, size: m.size, name: m.name, mime: m.mime });
      } else if (m.index !== cur.index || m.size !== cur.size) {
        failed = m.batch; cur = null; return reply(m, false, 'order');
      }
      let bytes;
      try { bytes = b64ToBytes(m.b64); } catch { failed = m.batch; cur = null; return reply(m, false, 'invalid'); }
      cur.chunks.push(bytes);
      cur.got += bytes.length;
      cur.seq += 1;
      if (cur.got > cur.size) { failed = m.batch; cur = null; return reply(m, false, 'size'); }
      if (m.part < m.parts - 1) return reply(m, true);
      if (cur.got !== cur.size) { failed = m.batch; cur = null; return reply(m, false, 'size'); }
      const all = new Uint8Array(cur.size);
      let off = 0;
      for (const c of cur.chunks) { all.set(c, off); off += c.length; }
      const file = {
        batch: m.batch, index: m.index, total: m.total, name: cur.name, mime: cur.mime,
        bytes: all, x: m.x, y: m.y, reduced: !!m.reduced,
      };
      cur.chunks = [];
      return { ...reply(m, true), file };
    },
  };
}

// --- 보내는 쪽 ---

// sandbox가 조각 하나를 쓰고 그 조각의 drop_ack을 기다린다.
// deps = {write(msg), setTimer(fn, ms) -> id, clearTimer(id)}. 받음이 timeoutMs 안에 오지 않으면 attempt를 올려
// 다시 쓰고(같은 값이면 상태 변화가 일어나지 않으므로), retries번 넘게 실패하면 거부한다.
export function createAckChannel({ write, setTimer, clearTimer, timeoutMs = 8000, retries = 3 }) {
  let waiting = null; // {msg, resolve, reject, tries, timer}

  const arm = () => {
    const w = waiting;
    w.timer = setTimer(() => {
      if (waiting !== w) return;
      if (w.tries >= retries) { waiting = null; w.reject(new Error('timeout')); return; }
      w.tries += 1;
      w.msg = { ...w.msg, attempt: w.tries };
      write(w.msg);
      arm();
    }, timeoutMs);
  };

  return {
    send(msg) {
      if (waiting) return Promise.reject(new Error('busy'));
      return new Promise((resolve, reject) => {
        waiting = { msg, resolve, reject, tries: 0, timer: 0 };
        write(msg);
        arm();
      });
    },
    onAck(ack) {
      const w = waiting;
      if (!w || !ack || ack.batch !== w.msg.batch || ack.seq !== w.msg.seq) return;
      waiting = null;
      clearTimer(w.timer);
      if (ack.ok) w.resolve(ack);
      else w.reject(Object.assign(new Error(String(ack.error ?? 'rejected')), { code: ack.error }));
    },
    cancel() {
      const w = waiting;
      if (!w) return;
      waiting = null;
      clearTimer(w.timer);
      w.reject(new Error('cancelled'));
    },
    get busy() { return !!waiting; },
  };
}

// --- 자리와 글 ---

// 프레임의 client 좌표 -> 월드 좌표. view = {x, y, scale}(화면 = (월드 − view.xy) × scale), rect = 캔버스 자리.
export function clientToWorld(view, rect, clientX, clientY) {
  const sx = clientX - (rect?.left ?? 0);
  const sy = clientY - (rect?.top ?? 0);
  return { x: sx / view.scale + view.x, y: sy / view.scale + view.y };
}

// 놓은 자리(월드)에 카드 가운데가 오게 하고, 여러 장이면 조금씩 비껴 놓는다. 카드의 왼쪽 위를 돌려준다.
export function dropPlacement(at, index, w = CARD_W, h = CARD_H) {
  const d = (index | 0) * CASCADE_PX;
  return { x: at.x - w / 2 + d, y: at.y - h / 2 + d };
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1);

export function progressText(sentBytes, totalBytes, fileIndex, fileTotal) {
  const files = fileTotal > 1 ? ` ${fileIndex + 1}/${fileTotal}` : '';
  const pct = totalBytes > 0 ? Math.min(100, Math.floor((sentBytes / totalBytes) * 100)) : 100;
  return `파일 옮기는 중${files} · ${pct}% (${mb(sentBytes)}/${mb(totalBytes)}MB)`;
}

// 놓은 파일 목록을 받을 것과 못 받을 것으로 나눈다. files = [{name, type, size, directory?}].
// 결과: {accepted: [{i, name, mime, size, big}], rejected: [name], directories: n}
//   big: DROP_MAX_BYTES를 넘는다. 이미지는 줄인 사본으로, 영상은 파일 추가 안내로 처리한다.
export function sortDrop(files, maxBytes = DROP_MAX_BYTES) {
  const accepted = [];
  const rejected = [];
  let directories = 0;
  (files ?? []).forEach((f, i) => {
    if (!f) return;
    if (f.directory) { directories += 1; return; }
    const mime = dropMime(f.name, f.type);
    if (!mime) { rejected.push(String(f.name ?? '')); return; }
    accepted.push({ i, name: String(f.name ?? ''), mime, size: f.size | 0, big: f.size > maxBytes });
  });
  return { accepted, rejected, directories };
}

// 줄인 사본의 이름: 확장자를 .jpg로 바꾼다.
export function reducedName(name) {
  const s = String(name ?? '');
  return /\.[A-Za-z0-9]+$/.test(s) ? s.replace(/\.[A-Za-z0-9]+$/, '.jpg') : `${s}.jpg`;
}

// 보드(sandbox) 위에 Finder에서 끌어 놓은 파일을 받는다. 순수 부분은 ../dropxfer.js에 있다.
//
// 보드는 iframe이라 쉘의 drag guard가 보드 위의 drop을 받지 못한다. 여기서 dragover와 drop을 막고(preventDefault)
// File을 조각마다 slice로 읽어(한 번에 한 조각만 메모리에) 창 상태 drop_inbox에 쓴다. client가 drop_ack로
// 받았다고 알리면 다음 조각을 읽어 쓴다. 창이 옮기는 도중에 닫혀 남은 조각은 다음에 열 때 비운다.
// client는 조각을 모아 blobs에 넣고 file_drop과 같은 넣기(썸네일, 카드)를 돌려 놓은 자리에 카드를 둔다.
// DROP_MAX_BYTES를 넘는 이미지는 여기서 줄인 JPEG 사본을 만들어 보내고, 영상은 파일 추가 단추를 안내한다.

import {
  DROP_STATE, DROP_ACK, DROP_MAX_BYTES, CHUNK_BYTES, SANDBOX_STATE_LIMIT, sortDrop, streamMessages, createAckChannel,
  clientToWorld, progressText, reducedName, stateFits, dropErrorText, leftoverInbox,
} from '../dropxfer.js';

const PROGRESS_FROM = 4 * CHUNK_BYTES; // 이보다 크면 옮기는 동안 진행 글을 보인다
const REDUCE_STEPS = [{ side: 2560, quality: 0.85 }, { side: 1600, quality: 0.8 }, { side: 1024, quality: 0.75 }];
const MAX_MB = Math.round(DROP_MAX_BYTES / (1024 * 1024));

const withNote = (text, note) => (note ? `${text} · ${note}` : text);
const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files');

// deps = {k, canvas, getView() -> {x, y, scale}, showToast(text), accent() -> css 색}
export function installDrop({ k, canvas, getView, showToast, accent }) {
  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;align-items:center;'
    + 'justify-content:center;font:14px system-ui,-apple-system,sans-serif;border-radius:2px';
  const label = document.createElement('div');
  label.textContent = '여기에 놓으면 보드에 넣어요';
  label.style.cssText = 'padding:6px 12px;border-radius:6px;color:#fff';
  overlay.append(label);
  document.body.append(overlay);

  let hideTimer = 0;
  const show = (on) => {
    clearTimeout(hideTimer);
    if (on) {
      const c = accent();
      overlay.style.outline = `2px dashed ${c}`;
      overlay.style.outlineOffset = '-6px';
      overlay.style.background = `color-mix(in srgb, ${c} 12%, transparent)`;
      label.style.background = c;
      overlay.style.display = 'flex';
    } else overlay.style.display = 'none';
  };

  const channel = createAckChannel({
    write: (msg) => {
      // 다른 키와 합친 창 상태가 한도를 넘으면 쓰기 전체가 거부되므로 미리 본다. 보드는 자기 키만 보므로
      // 못 보는 키(draft 등)에 자리를 남긴 SANDBOX_STATE_LIMIT로 센다. 그래도 넘치면 받음이 오지 않아 timeout이 된다.
      if (!stateFits({ ...k.getState(), [DROP_STATE]: msg }, SANDBOX_STATE_LIMIT)) {
        setTimeout(() => channel.onAck({ batch: msg.batch, seq: msg.seq, ok: false, error: 'state_full' }), 0);
        return;
      }
      k.setState(DROP_STATE, msg);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
  });
  const queue = [];
  let running = false;

  // 창이 옮기는 도중에 닫히면 finally의 비우기가 돌지 않아 조각(약 22KB)이 창 상태에 남는다. 이 프레임이 보내는
  // 중이 아닐 때 남은 값을 보면 비운다. client는 null을 받지 않고 넘긴다(createReceiver).
  const sweep = (v) => { if (leftoverInbox(v, running || queue.length > 0)) k.setState(DROP_STATE, null); };
  sweep(k.getState(DROP_STATE));
  k.onStateChange((state) => {
    channel.onAck(state?.[DROP_ACK]);
    if (state && DROP_STATE in state) sweep(state[DROP_STATE]);
  });

  async function runQueue() {
    if (running) return;
    running = true;
    try {
      while (queue.length) await sendBatch(queue.shift());
    } finally {
      running = false;
    }
  }

  async function sendBatch({ files, at, note }) {
    const batch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const total = files.reduce((n, f) => n + f.size, 0);
    const read = async (f, start, end) => new Uint8Array(await f.blob.slice(start, end).arrayBuffer());
    let sent = 0;
    try {
      for await (const msg of streamMessages(batch, files, at, read)) {
        if (total > PROGRESS_FROM) showToast(withNote(progressText(sent, total, msg.index, msg.total), note));
        await channel.send(msg);
        sent += Math.floor((msg.b64.length * 3) / 4);
      }
      if (total > PROGRESS_FROM) showToast(withNote(progressText(total, total, files.length - 1, files.length), note));
    } catch (err) {
      showToast(dropErrorText(err?.code ?? err?.message));
    } finally {
      k.setState(DROP_STATE, null); // 조각이 창 상태 자리를 차지하지 않게 비운다
    }
  }

  // 보낼 파일 목록 [{name, mime, size, blob, reduced?}]. 원본은 File 그대로 두고 보낼 때 조각만 읽는다.
  async function readFiles(picked, list) {
    const out = [];
    const notes = [];
    for (const a of picked) {
      const file = list[a.i];
      try {
        if (!a.big) {
          out.push({ name: a.name, mime: a.mime, size: file.size, blob: file });
          continue;
        }
        if (a.mime.startsWith('image/')) {
          const small = await reduceImage(file);
          if (small) {
            out.push({ name: reducedName(a.name), mime: 'image/jpeg', size: small.size, blob: small, reduced: true });
            continue;
          }
        }
        notes.push(a.name);
      } catch {
        notes.push(a.name);
      }
    }
    return { out, notes };
  }

  async function onDrop(e) {
    const dt = e.dataTransfer;
    const list = Array.from(dt.files ?? []);
    // 폴더는 items에서만 알 수 있고, 이벤트가 끝나기 전에 읽어야 한다.
    const items = Array.from(dt.items ?? []).filter((it) => it.kind === 'file');
    const dirs = new Set();
    items.forEach((it, i) => { try { if (it.webkitGetAsEntry?.()?.isDirectory) dirs.add(i); } catch { /* 없음 */ } });
    const at = clientToWorld(getView(), canvas.getBoundingClientRect(), e.clientX, e.clientY);
    const sorted = sortDrop(list.map((f, i) => ({ name: f.name, type: f.type, size: f.size, directory: dirs.has(i) })));
    const { out, notes } = await readFiles(sorted.accepted, list);
    const msgs = [];
    if (sorted.directories) msgs.push('폴더는 넣을 수 없어요. 안의 파일을 골라 끌어 주세요');
    if (sorted.rejected.length) msgs.push(`넣을 수 없는 형식이에요: ${sorted.rejected.join(', ')}`);
    if (notes.length) msgs.push(`${MAX_MB}MB가 넘는 파일은 파일 추가 단추로 넣어 주세요: ${notes.join(', ')}`);
    if (out.some((f) => f.reduced)) msgs.push(`${MAX_MB}MB가 넘는 이미지는 줄인 사본으로 넣어요. 원본은 파일 추가 단추로 넣어 주세요`);
    const note = msgs.join(' · ');
    if (note) showToast(note);
    if (!out.length) return;
    // 진행 글이 안내를 덮지 않게 함께 보인다.
    queue.push({ files: out, at, note });
    runQueue();
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    show(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    show(true);
    // dragleave가 오지 않고 끝나는 경우(창 밖에서 놓기)를 위해 잠시 뒤 끈다.
    hideTimer = setTimeout(() => show(false), 400);
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (!e.relatedTarget || !document.documentElement.contains(e.relatedTarget)) show(false);
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    show(false);
    onDrop(e).catch(() => showToast('파일을 읽지 못했어요'));
  });
  window.addEventListener('blur', () => show(false));

  return { overlay, get busy() { return running; } };
}

// 큰 이미지를 긴 변 2560px부터 줄여 DROP_MAX_BYTES 안의 JPEG Blob으로 만든다. 열 수 없으면 null.
async function reduceImage(file) {
  const bmp = await createImageBitmap(file);
  try {
    for (const { side, quality } of REDUCE_STEPS) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k));
      const h = Math.max(1, Math.round(bmp.height * k));
      const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const blob = c.convertToBlob
        ? await c.convertToBlob({ type: 'image/jpeg', quality })
        : await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
      if (blob && blob.size <= DROP_MAX_BYTES) return blob;
    }
    return null;
  } finally {
    bmp.close?.();
  }
}

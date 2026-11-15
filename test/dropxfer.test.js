import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropMime, chunkCount, chunkRanges, chunkMessages, createReceiver, createAckChannel, clientToWorld,
  dropPlacement, progressText, sortDrop, reducedName, bytesToB64, b64ToBytes, stateFits,
  CHUNK_BYTES, CHUNK_B64_MAX, DROP_MAX_BYTES, WINDOW_STATE_MAX_BYTES,
} from '../src/dropxfer.js';
import { toWorld } from '../src/layout.js';

const bytesOf = (n, seed = 1) => {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255;
  return u;
};
const AT = { x: 120, y: -40 };

// --- 형식 ---

test('dropMime: mime이 비었거나 octet-stream이면 확장자로 정한다', () => {
  assert.equal(dropMime('a.PNG', ''), 'image/png');
  assert.equal(dropMime('a.jpeg', 'application/octet-stream'), 'image/jpeg');
  assert.equal(dropMime('clip.m4v', ''), 'video/mp4');
  assert.equal(dropMime('photo.HEIC', ''), 'image/heic');
});

test('dropMime: file_drop과 같은 형식만 받는다', () => {
  assert.equal(dropMime('a.png', 'image/png'), 'image/png');
  assert.equal(dropMime('clip.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(dropMime('clip.m4v', 'video/x-m4v'), 'video/mp4');
  assert.equal(dropMime('a.svg', 'image/svg+xml'), null);
  assert.equal(dropMime('a.tiff', ''), null);
  assert.equal(dropMime('doc.pdf', 'application/pdf'), null);
  assert.equal(dropMime('clip.mov', 'video/quicktime'), null);
  assert.equal(dropMime('noext', ''), null);
});

test('sortDrop: 폴더, 못 받는 형식, 큰 파일을 나눈다', () => {
  const r = sortDrop([
    { name: 'a.png', type: '', size: 10 },
    { name: 'Folder', type: '', size: 0, directory: true },
    { name: 'b.pdf', type: 'application/pdf', size: 5 },
    { name: 'big.jpg', type: 'image/jpeg', size: DROP_MAX_BYTES + 1 },
  ]);
  assert.equal(r.directories, 1);
  assert.deepEqual(r.rejected, ['b.pdf']);
  assert.deepEqual(r.accepted.map((a) => [a.i, a.mime, a.big]), [[0, 'image/png', false], [3, 'image/jpeg', true]]);
});

test('reducedName: 확장자를 .jpg로', () => {
  assert.equal(reducedName('x.heic'), 'x.jpg');
  assert.equal(reducedName('x'), 'x.jpg');
});

// --- 조각 ---

test('base64 왕복', () => {
  const b = bytesOf(70000);
  assert.deepEqual(b64ToBytes(bytesToB64(b)), b);
  assert.equal(bytesToB64(new Uint8Array(0)), '');
});

test('chunkRanges: 경계와 빈 파일', () => {
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkCount(CHUNK_BYTES), 1);
  assert.equal(chunkCount(CHUNK_BYTES + 1), 2);
  assert.deepEqual(chunkRanges(0), [{ part: 0, start: 0, end: 0 }]);
  assert.deepEqual(chunkRanges(25, 10), [
    { part: 0, start: 0, end: 10 }, { part: 1, start: 10, end: 20 }, { part: 2, start: 20, end: 25 },
  ]);
});

test('조각 하나와 다른 창 상태를 합쳐도 64KiB 안이다', () => {
  const [m] = chunkMessages('b', [{ name: 'a'.repeat(200) + '.png', mime: 'image/png', bytes: bytesOf(CHUNK_BYTES) }], AT);
  assert.equal(m.b64.length, CHUNK_B64_MAX);
  const json = JSON.stringify({ drop_inbox: m });
  assert.ok(json.length < WINDOW_STATE_MAX_BYTES / 2 + 1024, `조각 JSON ${json.length}`);
  assert.ok(stateFits({ drop_inbox: m, view: { cx: 1, cy: 2, scale: 1 }, paste_inbox: { text: 'x'.repeat(20000), n: 1 } }));
  assert.ok(!stateFits({ drop_inbox: m, paste_inbox: { text: 'x'.repeat(40000), n: 1 } }));
});

test('chunkMessages: seq는 파일을 넘어 이어지고 part는 파일마다 0부터', () => {
  const msgs = chunkMessages('b1', [
    { name: 'a.png', mime: 'image/png', bytes: bytesOf(25) },
    { name: 'b.png', mime: 'image/png', bytes: bytesOf(5), reduced: true },
  ], AT, 10);
  assert.deepEqual(msgs.map((m) => [m.seq, m.index, m.part, m.parts]), [[0, 0, 0, 3], [1, 0, 1, 3], [2, 0, 2, 3], [3, 1, 0, 1]]);
  assert.ok(msgs.every((m) => m.total === 2 && m.x === AT.x && m.y === AT.y && m.attempt === 0));
  assert.equal(msgs[3].reduced, true);
});

// --- 받기 ---

function deliver(rx, msgs) {
  const files = [];
  const acks = [];
  for (const m of msgs) {
    const r = rx.receive(m);
    acks.push(r?.ack);
    if (r?.file) files.push(r.file);
  }
  return { files, acks };
}

test('createReceiver: 조각을 모아 같은 바이트로 되돌린다(파일 둘, 여러 조각)', () => {
  const a = bytesOf(CHUNK_BYTES * 2 + 17, 3);
  const b = bytesOf(100, 9);
  const msgs = chunkMessages('b1', [
    { name: 'a.png', mime: 'image/png', bytes: a }, { name: 'b.jpg', mime: 'image/jpeg', bytes: b },
  ], AT);
  const { files, acks } = deliver(createReceiver(), msgs);
  assert.ok(acks.every((k, i) => k.ok && k.seq === i && k.batch === 'b1'));
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].bytes, a);
  assert.deepEqual(files[1].bytes, b);
  assert.deepEqual([files[1].name, files[1].mime, files[1].index, files[1].total, files[1].x, files[1].y], ['b.jpg', 'image/jpeg', 1, 2, AT.x, AT.y]);
});

test('createReceiver: 같은 조각이 다시 오면(attempt만 다름) 다시 받았다고 하고 두 번 붙이지 않는다', () => {
  const data = bytesOf(25);
  const msgs = chunkMessages('b2', [{ name: 'a.png', mime: 'image/png', bytes: data }], AT, 10);
  const rx = createReceiver();
  rx.receive(msgs[0]);
  const again = rx.receive({ ...msgs[0], attempt: 1 });
  assert.deepEqual(again.ack, { batch: 'b2', seq: 0, ok: true });
  assert.equal(again.file, undefined);
  rx.receive(msgs[1]);
  const last = rx.receive(msgs[2]);
  assert.deepEqual(last.file.bytes, data);
});

test('createReceiver: 창을 다시 열 때 남은 batch와 null은 받지 않는다', () => {
  const [m] = chunkMessages('old', [{ name: 'a.png', mime: 'image/png', bytes: bytesOf(3) }], AT);
  const rx = createReceiver({ initial: m });
  assert.equal(rx.receive(m), null);
  assert.equal(rx.receive(null), null);
});

test('createReceiver: 순서가 어긋나거나 크기가 틀리면 거부하고 그 batch는 끝낸다', () => {
  const msgs = chunkMessages('b3', [{ name: 'a.png', mime: 'image/png', bytes: bytesOf(25) }], AT, 10);
  const rx = createReceiver();
  rx.receive(msgs[0]);
  const skip = rx.receive(msgs[2]);
  assert.equal(skip.ack.ok, false);
  assert.equal(skip.ack.error, 'order');
  assert.equal(rx.receive({ ...msgs[1] }).ack.error, 'failed');

  const bad = chunkMessages('b4', [{ name: 'a.png', mime: 'image/png', bytes: bytesOf(5) }], AT)[0];
  const r = createReceiver().receive({ ...bad, size: 6 });
  assert.equal(r.ack.error, 'size');
  assert.equal(createReceiver({ maxBytes: 4 }).receive(bad).ack.error, 'too_large');
  assert.equal(createReceiver().receive({ ...bad, b64: 'x'.repeat(CHUNK_B64_MAX + 4) }).ack.error, 'invalid');
});

test('createReceiver: 새 batch는 처음부터 다시 모은다', () => {
  const rx = createReceiver();
  const one = chunkMessages('p', [{ name: 'a.png', mime: 'image/png', bytes: bytesOf(25) }], AT, 10);
  rx.receive(one[0]); // 끝나지 않은 batch
  const two = chunkMessages('q', [{ name: 'b.png', mime: 'image/png', bytes: bytesOf(4) }], AT);
  const r = rx.receive(two[0]);
  assert.equal(r.ack.ok, true);
  assert.deepEqual(r.file.bytes, bytesOf(4));
});

// --- 보내기 ---

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { timers.set(++id, fn); return id; },
    clearTimer: (i) => timers.delete(i),
    fire() { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); },
    get size() { return timers.size; },
  };
}

test('createAckChannel: 받음이 오면 끝나고, 다른 seq의 받음은 무시한다', async () => {
  const t = fakeTimers();
  const written = [];
  const ch = createAckChannel({ write: (m) => written.push(m), ...t });
  const p = ch.send({ batch: 'b', seq: 0, attempt: 0 });
  assert.equal(ch.busy, true);
  ch.onAck({ batch: 'b', seq: 1, ok: true });
  ch.onAck({ batch: 'x', seq: 0, ok: true });
  assert.equal(ch.busy, true);
  ch.onAck({ batch: 'b', seq: 0, ok: true });
  await p;
  assert.equal(ch.busy, false);
  assert.equal(t.size, 0);
  assert.equal(written.length, 1);
});

test('createAckChannel: 시간이 지나면 attempt를 올려 다시 쓰고, 횟수를 넘으면 거부한다', async () => {
  const t = fakeTimers();
  const written = [];
  const ch = createAckChannel({ write: (m) => written.push(m), ...t, retries: 2 });
  const p = ch.send({ batch: 'b', seq: 0, attempt: 0 });
  t.fire();
  t.fire();
  assert.deepEqual(written.map((m) => m.attempt), [0, 1, 2]);
  t.fire();
  await assert.rejects(p, /timeout/);
});

test('createAckChannel: 거부 받음은 code를 실어 거부한다', async () => {
  const t = fakeTimers();
  const ch = createAckChannel({ write: () => {}, ...t });
  const p = ch.send({ batch: 'b', seq: 0 });
  ch.onAck({ batch: 'b', seq: 0, ok: false, error: 'too_large' });
  await assert.rejects(p, (e) => e.code === 'too_large');
});

test('보내기와 받기를 이으면 파일이 그대로 온다', async () => {
  const t = fakeTimers();
  const rx = createReceiver();
  const files = [];
  let ch;
  const write = (m) => queueMicrotask(() => {
    const r = rx.receive(JSON.parse(JSON.stringify(m))); // 창 상태처럼 JSON을 거친다
    if (r?.file) files.push(r.file);
    if (r) ch.onAck(r.ack);
  });
  ch = createAckChannel({ write, ...t });
  const data = bytesOf(CHUNK_BYTES * 3 + 5, 7);
  for (const m of chunkMessages('z', [{ name: 'p.png', mime: 'image/png', bytes: data }], AT)) await ch.send(m);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].bytes, data);
});

// --- 자리 ---

test('clientToWorld: 캔버스 자리를 빼고 layout.toWorld와 같다', () => {
  const view = { x: 100, y: 50, scale: 2 };
  const rect = { left: 10, top: 20 };
  const w = clientToWorld(view, rect, 310, 220);
  assert.deepEqual(w, toWorld(view, { x: 300, y: 200 }));
  assert.deepEqual(w, { x: 250, y: 150 });
  assert.deepEqual(clientToWorld({ x: 0, y: 0, scale: 1 }, null, 5, 6), { x: 5, y: 6 });
});

test('dropPlacement: 카드 가운데가 놓은 자리, 여러 장은 24px씩 비낀다', () => {
  assert.deepEqual(dropPlacement({ x: 500, y: 300 }, 0), { x: 380, y: 210 });
  assert.deepEqual(dropPlacement({ x: 500, y: 300 }, 2), { x: 428, y: 258 });
});

test('progressText', () => {
  assert.equal(progressText(512 * 1024, 2 * 1024 * 1024, 0, 1), '파일 옮기는 중 · 25% (0.5/2.0MB)');
  assert.equal(progressText(0, 1024 * 1024, 1, 3), '파일 옮기는 중 2/3 · 0% (0.0/1.0MB)');
});

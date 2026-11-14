import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGate, retryDelay, retryRead, createSaver } from '../src/startup.js';

const tick = () => new Promise((r) => setImmediate(r));

test('createGate: 열기 전 run은 기다렸다가 순서대로, 연 뒤에는 바로', async () => {
  const g = createGate();
  const log = [];
  const p1 = g.run(() => log.push(1));
  const p2 = g.run(() => log.push(2));
  await tick();
  assert.deepEqual(log, []);
  assert.equal(g.isOpen, false);
  g.open();
  await Promise.all([p1, p2]);
  assert.deepEqual(log, [1, 2]);
  assert.equal(await g.run(() => 'x'), 'x');
});

test('retryDelay: 1s, 2s, 4s, 그다음 10s마다', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelay), [1000, 2000, 4000, 10000, 10000, 10000]);
});

test('retryRead: 실패하면 지연을 두고 다시 읽고, 성공하면 값을 돌려준다', async () => {
  const delays = [];
  let n = 0;
  const fails = [];
  const r = await retryRead(async () => { if (n++ < 4) throw new Error('e' + n); return 'ok'; }, {
    sleep: async (ms) => { delays.push(ms); },
    onFail: (e, attempt) => fails.push([e.message, attempt]),
  });
  assert.deepEqual(r, { value: 'ok' });
  assert.deepEqual(delays, [1000, 2000, 4000, 10000]);
  assert.deepEqual(fails, [['e1', 0], ['e2', 1], ['e3', 2], ['e4', 3]]);
});

test('retryRead: stop이 참이면 더 읽지 않는다', async () => {
  let reads = 0, stop = false;
  const r = await retryRead(async () => { reads++; stop = true; throw new Error('x'); }, { sleep: async () => {}, stop: () => stop });
  assert.deepEqual(r, { stopped: true });
  assert.equal(reads, 1);
});

// 가짜 타이머.
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: (t) => { timers.delete(t); },
    fire() { const all = [...timers]; timers.clear(); for (const [, t] of all) t.fn(); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('createSaver: schedule은 디바운스하고 마지막 지연을 쓴다', async () => {
  const t = fakeTimers();
  let saves = 0;
  const s = createSaver(async () => { saves++; }, t);
  s.schedule(400);
  s.schedule(400);
  assert.equal(t.timers.size, 1);
  assert.equal([...t.timers.values()][0].ms, 400);
  t.fire();
  await tick();
  assert.equal(saves, 1);
});

test('createSaver: flush는 기다리는 타이머를 지우고 바로 저장한다', async () => {
  const t = fakeTimers();
  let saves = 0;
  const s = createSaver(async () => { saves++; }, t);
  s.schedule(400);
  await s.flush();
  assert.equal(saves, 1);
  assert.equal(t.timers.size, 0);
  await s.flush();
  assert.equal(saves, 1); // 바뀐 것이 없으면 다시 저장하지 않는다
});

test('createSaver: 저장 중에 바뀌면 flush는 진행 중 저장을 기다린 뒤 한 번 더 저장한다', async () => {
  const t = fakeTimers();
  const gates = [deferred(), deferred()];
  let n = 0;
  const s = createSaver(() => gates[n++].promise, t);
  s.schedule(0);
  t.fire();
  await tick();
  assert.equal(n, 1);
  s.schedule(400); // 끌기를 놓은 직후 창을 닫는다
  const done = s.flush();
  let finished = false;
  done.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  gates[0].resolve();
  await tick();
  assert.equal(n, 2);
  assert.equal(finished, false);
  gates[1].resolve();
  await done;
  assert.equal(t.timers.size, 0);
});

test('createSaver: 저장 실패는 onError로 알리고 flush는 끝난다', async () => {
  const t = fakeTimers();
  const errs = [];
  const s = createSaver(async () => { throw new Error('boom'); }, { ...t, onError: (e) => errs.push(e.message) });
  s.schedule(0);
  await s.flush();
  assert.deepEqual(errs, ['boom']);
});

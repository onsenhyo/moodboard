import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeBoards, saveWithRetry, pruneTombstones, packThumbs, createThumbStore, isConflict,
} from '../src/store.js';

const CONFLICT = { code: 'conflict', id: 'STORAGE_ITEM_WRITE_CONFLICT' };
const TOO_LARGE = { id: 'STORAGE_WRITE_JSON_TOO_LARGE', code: 'invalid_request' };
const DAY = 24 * 3600 * 1000;

const card = (id, updatedAt, extra = {}) => ({ id, updatedAt, manual: { x: 0, y: 0, w: 10, h: 10 }, ...extra });
const board = (id, cards, updatedAt = 1, extra = {}) => ({ id, name: id, cards, updatedAt, ...extra });
const doc = (...boards) => ({ version: 1, boards });

// 가짜 어댑터: 값은 복사해 보관하고, conflicts 횟수만큼 set이 충돌한다.
function fakeAdapter(initial = {}, { conflicts = 0, onConflict } = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const a = {
    data, sets: [], gets: 0, conflicts,
    async get(entry) { a.gets++; return data.has(entry) ? structuredClone(data.get(entry)) : null; },
    async set(entry, value) {
      if (a.conflicts > 0) { a.conflicts--; onConflict?.(data); throw CONFLICT; }
      a.sets.push([entry, structuredClone(value)]);
      data.set(entry, structuredClone(value));
    },
  };
  return a;
}

const cardsOf = (d, boardId) => d.boards.find((b) => b.id === boardId).cards;
const cardIds = (d, boardId) => cardsOf(d, boardId).map((c) => c.id).sort();

// --- isConflict ---

test('isConflict은 code가 conflict일 때만 참', () => {
  assert.equal(isConflict(CONFLICT), true);
  assert.equal(isConflict(TOO_LARGE), false);
  assert.equal(isConflict(null), false);
  assert.equal(isConflict(undefined), false);
});

// --- mergeBoards ---

test('병합: 로컬과 원격의 새 카드가 둘 다 남는다', () => {
  const local = doc(board('b1', [card('a', 1), card('l', 5)]));
  const remote = doc(board('b1', [card('a', 1), card('r', 6)]));
  const m = mergeBoards(local, remote);
  assert.equal(m.version, 1);
  assert.deepEqual(cardIds(m, 'b1'), ['a', 'l', 'r']);
});

test('병합: 같은 카드를 양쪽에서 옮기면 updatedAt이 큰 쪽 좌표가 남는다', () => {
  const lc = card('a', 10, { manual: { x: 100, y: 100, w: 10, h: 10 } });
  const rc = card('a', 20, { manual: { x: 200, y: 200, w: 10, h: 10 } });
  const m1 = mergeBoards(doc(board('b1', [lc])), doc(board('b1', [rc])));
  assert.deepEqual(cardsOf(m1, 'b1')[0].manual, { x: 200, y: 200, w: 10, h: 10 });
  const m2 = mergeBoards(doc(board('b1', [rc])), doc(board('b1', [lc])));
  assert.deepEqual(cardsOf(m2, 'b1')[0].manual, { x: 200, y: 200, w: 10, h: 10 });
});

test('병합: 한쪽이 삭제했으면 묘비가 이긴다 (더 새로운 묘비, 같은 시각의 묘비)', () => {
  const live = card('a', 10);
  const newer = card('a', 11, { deleted: true });
  const tie = card('a', 10, { deleted: true });
  for (const [l, r] of [[live, newer], [newer, live], [live, tie], [tie, live]]) {
    const m = mergeBoards(doc(board('b1', [l])), doc(board('b1', [r])));
    assert.equal(cardsOf(m, 'b1').length, 1);
    assert.equal(cardsOf(m, 'b1')[0].deleted, true);
  }
});

test('병합: 묘비보다 나중에 고친 카드는 살아남는다', () => {
  const m = mergeBoards(doc(board('b1', [card('a', 10, { deleted: true })])), doc(board('b1', [card('a', 12)])));
  assert.equal(cardsOf(m, 'b1')[0].deleted, undefined);
});

test('병합: 보드도 id로 합치고, 보드 묘비가 이긴다', () => {
  const local = doc(board('b1', [], 5, { name: 'old' }), board('bl', [], 1));
  const remote = doc(board('b1', [], 9, { name: 'new' }), board('br', [], 1), board('bl', [], 1, { deleted: true }));
  const m = mergeBoards(local, remote);
  assert.deepEqual(m.boards.map((b) => b.id).sort(), ['b1', 'bl', 'br']);
  assert.equal(m.boards.find((b) => b.id === 'b1').name, 'new');
  assert.equal(m.boards.find((b) => b.id === 'bl').deleted, true);
});

test('병합: 보드 이름을 바꾼 쪽과 카드를 더한 쪽이 달라도 카드는 합쳐진다', () => {
  const local = doc(board('b1', [card('a', 1)], 9, { name: 'renamed' }));
  const remote = doc(board('b1', [card('a', 1), card('b', 3)], 2));
  const m = mergeBoards(local, remote);
  assert.equal(m.boards[0].name, 'renamed');
  assert.deepEqual(cardIds(m, 'b1'), ['a', 'b']);
});

test('병합: 입력을 바꾸지 않고, 비었거나 null인 문서를 받아 준다', () => {
  const local = doc(board('b1', [card('a', 1)]));
  const snapshot = structuredClone(local);
  const m = mergeBoards(local, null);
  assert.deepEqual(local, snapshot);
  assert.deepEqual(cardIds(m, 'b1'), ['a']);
  assert.deepEqual(mergeBoards(null, undefined), { version: 1, boards: [] });
});

// --- pruneTombstones ---

test('pruneTombstones: 30일 지난 묘비만 지운다', () => {
  const now = 100 * DAY;
  const d = doc(
    board('b1', [card('old', now - 31 * DAY, { deleted: true }), card('fresh', now - 29 * DAY, { deleted: true }), card('live', 0)]),
    board('bOld', [], now - 31 * DAY, { deleted: true }),
    board('bFresh', [], now - DAY, { deleted: true }),
  );
  const p = pruneTombstones(d, now);
  assert.deepEqual(p.boards.map((b) => b.id), ['b1', 'bFresh']);
  assert.deepEqual(cardIds(p, 'b1'), ['fresh', 'live']);
  assert.equal(d.boards.length, 3, '입력은 그대로');
  assert.deepEqual(pruneTombstones(d, now, 0.5 * DAY).boards.map((b) => b.id), ['b1']);
});

// --- saveWithRetry ---

test('saveWithRetry: 충돌이 없으면 읽고 mutate한 값을 한 번에 쓴다', async () => {
  const a = fakeAdapter({ boards: doc(board('b1', [])) });
  const out = await saveWithRetry(a, (d) => { d.boards[0].name = 'x'; return d; }, { now: () => 0 });
  assert.equal(out.boards[0].name, 'x');
  assert.equal(a.sets.length, 1);
  assert.equal(a.sets[0][0], 'boards');
  assert.deepEqual(a.data.get('boards'), out);
});

test('saveWithRetry: 항목이 비어 있으면 빈 문서에서 시작한다', async () => {
  const a = fakeAdapter();
  const out = await saveWithRetry(a, (d) => ({ ...d, boards: [...d.boards, board('n', [])] }), { now: () => 0 });
  assert.deepEqual(out, doc(board('n', [])));
});

test('saveWithRetry: 첫 쓰기가 conflict면 다시 읽고 병합한 값으로 두 번째에 성공한다', async () => {
  // 다른 PC가 그 사이 카드 r을 더했다.
  const a = fakeAdapter({ boards: doc(board('b1', [card('a', 1)])) }, {
    conflicts: 1,
    onConflict: (data) => data.set('boards', doc(board('b1', [card('a', 1), card('r', 2)]))),
  });
  const local = doc(board('b1', [card('a', 1), card('l', 3)]));
  const out = await saveWithRetry(a, (d) => d, { local, now: () => 0 });
  assert.equal(a.gets, 2);
  assert.equal(a.sets.length, 1);
  assert.deepEqual(cardIds(out, 'b1'), ['a', 'l', 'r']);
  assert.deepEqual(cardIds(a.data.get('boards'), 'b1'), ['a', 'l', 'r']);
});

test('saveWithRetry: 다시 읽은 문서에 mutate를 다시 적용한다', async () => {
  const a = fakeAdapter({ boards: doc(board('b1', [])) }, {
    conflicts: 1,
    onConflict: (data) => data.set('boards', doc(board('b1', []), board('b2', []))),
  });
  let calls = 0;
  const out = await saveWithRetry(a, (d) => { calls++; d.boards.push(board('mine', [])); return d; }, { now: () => 0 });
  assert.equal(calls, 2);
  assert.deepEqual(out.boards.map((b) => b.id), ['b1', 'b2', 'mine']);
});

test('saveWithRetry: 세 번 다 conflict면 마지막 에러를 던진다', async () => {
  const a = fakeAdapter({ boards: doc() }, { conflicts: 99 });
  await assert.rejects(saveWithRetry(a, (d) => d, { tries: 3 }), (e) => e === CONFLICT);
  assert.equal(a.gets, 3);
  assert.equal(a.sets.length, 0);
});

test('saveWithRetry: conflict가 아닌 에러는 바로 던진다', async () => {
  const a = fakeAdapter({ boards: doc() });
  a.set = async () => { a.setCalls = (a.setCalls ?? 0) + 1; throw TOO_LARGE; };
  await assert.rejects(saveWithRetry(a, (d) => d), (e) => e === TOO_LARGE);
  assert.equal(a.setCalls, 1);
});

test('saveWithRetry: 쓰기 전에 오래된 묘비를 정리한다', async () => {
  const now = 100 * DAY;
  const a = fakeAdapter({ boards: doc(board('b1', [card('gone', now - 31 * DAY, { deleted: true }), card('keep', 1)])) });
  const out = await saveWithRetry(a, (d) => d, { now: () => now });
  assert.deepEqual(cardIds(out, 'b1'), ['keep']);
  assert.deepEqual(cardIds(a.data.get('boards'), 'b1'), ['keep']);
});

test('saveWithRetry: entry 옵션으로 다른 항목에 쓴다', async () => {
  const a = fakeAdapter({ other: doc(board('o', [])) });
  const out = await saveWithRetry(a, (d) => d, { entry: 'other', now: () => 0 });
  assert.deepEqual(out.boards.map((b) => b.id), ['o']);
  assert.equal(a.sets[0][0], 'other');
});

// --- packThumbs ---

const KB300 = 'A'.repeat(300_000);
const jsonBytes = (map) => Buffer.byteLength(JSON.stringify(Object.fromEntries(map)), 'utf8');

function packAll(existing, adds, opts) {
  const results = [];
  for (const add of adds) {
    const r = packThumbs(existing, add, opts);
    results.push(r);
    if (r.shardId) {
      if (!existing.has(r.shardId)) existing.set(r.shardId, new Map());
      existing.get(r.shardId).set(add.cardId, add.b64);
    }
  }
  return results;
}

test('packThumbs: 300KB 4장은 첫 shard에 3장, 다음 shard에 1장', () => {
  const existing = new Map();
  const r = packAll(existing, [1, 2, 3, 4].map((i) => ({ cardId: 'c' + i, b64: KB300 })), { shards: 4 });
  assert.deepEqual(r.map((x) => x.shardId), ['thumbs_000', 'thumbs_000', 'thumbs_000', 'thumbs_001']);
  for (const m of existing.values()) assert.ok(jsonBytes(m) <= 1_000_000);
});

test('packThumbs: 모든 shard가 차면 {error:"full"}', () => {
  const existing = new Map();
  const r = packAll(existing, [1, 2, 3, 4, 5, 6, 7].map((i) => ({ cardId: 'c' + i, b64: KB300 })), { shards: 2 });
  assert.deepEqual(r.slice(0, 6).map((x) => x.shardId), ['thumbs_000', 'thumbs_000', 'thumbs_000', 'thumbs_001', 'thumbs_001', 'thumbs_001']);
  assert.deepEqual(r[6], { error: 'full' });
  for (const m of existing.values()) assert.ok(jsonBytes(m) <= 1_000_000);
});

test('packThumbs: 한도에 딱 맞으면 들어가고 1바이트 넘으면 다음 shard', () => {
  // {"k":"..."} = 2 + 3("k") + 1(:) + 2(따옴표) + n
  const limit = 100;
  const exact = 'x'.repeat(limit - 8);
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: exact }, { shards: 2, shardLimit: limit }), { shardId: 'thumbs_000' });
  assert.equal(Buffer.byteLength(JSON.stringify({ k: exact })), limit);
  const existing = new Map([['thumbs_000', new Map([['a', 'y']])]]);
  assert.deepEqual(packThumbs(existing, { cardId: 'k', b64: 'x'.repeat(limit - 8 - 8) }, { shards: 2, shardLimit: limit }), { shardId: 'thumbs_000' });
  assert.deepEqual(packThumbs(existing, { cardId: 'k', b64: 'x'.repeat(limit - 8 - 7) }, { shards: 2, shardLimit: limit }), { shardId: 'thumbs_001' });
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: 'x'.repeat(limit) }, { shards: 2, shardLimit: limit }), { error: 'full' });
});

test('packThumbs: 크기는 UTF-8 바이트와 이스케이프를 반영한다', () => {
  const limit = 50;
  const s = '가'.repeat(14); // 42 bytes + 8 = 50
  assert.equal(Buffer.byteLength(JSON.stringify({ k: s })), 50);
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: s }, { shards: 1, shardLimit: limit }), { shardId: 'thumbs_000' });
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: s + 'x' }, { shards: 1, shardLimit: limit }), { error: 'full' });
  const q = '"'.repeat(21); // 이스케이프로 42 bytes
  assert.equal(Buffer.byteLength(JSON.stringify({ k: q })), 50);
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: q + '"' }, { shards: 1, shardLimit: limit }), { error: 'full' });
});

test('packThumbs: 이미 있는 카드는 그 shard에서 바꿔 넣는다', () => {
  const existing = new Map([
    ['thumbs_000', new Map([['a', 'x'.repeat(10)]])],
    ['thumbs_001', new Map([['b', 'x'.repeat(10)]])],
  ]);
  assert.deepEqual(packThumbs(existing, { cardId: 'b', b64: 'y'.repeat(10) }, { shards: 2, shardLimit: 1000 }), { shardId: 'thumbs_001' });
});

test('packThumbs: 기본값은 128칸, 마지막 shardId는 thumbs_127', () => {
  const existing = new Map();
  for (let i = 0; i < 127; i++) existing.set('thumbs_' + String(i).padStart(3, '0'), new Map([['f' + i, KB300.repeat(3)]]));
  assert.deepEqual(packThumbs(existing, { cardId: 'n', b64: KB300 }), { shardId: 'thumbs_127' });
  existing.set('thumbs_127', new Map([['f127', KB300.repeat(3)]]));
  assert.deepEqual(packThumbs(existing, { cardId: 'n', b64: KB300 }), { error: 'full' });
});

// --- ThumbStore ---

test('ThumbStore: 생성 시 모든 shard를 읽어 색인을 만들고, 없거나 null인 shard는 빈 칸', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA' }, thumbs_002: { b: 'BBB' }, thumbs_001: null });
  const s = await createThumbStore(a, { shards: 4 });
  assert.equal(a.gets, 4);
  assert.equal(await s.get('a'), 'AAA');
  assert.equal(await s.get('b'), 'BBB');
  assert.equal(await s.get('zzz'), null);
});

test('ThumbStore: put은 packThumbs가 고른 shard에 쓰고 get으로 읽힌다', async () => {
  const a = fakeAdapter();
  const s = await createThumbStore(a, { shards: 2 });
  for (const id of ['c1', 'c2', 'c3', 'c4']) assert.equal(await s.put(id, KB300), undefined);
  assert.deepEqual(Object.keys(a.data.get('thumbs_000')), ['c1', 'c2', 'c3']);
  assert.deepEqual(Object.keys(a.data.get('thumbs_001')), ['c4']);
  assert.equal(await s.get('c4'), KB300);
  for (const [, v] of a.sets) assert.ok(Buffer.byteLength(JSON.stringify(v)) <= 1_000_000);
});

test('ThumbStore: 자리가 없으면 {error:"full"}을 돌려주고 쓰지 않는다', async () => {
  const a = fakeAdapter();
  const s = await createThumbStore(a, { shards: 1 });
  for (const id of ['c1', 'c2', 'c3']) await s.put(id, KB300);
  const before = a.sets.length;
  assert.deepEqual(await s.put('c4', KB300), { error: 'full' });
  assert.equal(a.sets.length, before);
  assert.equal(await s.get('c4'), null);
});

test('ThumbStore: remove는 그 shard에서 카드를 지운다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA', b: 'BBB' } });
  const s = await createThumbStore(a, { shards: 2 });
  await s.remove('a');
  assert.deepEqual(a.data.get('thumbs_000'), { b: 'BBB' });
  assert.equal(await s.get('a'), null);
  await s.remove('nope'); // 없는 카드는 조용히 넘어간다
  assert.equal(a.sets.length, 1);
});

test('ThumbStore: put 충돌 시 그 shard를 다시 읽고 다른 PC의 썸네일을 지우지 않는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA' } }, {
    conflicts: 1,
    onConflict: (data) => data.set('thumbs_000', { a: 'AAA', other: 'OOO' }),
  });
  const s = await createThumbStore(a, { shards: 2 });
  await s.put('mine', 'MMM');
  assert.deepEqual(a.data.get('thumbs_000'), { a: 'AAA', other: 'OOO', mine: 'MMM' });
  assert.equal(await s.get('other'), 'OOO');
});

test('ThumbStore: 충돌 뒤 다시 읽은 shard에 자리가 없으면 다음 shard로 가고 한도를 넘겨 쓰지 않는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: KB300 } }, {
    conflicts: 1,
    onConflict: (data) => data.set('thumbs_000', { a: KB300, o1: KB300, o2: KB300 }),
  });
  const s = await createThumbStore(a, { shards: 2 });
  await s.put('mine', KB300);
  assert.deepEqual(Object.keys(a.data.get('thumbs_000')), ['a', 'o1', 'o2']);
  assert.deepEqual(Object.keys(a.data.get('thumbs_001')), ['mine']);
  for (const [, v] of a.sets) assert.ok(Buffer.byteLength(JSON.stringify(v)) <= 1_000_000);
});

test('ThumbStore: remove 충돌 시 다시 읽고 그 카드만 지운다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA', b: 'BBB' } }, {
    conflicts: 1,
    onConflict: (data) => data.set('thumbs_000', { a: 'AAA', b: 'BBB', c: 'CCC' }),
  });
  const s = await createThumbStore(a, { shards: 1 });
  await s.remove('a');
  assert.deepEqual(a.data.get('thumbs_000'), { b: 'BBB', c: 'CCC' });
});

test('ThumbStore: 충돌이 3번 이어지면 에러를 던지고, 다른 에러는 바로 던진다', async () => {
  const a = fakeAdapter({}, { conflicts: 99 });
  const s = await createThumbStore(a, { shards: 2 });
  await assert.rejects(s.put('x', 'X'), (e) => e === CONFLICT);
  assert.equal(a.conflicts, 96);
  await s.remove('x'); // 쓰지 못한 카드라 remove는 쓰기 없이 끝난다
  assert.equal(a.conflicts, 96);

  const b = fakeAdapter();
  const s2 = await createThumbStore(b, { shards: 2 });
  let calls = 0;
  b.set = async () => { calls++; throw TOO_LARGE; };
  await assert.rejects(s2.put('x', 'X'), (e) => e === TOO_LARGE);
  assert.equal(calls, 1);
});

test('ThumbStore: 다른 shard에 있던 카드를 바꿔 넣으면 옛 shard에서 지운다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'x', big: 'y'.repeat(900) } });
  const s = await createThumbStore(a, { shards: 2, shardLimit: 1000 });
  await s.put('a', 'z'.repeat(200));
  assert.deepEqual(Object.keys(a.data.get('thumbs_000')), ['big']);
  assert.deepEqual(a.data.get('thumbs_001'), { a: 'z'.repeat(200) });
  assert.equal(await s.get('a'), 'z'.repeat(200));
});

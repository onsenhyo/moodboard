import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeBoards, saveWithRetry, pruneTombstones, packThumbs, createThumbStore, isConflict, parseThumb,
} from '../src/store.js';

const CONFLICT = { code: 'conflict', id: 'STORAGE_ITEM_WRITE_CONFLICT' };
const TOO_LARGE = { id: 'STORAGE_WRITE_JSON_TOO_LARGE', code: 'invalid_request' };
const DAY = 24 * 3600 * 1000;

const card = (id, updatedAt, extra = {}) => ({ id, updatedAt, manual: { x: 0, y: 0, w: 10, h: 10 }, ...extra });
const board = (id, cards, updatedAt = 1, extra = {}) => ({ id, name: id, cards, updatedAt, ...extra });
const doc = (...boards) => ({ version: 1, boards });

// 가짜 어댑터: 값은 복사해 보관하고, conflicts 횟수만큼 set이 충돌한다.
// only를 주면 그 항목에 쓸 때만 충돌한다.
function fakeAdapter(initial = {}, { conflicts = 0, onConflict, only } = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const a = {
    data, sets: [], gets: 0, conflicts,
    async get(entry) { a.gets++; return data.has(entry) ? structuredClone(data.get(entry)) : null; },
    async set(entry, value) {
      if (a.conflicts > 0 && (only === undefined || only === entry)) { a.conflicts--; onConflict?.(data); throw CONFLICT; }
      a.sets.push([entry, structuredClone(value)]);
      data.set(entry, structuredClone(value));
    },
  };
  return a;
}

// 저장 값의 "<시각>:" 접두를 뗀 shard 내용.
const plain = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, parseThumb(v).b64]));

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

// --- mergeBoards: groups ---

const group = (id, updatedAt, extra = {}) => ({
  id, name: id, rect: { x: 0, y: 0, w: 400, h: 300 }, collapsed: false, updatedAt, ...extra,
});
const groupsOf = (d, boardId) => d.boards.find((b) => b.id === boardId).groups;

test('mergeBoards legacy doc: groups가 없는 보드끼리 합쳐도 groups는 []', () => {
  const m = mergeBoards(doc(board('b1', [card('a', 1)])), doc(board('b1', [card('b', 1)])));
  assert.deepEqual(groupsOf(m, 'b1'), []);
  const onlyLocal = mergeBoards(doc(board('b2', [])), null);
  assert.deepEqual(groupsOf(onlyLocal, 'b2'), []);
  const onlyRemote = mergeBoards(null, doc(board('b3', [])));
  assert.deepEqual(groupsOf(onlyRemote, 'b3'), []);
});

test('mergeBoards groups: 양쪽이 서로 다른 묶음을 더하면 둘 다 남는다', () => {
  const l = doc(board('b1', [], 1, { groups: [group('gL', 5)] }));
  const r = doc(board('b1', [], 1, { groups: [group('gR', 6)] }));
  assert.deepEqual(groupsOf(mergeBoards(l, r), 'b1').map((g) => g.id), ['gL', 'gR']);
});

test('mergeBoards groups: 한쪽에만 groups가 있어도 합친다', () => {
  const l = doc(board('b1', [], 1));
  const r = doc(board('b1', [], 1, { groups: [group('g', 6)] }));
  assert.deepEqual(groupsOf(mergeBoards(l, r), 'b1').map((g) => g.id), ['g']);
  assert.deepEqual(groupsOf(mergeBoards(r, l), 'b1').map((g) => g.id), ['g']);
});

test('mergeBoards groups: 같은 묶음을 옮기면 updatedAt이 큰 쪽 rect가 남는다', () => {
  const moved = { x: 50, y: 60, w: 400, h: 300 };
  const l = doc(board('b1', [], 1, { groups: [group('g', 5)] }));
  const r = doc(board('b1', [], 1, { groups: [group('g', 9, { rect: moved })] }));
  assert.deepEqual(groupsOf(mergeBoards(l, r), 'b1')[0].rect, moved);
  assert.deepEqual(groupsOf(mergeBoards(r, l), 'b1')[0].rect, moved);
});

test('mergeBoards groups: 한쪽이 지웠으면 묘비가 이긴다(같은 시각)', () => {
  const l = doc(board('b1', [], 1, { groups: [group('g', 7)] }));
  const r = doc(board('b1', [], 1, { groups: [group('g', 7, { deleted: true })] }));
  assert.equal(groupsOf(mergeBoards(l, r), 'b1')[0].deleted, true);
  assert.equal(groupsOf(mergeBoards(r, l), 'b1')[0].deleted, true);
  const later = doc(board('b1', [], 1, { groups: [group('g', 8, { deleted: true })] }));
  assert.equal(groupsOf(mergeBoards(l, later), 'b1')[0].deleted, true);
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

test('pruneTombstones: 30일 지난 묶음 묘비를 지운다', () => {
  const now = 100 * DAY;
  const d = doc(
    board('b1', [], 1, {
      groups: [
        group('old', now - 31 * DAY, { deleted: true }),
        group('fresh', now - 29 * DAY, { deleted: true }),
        group('live', 0),
      ],
    }),
    board('legacy', []),
  );
  const p = pruneTombstones(d, now);
  assert.deepEqual(groupsOf(p, 'b1').map((g) => g.id), ['fresh', 'live']);
  assert.equal(d.boards[0].groups.length, 3, '입력은 그대로');
  assert.equal('groups' in p.boards[1], false, 'groups가 없는 보드는 그대로');
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
  assert.deepEqual(plain(a.data.get('thumbs_000')), { b: 'BBB' });
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
  assert.deepEqual(plain(a.data.get('thumbs_000')), { a: 'AAA', other: 'OOO', mine: 'MMM' });
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
  assert.deepEqual(plain(a.data.get('thumbs_000')), { b: 'BBB', c: 'CCC' });
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
  assert.deepEqual(plain(a.data.get('thumbs_001')), { a: 'z'.repeat(200) });
  assert.equal(await s.get('a'), 'z'.repeat(200));
});

// --- fix round 1: 쓰기 전 읽기, 이동 시 색인 보존, reload ---

const keysOf = (a, id) => Object.keys(a.data.get(id) ?? {});

test('ThumbStore: 옮긴 뒤 옛 shard 정리가 충돌해도 get은 새 썸네일을 돌려주고 remove는 모든 사본을 지운다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'x', big: 'y'.repeat(900) } }, {
    conflicts: 1, only: 'thumbs_000',
    onConflict: (data) => data.set('thumbs_000', { ...data.get('thumbs_000'), other: 'o' }),
  });
  const s = await createThumbStore(a, { shards: 2, shardLimit: 1000 });
  const z = 'z'.repeat(250);
  await s.put('a', z);
  assert.equal(await s.get('a'), z);
  assert.deepEqual(keysOf(a, 'thumbs_000'), ['big', 'other']);
  assert.deepEqual(keysOf(a, 'thumbs_001'), ['a']);
  assert.equal(await s.get('other'), 'o');
  await s.remove('a');
  assert.equal(await s.get('a'), null);
  assert.deepEqual(keysOf(a, 'thumbs_001'), []);
});

test('ThumbStore: 옛 shard 정리가 끝내 실패해도 put은 성공하고, 그 shard의 다음 쓰기에서 사본을 걷어낸다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'x', big: 'y'.repeat(900) } }, { conflicts: 3, only: 'thumbs_000' });
  const s = await createThumbStore(a, { shards: 2, shardLimit: 1000 });
  const z = 'z'.repeat(250);
  assert.equal(await s.put('a', z), undefined);
  assert.equal(await s.get('a'), z);
  assert.deepEqual(keysOf(a, 'thumbs_000'), ['a', 'big'], '정리 실패로 옛 사본이 남음');
  // 옛 사본이 남은 shard를 다시 받아도 색인은 새 shard를 가리킨다.
  s.reload('thumbs_000', a.data.get('thumbs_000'));
  assert.equal(await s.get('a'), z);
  // thumbs_000에 대한 다음 쓰기에서 옛 사본이 빠진다.
  await s.remove('big');
  assert.deepEqual(keysOf(a, 'thumbs_000'), []);
  assert.equal(await s.get('a'), z);
});

test('ThumbStore: 캐시가 낡았을 때 put은 다른 PC가 그 사이 넣은 썸네일을 지우지 않는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA' } });
  const s = await createThumbStore(a, { shards: 2 });
  // 이 창 모르게 다른 PC가 쓴다(충돌 없이 기준 판이 앞서간 경우).
  a.data.set('thumbs_000', { a: 'AAA', other: 'OOO' });
  await s.put('mine', 'MMM');
  assert.deepEqual(plain(a.data.get('thumbs_000')), { a: 'AAA', other: 'OOO', mine: 'MMM' });
  assert.equal(await s.get('other'), 'OOO');
});

test('ThumbStore: 캐시가 낡았을 때 remove도 다른 PC의 썸네일을 지우지 않는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA' } });
  const s = await createThumbStore(a, { shards: 1 });
  a.data.set('thumbs_000', { a: 'AAA', other: 'OOO' });
  await s.remove('a');
  assert.deepEqual(plain(a.data.get('thumbs_000')), { other: 'OOO' });
});

test('ThumbStore: 새로 읽은 shard가 차 있으면 한도를 넘기지 않고 다음 shard에 쓴다(캐시가 낡은 경우)', async () => {
  const a = fakeAdapter({ thumbs_000: { a: KB300 } });
  const s = await createThumbStore(a, { shards: 2 });
  a.data.set('thumbs_000', { a: KB300, o1: KB300, o2: KB300 });
  await s.put('mine', KB300);
  assert.deepEqual(keysOf(a, 'thumbs_000'), ['a', 'o1', 'o2']);
  assert.deepEqual(keysOf(a, 'thumbs_001'), ['mine']);
  for (const [, v] of a.sets) assert.ok(Buffer.byteLength(JSON.stringify(v)) <= 1_000_000);
});

test('ThumbStore: reload는 그 shard의 get 결과만 바꾸고 다른 shard의 색인은 지킨다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: 'AAA' }, thumbs_001: { b: 'BBB' } });
  const s = await createThumbStore(a, { shards: 2 });
  s.reload('thumbs_000', { c: 'CCC', a: 'A2' });
  assert.equal(await s.get('a'), 'A2');
  assert.equal(await s.get('c'), 'CCC');
  assert.equal(await s.get('b'), 'BBB');
  s.reload('thumbs_000', null);
  assert.equal(await s.get('a'), null);
  assert.equal(await s.get('c'), null);
  assert.equal(await s.get('b'), 'BBB');
  s.reload('thumbs_999', { z: 'Z' }); // 범위 밖은 무시
  assert.equal(await s.get('z'), null);
  assert.equal(a.sets.length, 0, 'reload는 쓰지 않는다');
});

test('saveWithRetry: tries가 0이어도 한 번은 시도한다', async () => {
  const a = fakeAdapter({ boards: doc() });
  await saveWithRetry(a, (d) => d, { tries: 0, now: () => 0 });
  assert.equal(a.sets.length, 1);
});

// --- fix round 2: 기록 시각으로 중복 해소 ---

test('ThumbStore: 저장 값은 "<시각>:<base64>"이고 get은 base64만 돌려준다', async () => {
  const a = fakeAdapter();
  const s = await createThumbStore(a, { shards: 1, now: () => 1234 });
  await s.put('k', 'QUJD');
  assert.deepEqual(a.data.get('thumbs_000'), { k: '1234:QUJD' });
  assert.equal(await s.get('k'), 'QUJD');
  assert.deepEqual(parseThumb('QUJD'), { t: 0, b64: 'QUJD' }, '접두가 없으면 시각 0');
});

test('ThumbStore: 크기는 접두를 포함한 저장 값으로 잰다', async () => {
  // {"k":"7:xxx"} = 8 + 2 + n
  const a = fakeAdapter();
  const s = await createThumbStore(a, { shards: 1, shardLimit: 100, now: () => 7 });
  assert.deepEqual(await s.put('k', 'x'.repeat(91)), { error: 'full' });
  assert.equal(await s.put('k', 'x'.repeat(90)), undefined);
  assert.equal(Buffer.byteLength(JSON.stringify(a.data.get('thumbs_000'))), 100);
});

test('ThumbStore: 새 창에서 높은 shard의 사본이 더 새로우면 그 사본을 읽는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: '100:OLD' }, thumbs_001: { a: '200:NEW' } });
  const s = await createThumbStore(a, { shards: 2 });
  assert.equal(await s.get('a'), 'NEW');
});

test('ThumbStore: 새 창에서 낮은 shard의 사본이 더 새로우면 그 사본을 읽는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: '200:NEW' }, thumbs_001: { a: '100:OLD' } });
  const s = await createThumbStore(a, { shards: 2 });
  assert.equal(await s.get('a'), 'NEW');
});

test('ThumbStore: 시각이 같으면 낮은 shard, 접두 없는 값은 시각 0으로 진다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: '100:LOW', b: 'PLAIN' }, thumbs_001: { a: '100:HIGH', b: '1:STAMPED' } });
  const s = await createThumbStore(a, { shards: 2 });
  assert.equal(await s.get('a'), 'LOW');
  assert.equal(await s.get('b'), 'STAMPED');
});

test('ThumbStore: reload로 낡은 사본이 들어와도 새 사본을 읽고, 더 새 사본이 오면 그것을 읽는다', async () => {
  const a = fakeAdapter({ thumbs_001: { a: '200:NEW' } });
  const s = await createThumbStore(a, { shards: 2 });
  s.reload('thumbs_000', { a: '100:OLD', b: '1:B' });
  assert.equal(await s.get('a'), 'NEW');
  assert.equal(await s.get('b'), 'B');
  s.reload('thumbs_000', { a: '300:NEWER' });
  assert.equal(await s.get('a'), 'NEWER');
  assert.equal(await s.get('b'), null);
  s.reload('thumbs_000', {});
  assert.equal(await s.get('a'), 'NEW');
});

test('ThumbStore: 진 사본은 그 shard의 다음 쓰기에서 걷히고, 다른 PC가 더 새로 쓴 사본은 남는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: '100:OLD' }, thumbs_001: { a: '200:NEW' } });
  const s = await createThumbStore(a, { shards: 2, now: () => 1000 });
  await s.put('x', 'X');
  assert.deepEqual(plain(a.data.get('thumbs_000')), { x: 'X' });
  assert.deepEqual(plain(a.data.get('thumbs_001')), { a: 'NEW' });

  // 캐시로는 001이 이기지만, 다른 PC가 000에 더 새로 쓴 사본은 지우지 않는다.
  const b = fakeAdapter({ thumbs_000: { a: '100:OLD' }, thumbs_001: { a: '200:NEW' } });
  const s2 = await createThumbStore(b, { shards: 2, now: () => 1000 });
  b.data.set('thumbs_000', { a: '900:FROM_OTHER_PC' });
  await s2.put('x', 'X');
  assert.deepEqual(plain(b.data.get('thumbs_000')), { a: 'FROM_OTHER_PC', x: 'X' });
  assert.equal(await s2.get('a'), 'FROM_OTHER_PC');
});

test('ThumbStore: put은 시계가 뒤로 가도 새 사본이 이기게 쓰고 다른 사본을 모두 걷는다', async () => {
  const a = fakeAdapter({ thumbs_000: { a: '5000:OLD', big: 'y'.repeat(900) }, thumbs_002: { a: '4000:OLDER' } });
  const s = await createThumbStore(a, { shards: 3, shardLimit: 1000, now: () => 10 });
  await s.put('a', 'z'.repeat(250));
  assert.equal(await s.get('a'), 'z'.repeat(250));
  assert.deepEqual(keysOf(a, 'thumbs_000'), ['big']);
  // packThumbs는 카드가 이미 있고 자리가 맞는 shard(002)를 먼저 고른다.
  assert.deepEqual(keysOf(a, 'thumbs_001'), []);
  assert.deepEqual(keysOf(a, 'thumbs_002'), ['a']);
  assert.ok(parseThumb(a.data.get('thumbs_002').a).t > 5000, '아는 사본보다 큰 시각');
  const fresh = await createThumbStore(a, { shards: 3, shardLimit: 1000 });
  assert.equal(await fresh.get('a'), 'z'.repeat(250));
});

test('ThumbStore: 옮긴 뒤 정리가 실패한 채 창을 닫아도 새 창과 다른 PC는 새 이미지를 읽고, 다음 쓰기에서 사본이 걷힌다', async () => {
  // 리뷰 재현: 000→001 이동, 000 정리가 충돌 3번으로 실패.
  const a = fakeAdapter({ thumbs_000: { a: 'x', big: 'y'.repeat(900) } }, { conflicts: 3, only: 'thumbs_000' });
  const s = await createThumbStore(a, { shards: 2, shardLimit: 1000, now: () => 1000 });
  const z = 'z'.repeat(250);
  await s.put('a', z);
  assert.equal(await s.get('a'), z);
  assert.deepEqual(keysOf(a, 'thumbs_000'), ['a', 'big'], '옛 사본이 남음');

  const s2 = await createThumbStore(a, { shards: 2, shardLimit: 1000, now: () => 2000 });
  assert.equal(await s2.get('a'), z, '새 세션도 새 이미지');
  await s2.put('big2', 'q');
  assert.deepEqual(keysOf(a, 'thumbs_000'), ['big', 'big2'], '다음 쓰기에서 옛 사본이 걷힘');

  const s3 = await createThumbStore(a, { shards: 2, shardLimit: 1000 });
  assert.equal(await s3.get('a'), z);
});

test('ThumbStore: 시작 때 못 읽은 shard는 missing에 남고 쓰기를 받지 않다가 reload 뒤에 읽힌다', async () => {
  const a = fakeAdapter({ thumbs_001: { z: 'ZZZ' } });
  const get = a.get;
  let fail = true;
  a.get = async (entry) => { if (fail && entry === 'thumbs_000') throw new Error('net'); return get(entry); };
  const s = await createThumbStore(a, { shards: 2 });
  assert.deepEqual(s.missing(), ['thumbs_000']);
  assert.equal(await s.get('z'), 'ZZZ');
  assert.equal(await s.put('c1', 'C'), undefined);
  assert.deepEqual(a.sets.map(([e]) => e), ['thumbs_001']);
  fail = false;
  s.reload('thumbs_000', { q: 'QQQ' });
  assert.deepEqual(s.missing(), []);
  assert.equal(await s.get('q'), 'QQQ');
});

test('ThumbStore: 읽은 shard가 모두 차고 못 읽은 shard가 남으면 put은 full 대신 실패한다', async () => {
  const a = fakeAdapter();
  a.get = async () => { throw new Error('net'); };
  const s = await createThumbStore(a, { shards: 1 });
  assert.deepEqual(s.missing(), ['thumbs_000']);
  await assert.rejects(s.put('c1', 'C'), /loading/);
  assert.equal(a.sets.length, 0);
});

test('packThumbs: skip에 든 shard는 고르지 않는다', () => {
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: 'x' }, { shards: 2, skip: new Set(['thumbs_000']) }), { shardId: 'thumbs_001' });
  assert.deepEqual(packThumbs(new Map(), { cardId: 'k', b64: 'x' }, { shards: 1, skip: new Set(['thumbs_000']) }), { error: 'full' });
});

// --- 접두와 개수 바꾸기(GIF 저장소) ---

test('createThumbStore: GIF_STORE를 펼치면 gifs_00..63에 쓰고 thumbs_는 건드리지 않는다', async () => {
  const { GIF_STORE, gifShardIdOf, shardIdFor } = await import('../src/store.js');
  assert.deepEqual({ ...GIF_STORE }, { prefix: 'gifs_', pad: 2, shards: 64 });
  assert.equal(gifShardIdOf(0), 'gifs_00');
  assert.equal(gifShardIdOf(63), 'gifs_63');
  assert.equal(shardIdFor('x_', 4)(7), 'x_0007');
  const a = fakeAdapter();
  const s = await createThumbStore(a, { ...GIF_STORE, now: () => 5 });
  assert.equal(a.gets, 64);
  await s.put('c1', 'R0lG');
  assert.deepEqual(a.sets.map(([e]) => e), ['gifs_00']);
  assert.equal(await s.get('c1'), 'R0lG');
  s.reload('thumbs_000', { c2: '1:QQ==' }); // 다른 접두의 shard는 무시한다
  assert.equal(await s.get('c2'), null);
  s.reload('gifs_05', { c2: '1:QQ==' });
  assert.equal(await s.get('c2'), 'QQ==');
  await s.remove('c1');
  assert.deepEqual(a.data.get('gifs_00'), {});
});

test('createThumbStore: 작은 shard 한도와 개수로 다음 shard로 넘어가고 다 차면 full', async () => {
  const a = fakeAdapter();
  const s = await createThumbStore(a, { prefix: 'gifs_', pad: 2, shards: 2, shardLimit: 40, now: () => 1 });
  assert.equal(await s.put('a', 'A'.repeat(20)), undefined);
  assert.equal(await s.put('b', 'B'.repeat(20)), undefined);
  assert.deepEqual(await s.put('c', 'C'.repeat(20)), { error: 'full' });
  assert.deepEqual([...a.data.keys()].sort(), ['gifs_00', 'gifs_01']);
});

test('packThumbs: idOf로 shard id를 만든다', () => {
  const r = packThumbs(new Map(), { cardId: 'x', b64: 'AA' }, { shards: 3, idOf: (i) => 'gifs_' + i });
  assert.deepEqual(r, { shardId: 'gifs_0' });
});

test('ThumbStore.stamps: 카드마다 이기는 사본의 writtenAt', async () => {
  const a = fakeAdapter({ thumbs_000: { a: '5:AAA', b: 'BBB' }, thumbs_001: { a: '9:AAA2' } });
  const s = await createThumbStore(a, { shards: 2 });
  assert.deepEqual([...s.stamps()].sort(), [['a', 9], ['b', 0]]);
});

// --- GifStore ---

const { createGifStore } = await import('../src/store.js');
const gifEntries = (a) => [...a.data.keys()].filter((k) => k.startsWith('gifs_'));

test('GifStore: 한 shard에 넘치는 GIF를 조각으로 나눠 두고 이어 붙여 읽는다', async () => {
  const a = fakeAdapter();
  const s = await createGifStore(a, { partChars: 10, shardLimit: 60, shards: 8 });
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcd'; // 30자 = 조각 3개
  assert.equal(await s.put('c1', b64), undefined);
  assert.equal(await s.get('c1'), b64);
  assert.ok(gifEntries(a).length >= 3, '조각이 여러 shard에 나뉜다');
  assert.deepEqual([...s.stamps().keys()], ['c1']);

  const again = await createGifStore(a, { partChars: 10, shardLimit: 60, shards: 8 });
  assert.equal(await again.get('c1'), b64, '다시 연 창도 같은 값을 읽는다');

  await s.remove('c1');
  assert.equal(await s.get('c1'), null);
  assert.deepEqual([...s.stamps().keys()], []);
});

test('GifStore: 한 조각 GIF는 예전 모양(cardId에 base64 그대로)이고, 예전 값도 그대로 읽는다', async () => {
  const a = fakeAdapter({ gifs_00: { old: '1:R0lGODlh' } });
  const s = await createGifStore(a, { partChars: 10 });
  assert.equal(await s.get('old'), 'R0lGODlh');
  await s.put('c1', 'QUJD');
  assert.equal(plain(a.data.get('gifs_00')).c1, 'QUJD');
});

test('GifStore: 저장 공간이 모자라면 full을 돌려주고 쓴 조각을 걷는다', async () => {
  const a = fakeAdapter();
  const s = await createGifStore(a, { partChars: 10, shardLimit: 60, shards: 2 });
  const r = await s.put('c1', 'A'.repeat(50));
  assert.deepEqual(r, { error: 'full' });
  assert.equal(await s.get('c1'), null);
  assert.deepEqual([...s.stamps().keys()], []);
});

test('GifStore: 조각 하나를 아직 못 읽었으면 null, 첫 조각 없이 남은 조각도 stamps는 카드 id로 접는다', async () => {
  const a = fakeAdapter({ gifs_00: { c1: '1:2|AAAA' }, gifs_01: { 'c2~1': '7:BBBB' } });
  const s = await createGifStore(a);
  assert.equal(await s.get('c1'), null);
  s.reload('gifs_02', { 'c1~1': '1:CCCC' });
  assert.equal(await s.get('c1'), 'AAAACCCC');
  assert.equal(s.stamps().get('c2'), 7);
  await s.remove('c2');
  assert.equal(s.stamps().has('c2'), false);
});

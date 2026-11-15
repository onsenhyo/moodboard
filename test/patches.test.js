import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, applyPatches, mergePatch, createDocEditor, cardTextPatch, MEMO_MAX } from '../src/patches.js';

const base = () => ({
  version: 1,
  boards: [{
    id: 'b', name: '보드', updatedAt: 1,
    cards: [{ id: 'x', kind: 'text', manual: { x: 0, y: 0, w: 100, h: 80 }, color: '#111111', updatedAt: 1 }],
    groups: [{ id: 'g', name: '묶음', rect: { x: 0, y: 0, w: 200, h: 100 }, updatedAt: 1 }],
  }],
});

// 같은 boards 항목을 두 프레임이 CAS로 쓰는 가짜 저장소.
function fakeStore(initial) {
  let value = structuredClone(initial);
  let rev = 0;
  const revs = new Map(); // 프레임별 마지막으로 읽은 revision
  return {
    get value() { return value; },
    adapter(name) {
      return {
        get: async () => { revs.set(name, rev); return structuredClone(value); },
        set: async (entry, v) => {
          if (revs.get(name) !== rev) throw { code: 'conflict', id: 'STORAGE_ITEM_WRITE_CONFLICT' };
          value = structuredClone(v);
          rev++;
          revs.set(name, rev);
        },
      };
    },
    // 다른 프레임의 쓰기가 끼어든다(이 프레임이 읽은 뒤).
    bump(mutate) { mutate(value); rev++; },
  };
}

const move = { kind: 'card', boardId: 'b', id: 'x', fields: { manual: { x: 300, y: 200, w: 100, h: 80 } }, t: 10 };
const paper = { kind: 'card', boardId: 'b', id: 'x', fields: { paper: '#223344' }, t: 20 };

test('applyPatch: 필드를 덮고 키를 지우고 updatedAt을 올린다, 대상이 없으면 건너뛴다', () => {
  const d = base();
  applyPatch(d, { kind: 'card', boardId: 'b', id: 'x', fields: { paper: '#000000' }, t: 5 });
  applyPatch(d, { kind: 'card', boardId: 'b', id: 'x', deleteKeys: ['color'], t: 3 });
  const x = d.boards[0].cards[0];
  assert.equal(x.paper, '#000000');
  assert.equal('color' in x, false);
  assert.equal(x.updatedAt, 5); // max
  applyPatch(d, { kind: 'card', boardId: 'b', id: 'none', fields: { a: 1 }, t: 9 });
  applyPatch(d, { kind: 'card', boardId: 'nob', id: 'x', fields: { a: 1 }, t: 9 });
  assert.equal(d.boards[0].cards.length, 1);
  applyPatch(d, { kind: 'board', id: 'b', fields: { bg: '#ffffff' }, t: 7 });
  assert.equal(d.boards[0].bg, '#ffffff');
});

test('applyPatch: insert는 없을 때만 넣고, 두 번 적용해도 하나', () => {
  const d = base();
  const card = { id: 'n', kind: 'text', updatedAt: 4 };
  const p = { kind: 'card', boardId: 'b', id: 'n', insert: card, t: 4 };
  applyPatches(d, [p, p]);
  assert.equal(d.boards[0].cards.filter((c) => c.id === 'n').length, 1);
  const nb = { id: 'b2', name: '새', cards: [], groups: [], updatedAt: 6 };
  applyPatches(d, [{ kind: 'board', id: 'b2', insert: nb, t: 6 }, { kind: 'group', boardId: 'b2', id: 'g2', insert: { id: 'g2' }, t: 6 }]);
  assert.equal(d.boards[1].groups[0].id, 'g2');
  // 묘비에 옮기기를 적용해도 되살아나지 않는다
  d.boards[0].cards[0].deleted = true;
  applyPatch(d, move);
  assert.equal(d.boards[0].cards[0].deleted, true);
});

test('mergePatch: 뒤 패치가 이기고 지울 키와 덮을 필드가 서로 지운다', () => {
  const a = { kind: 'card', boardId: 'b', id: 'x', fields: { paper: '#111111', color: '#222222' }, t: 1 };
  const b = { kind: 'card', boardId: 'b', id: 'x', deleteKeys: ['paper'], fields: { color: '#333333' }, t: 2 };
  assert.deepEqual(mergePatch(a, b), { kind: 'card', boardId: 'b', id: 'x', t: 2, fields: { color: '#333333' }, deleteKeys: ['paper'] });
  const c = { kind: 'card', boardId: 'b', id: 'x', fields: { paper: '#444444' }, t: 3 };
  assert.deepEqual(mergePatch(mergePatch(a, b), c).fields, { color: '#333333', paper: '#444444' });
  assert.equal(mergePatch(mergePatch(a, b), c).deleteKeys, undefined);
});

for (const order of [['sandbox', 'client'], ['client', 'sandbox']]) {
  test(`두 프레임: sandbox 옮기기와 client 종이 색이 모두 남는다 (${order.join(' 먼저, ')} 저장)`, async () => {
    const store = fakeStore(base());
    const sandbox = createDocEditor({ adapter: store.adapter('sandbox'), now: () => 100 });
    const client = createDocEditor({ adapter: store.adapter('client'), now: () => 100 });
    sandbox.receive(store.value);
    client.receive(store.value);
    sandbox.edit(move);
    client.edit(paper); // client의 사본은 옮기기 전 자리를 들고 있다
    const frames = { sandbox, client };
    await frames[order[0]].save();
    await frames[order[1]].save(); // 낡은 사본이 아니라 새로 읽은 값에 패치를 얹는다
    const x = store.value.boards[0].cards[0];
    assert.deepEqual(x.manual, move.fields.manual);
    assert.equal(x.paper, '#223344');
    assert.equal(x.color, '#111111');
    assert.equal(sandbox.pending + client.pending, 0);
  });
}

test('충돌: 읽은 뒤 다른 프레임이 쓰면 다시 읽고 같은 패치를 다시 얹는다', async () => {
  const store = fakeStore(base());
  const adapter = store.adapter('sandbox');
  let first = true;
  const racing = {
    get: async (e) => {
      const v = await adapter.get(e);
      if (first) { first = false; store.bump((d) => { d.boards[0].cards[0].paper = '#999999'; }); }
      return v;
    },
    set: adapter.set,
  };
  const ed = createDocEditor({ adapter: racing, now: () => 100 });
  ed.receive(store.value);
  ed.edit(move);
  await ed.save();
  const x = store.value.boards[0].cards[0];
  assert.deepEqual(x.manual, move.fields.manual);
  assert.equal(x.paper, '#999999');
  assert.equal(ed.pending, 0);
});

test('editor: 저장 중에 들어온 편집은 줄에 남고, receive 뒤에도 화면 문서에 얹혀 있다', async () => {
  const store = fakeStore(base());
  const adapter = store.adapter('c');
  let release;
  let gate = new Promise((r) => { release = r; });
  const slow = { get: async (e) => { await gate; return adapter.get(e); }, set: adapter.set };
  const ed = createDocEditor({ adapter: slow, now: () => 100 });
  ed.receive(store.value);
  ed.edit({ kind: 'card', boardId: 'b', id: 'x', fields: { color: '#aaaaaa' }, t: 5 });
  const saving = ed.save();
  ed.edit({ kind: 'card', boardId: 'b', id: 'x', fields: { paper: '#bbbbbb' }, t: 6 }); // 앞 패치와 합쳐진 새 객체
  release();
  await saving;
  assert.equal(ed.pending, 1);
  ed.receive(store.value);
  assert.equal(ed.doc.boards[0].cards[0].paper, '#bbbbbb');
  await ed.save();
  assert.equal(store.value.boards[0].cards[0].paper, '#bbbbbb');
  assert.equal(store.value.boards[0].cards[0].color, '#aaaaaa');
  assert.equal(ed.pending, 0);
});

test('editor.writeNow: 읽지 않고 마지막 값에 얹어 바로 쓴다', async () => {
  const store = fakeStore(base());
  const adapter = store.adapter('s');
  await adapter.get('boards');
  const ed = createDocEditor({ adapter, now: () => 100 });
  ed.receive(store.value);
  assert.equal(ed.writeNow(), null);
  ed.edit(move);
  await ed.writeNow();
  assert.deepEqual(store.value.boards[0].cards[0].manual, move.fields.manual);
  assert.equal(ed.pending, 0);
});

test('cardTextPatch: label과 memo를 쓰고, 빈 값이나 공백이면 키를 지운다', () => {
  const d = base();
  const x = () => d.boards[0].cards[0];
  applyPatch(d, { ...cardTextPatch('b', 'x', 'label', '  바다 사진 '), t: 5 });
  applyPatch(d, { ...cardTextPatch('b', 'x', 'memo', '첫 줄\n둘째 줄', MEMO_MAX), t: 6 });
  assert.equal(x().label, '바다 사진');
  assert.equal(x().memo, '첫 줄\n둘째 줄');
  assert.equal(x().updatedAt, 6);
  assert.deepEqual(cardTextPatch('b', 'x', 'label', ''), { kind: 'card', boardId: 'b', id: 'x', deleteKeys: ['label'] });
  applyPatch(d, { ...cardTextPatch('b', 'x', 'label', ''), t: 7 });
  applyPatch(d, { ...cardTextPatch('b', 'x', 'memo', '  \n '), t: 8 });
  assert.ok(!('label' in x()) && !('memo' in x()));
  assert.equal(x().color, '#111111', '다른 필드는 그대로');
});

test('cardTextPatch: memo는 500자(code point)까지 자른다', () => {
  const p = cardTextPatch('b', 'x', 'memo', '😀'.repeat(600), MEMO_MAX);
  assert.equal(MEMO_MAX, 500);
  assert.equal([...p.fields.memo].length, 500);
});

test('cardTextPatch: 한 프레임이 이름을 쓰고 다른 프레임이 옮겨도 둘 다 남는다, 이어서 지우기는 하나로 합친다', () => {
  const merged = mergePatch({ ...cardTextPatch('b', 'x', 'label', 'a'), t: 1 }, { ...cardTextPatch('b', 'x', 'label', ''), t: 2 });
  assert.deepEqual(merged, { kind: 'card', boardId: 'b', id: 'x', t: 2, deleteKeys: ['label'] });
  const d = applyPatches(base(), [move, { ...cardTextPatch('b', 'x', 'label', '이름'), t: 11 }]);
  assert.equal(d.boards[0].cards[0].label, '이름');
  assert.equal(d.boards[0].cards[0].manual.x, 300);
});

// --- 저장 한도(1MiB)와 버릴 편집 ---

import { DOC_MAX_BYTES, fitPatches, LABEL_MAX, TEXT_MAX, clipText } from '../src/patches.js';

const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const bigText = (id, n, t) => ({ kind: 'card', boardId: 'b', id, insert: { id, kind: 'text', text: 'x'.repeat(n), updatedAt: t }, t });

test('fitPatches: 한도를 넘게 만든 패치만 빼고 나머지는 얹는다', () => {
  const limit = 2000;
  const r = fitPatches(base(), [move, bigText('big', 3000, 11), paper], { limit, now: () => 100 });
  assert.deepEqual(r.dropped.map((p) => p.id), ['big']);
  assert.equal(r.kept.length, 2);
  assert.ok(bytesOf(r.doc) <= limit);
  assert.equal(r.doc.boards[0].cards[0].paper, '#223344');
  assert.equal(r.doc.boards[0].cards.some((c) => c.id === 'big'), false);
  // 한도 안이면 그대로 다 얹는다
  const ok = fitPatches(base(), [move, paper], { limit, now: () => 100 });
  assert.equal(ok.dropped.length, 0);
  assert.equal(DOC_MAX_BYTES, 1_048_576);
});

test('editor.save: 한도를 넘는 편집은 버리고 알리며, 다음 저장을 막지 않는다', async () => {
  const store = fakeStore(base());
  const ed = createDocEditor({ adapter: store.adapter('c'), now: () => 100, limit: 2000 });
  ed.receive(store.value);
  ed.edit(move);
  ed.edit(bigText('big', 3000, 11));
  await assert.rejects(ed.save(), (err) => err.code === 'too_large' && err.dropped === 1 && typeof err.message === 'string');
  assert.equal(ed.pending, 0);
  assert.deepEqual(store.value.boards[0].cards[0].manual, move.fields.manual);
  assert.equal(ed.doc.boards[0].cards.some((c) => c.id === 'big'), false, '화면 문서에서도 빠진다');
  ed.edit(paper);
  await ed.save();
  assert.equal(store.value.boards[0].cards[0].paper, '#223344');
});

test('editor.writeNow: 닫을 때도 한도를 넘는 편집은 빼고 쓴다', async () => {
  const store = fakeStore(base());
  const adapter = store.adapter('c');
  await adapter.get('boards');
  const ed = createDocEditor({ adapter, now: () => 100, limit: 2000 });
  ed.receive(store.value);
  ed.edit([move, bigText('big', 3000, 11)]);
  await ed.writeNow();
  assert.equal(ed.pending, 0);
  assert.deepEqual(store.value.boards[0].cards[0].manual, move.fields.manual);
  assert.equal(store.value.boards[0].cards.length, 1);
});

test('editor.save: 저장소가 받지 않는 편집(invalid_request)은 하나씩 나눠 그것만 버린다', async () => {
  const store = fakeStore(base());
  const inner = store.adapter('c');
  const adapter = {
    get: inner.get,
    set: async (e, v) => {
      if (v.boards[0].cards.some((c) => 'bad' in c)) throw { code: 'invalid_request', id: 'STORAGE_WRITE_SCHEMA_MISMATCH' };
      return inner.set(e, v);
    },
  };
  const ed = createDocEditor({ adapter, now: () => 100 });
  ed.receive(store.value);
  ed.edit(move);
  ed.edit({ kind: 'group', boardId: 'b', id: 'g', fields: { name: '새 이름' }, t: 12 });
  ed.edit({ kind: 'card', boardId: 'b', id: 'x', fields: { bad: 1 }, t: 13 });
  await assert.rejects(ed.save(), (err) => err.code === 'invalid' && err.dropped === 1);
  assert.equal(ed.pending, 0);
  assert.deepEqual(store.value.boards[0].cards[0].manual, move.fields.manual);
  assert.equal(store.value.boards[0].groups[0].name, '새 이름');
  assert.equal('bad' in ed.doc.boards[0].cards[0], false);
});

test('editor.save: 잠깐의 실패(server)는 편집을 줄에 남긴다', async () => {
  const store = fakeStore(base());
  const inner = store.adapter('c');
  let fail = true;
  const adapter = { get: inner.get, set: async (e, v) => { if (fail) throw { code: 'server' }; return inner.set(e, v); } };
  const ed = createDocEditor({ adapter, now: () => 100 });
  ed.receive(store.value);
  ed.edit(move);
  await assert.rejects(ed.save(), (err) => err.code === 'server');
  assert.equal(ed.pending, 1);
  fail = false;
  await ed.save();
  assert.equal(ed.pending, 0);
});

test('editor.save: 저장 중에 받은 더 새 값은 저장이 끝나도 남는다', async () => {
  const store = fakeStore(base());
  const adapter = store.adapter('c');
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { get: adapter.get, set: async (e, v) => { await gate; return adapter.set(e, v); } };
  const ed = createDocEditor({ adapter: slow, now: () => 100 });
  ed.receive(store.value);
  ed.edit(move);
  const saving = ed.save();
  await new Promise((r) => setTimeout(r, 0));
  // 다른 PC가 새 보드를 더하고 묶음 이름을 바꾼 값이 저장 중에 온다
  const newer = structuredClone(store.value);
  newer.boards.push({ id: 'b2', name: '다른 PC', cards: [], groups: [], updatedAt: 200 });
  newer.boards[0].groups[0] = { ...newer.boards[0].groups[0], name: '바뀜', updatedAt: 200 };
  ed.receive(newer);
  release();
  await saving;
  assert.ok(ed.doc.boards.some((b) => b.id === 'b2'), '받은 새 보드가 남는다');
  assert.equal(ed.doc.boards[0].groups[0].name, '바뀜');
  assert.deepEqual(ed.doc.boards[0].cards[0].manual, move.fields.manual, '방금 쓴 편집도 남는다');
});

test('글 한도: label은 100자, 글 카드 본문은 20,000자(code point)', () => {
  assert.equal(LABEL_MAX, 100);
  assert.equal(TEXT_MAX, 20_000);
  assert.equal([...cardTextPatch('b', 'x', 'label', '가'.repeat(300), LABEL_MAX).fields.label].length, 100);
  assert.equal([...clipText('😀'.repeat(TEXT_MAX + 5), TEXT_MAX)].length, TEXT_MAX);
  assert.equal(clipText('  앞뒤 공백은 둔다\n', TEXT_MAX), '  앞뒤 공백은 둔다\n');
  assert.equal(clipText(null, 5), '');
});

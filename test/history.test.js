import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSnapshot, restorePatches, createHistory, stableJson } from '../src/history.js';
import { applyPatches } from '../src/patches.js';
import { deleteCardPatches, deleteGroupPatches } from '../src/selection.js';

const card = (id, extra = {}) => ({ id, kind: 'text', text: id, manual: { x: 0, y: 0, w: 100, h: 80 }, updatedAt: 1, ...extra });
const doc0 = () => ({
  version: 1,
  boards: [{
    id: 'b', name: '보드', updatedAt: 1,
    cards: [card('a', { groupId: 'g' }), card('c', { label: '제목' })],
    groups: [{ id: 'g', name: '묶음', rect: { x: 0, y: 0, w: 400, h: 300 }, collapsed: false, updatedAt: 1 }],
  }],
});
const boardOf = (doc) => doc.boards.find((b) => b.id === 'b');
const edit = (doc, patches) => applyPatches(structuredClone(doc), patches.map((p) => ({ ...p, t: 99 })));
const undoTo = (doc, snap) => edit(doc, restorePatches(boardOf(doc), snap));
const same = (doc, snap) => assert.equal(stableJson(boardSnapshot(boardOf(doc))), stableJson(snap));

test('옮기기, 이름 고치기, 배경을 되돌린다', () => {
  const d0 = doc0();
  const s0 = boardSnapshot(boardOf(d0));
  const d1 = edit(d0, [
    { kind: 'card', boardId: 'b', id: 'a', fields: { manual: { x: 50, y: 60, w: 100, h: 80 } } },
    { kind: 'card', boardId: 'b', id: 'c', deleteKeys: ['label'] },
    { kind: 'board', id: 'b', fields: { bg: '#000000' } },
  ]);
  same(undoTo(d1, s0), s0);
});

test('지운 카드는 되살리고, 새로 넣은 카드는 묘비로 만든다', () => {
  const d0 = doc0();
  const s0 = boardSnapshot(boardOf(d0));
  const d1 = edit(d0, [
    ...deleteCardPatches(boardOf(d0), 'c'),
    { kind: 'card', boardId: 'b', id: 'n', insert: card('n') },
  ]);
  const back = undoTo(d1, s0);
  same(back, s0);
  assert.equal(boardOf(back).cards.find((c) => c.id === 'n').deleted, true);
  assert.equal(boardOf(back).cards.find((c) => c.id === 'c').deleted, undefined);
});

test('묶음 지우기를 되돌리면 묶음과 카드의 소속이 함께 돌아온다', () => {
  const d0 = doc0();
  const s0 = boardSnapshot(boardOf(d0));
  const d1 = edit(d0, deleteGroupPatches(boardOf(d0), 'g'));
  assert.equal(boardOf(d1).cards.find((c) => c.id === 'a').groupId, undefined);
  const back = undoTo(d1, s0);
  same(back, s0);
  assert.equal(boardOf(back).cards.find((c) => c.id === 'a').groupId, 'g');
});

test('묘비가 걷혀 문서에 없는 카드도 다시 넣는다', () => {
  const d0 = doc0();
  const s0 = boardSnapshot(boardOf(d0));
  const d1 = structuredClone(d0);
  boardOf(d1).cards = boardOf(d1).cards.filter((c) => c.id !== 'c');
  same(undoTo(d1, s0), s0);
});

test('같은 모양이면 패치가 없다', () => {
  const d0 = doc0();
  assert.deepEqual(restorePatches(boardOf(d0), boardSnapshot(boardOf(d0))), []);
});

test('기록: 같은 모양은 쌓지 않고, 되돌린 뒤 새 편집은 다시 하기 줄을 버린다', () => {
  const h = createHistory();
  const s = (n) => ({ id: 'b', meta: { name: String(n) }, cards: {}, groups: {} });
  h.observe(s(0));
  h.observe(s(1));
  h.observe(s(1));
  h.observe(s(2));
  assert.deepEqual(h.undo(), s(1));
  assert.deepEqual(h.undo(), s(0));
  assert.equal(h.undo(), null);
  assert.deepEqual(h.redo(), s(1));
  h.observe(s(1));
  h.observe(s(3));
  assert.equal(h.redo(), null);
  assert.deepEqual(h.undo(), s(1));
});

test('기록: 다른 보드로 바뀌면 처음부터, 한도를 넘으면 오래된 것부터 버린다', () => {
  const h = createHistory(3);
  for (let i = 0; i < 5; i++) h.observe({ id: 'b', meta: { name: String(i) }, cards: {}, groups: {} });
  assert.equal(h.undo().meta.name, '3');
  assert.equal(h.undo().meta.name, '2');
  assert.equal(h.undo(), null);
  h.observe({ id: 'other', meta: {}, cards: {}, groups: {} });
  assert.equal(h.undo(), null);
});

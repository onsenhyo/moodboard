import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normSelected, resolveSelected, deleteCardPatches, deleteGroupPatches, staleTombstones, viewCenter, DEFAULT_CENTER, GC_AGE_MS,
} from '../src/selection.js';
import { applyPatches } from '../src/patches.js';
import { panelOutputs } from '../src/panel.js';

const board = () => ({
  id: 'b',
  cards: [
    { id: 'a', kind: 'text', groupId: 'g', updatedAt: 1 },
    { id: 'c', kind: 'image', groupId: 'g', updatedAt: 1 },
    { id: 'd', kind: 'image', deleted: true, updatedAt: 1 },
    { id: 'e', kind: 'link', groupId: 'h', updatedAt: 1 },
  ],
  groups: [{ id: 'g', name: '하나', updatedAt: 1 }, { id: 'h', name: '둘', updatedAt: 1 }, { id: 'x', deleted: true }],
});

test('normSelected: 모양이 맞는 것만', () => {
  assert.deepEqual(normSelected({ kind: 'card', id: 'a', extra: 1 }), { kind: 'card', id: 'a' });
  assert.equal(normSelected({ kind: 'other', id: 'a' }), null);
  assert.equal(normSelected({ kind: 'card', id: '' }), null);
  assert.equal(normSelected('a'), null);
  assert.equal(normSelected(null), null);
});

test('resolveSelected: 살아 있는 카드와 묶음(카드 수 포함)만', () => {
  const b = board();
  assert.equal(resolveSelected({ kind: 'card', id: 'a' }, b).card.id, 'a');
  assert.equal(resolveSelected({ kind: 'card', id: 'd' }, b), null);
  assert.equal(resolveSelected({ kind: 'card', id: 'zz' }, b), null);
  const g = resolveSelected({ kind: 'group', id: 'g' }, b);
  assert.equal(g.group.name, '하나');
  assert.equal(g.count, 2);
  assert.equal(resolveSelected({ kind: 'group', id: 'x' }, b), null);
  assert.equal(resolveSelected(null, b), null);
  assert.equal(resolveSelected({ kind: 'card', id: 'a' }, null), null);
});

test('selected → 옆 칸 입력: 묶음이면 group 칸, 카드면 카드 칸', () => {
  const b = board();
  const g = resolveSelected({ kind: 'group', id: 'g' }, b);
  const out = panelOutputs({ group: { id: g.group.id, name: g.group.name, count: g.count } });
  assert.equal(out.has_group_selected, true);
  assert.deepEqual(out.group_selected, { id: 'g', name: '하나', count: 2 });
  assert.equal(out.sel_has, false);
  const c = resolveSelected({ kind: 'card', id: 'a' }, b).card;
  const card = panelOutputs({ id: c.id, kind: c.kind, title: 't', text: 'hi' });
  assert.equal(card.sel_is_text, true);
  assert.equal(card.sel_text, 'hi');
  assert.equal(panelOutputs(resolveSelected({ kind: 'card', id: 'd' }, b)).sel_none, true);
});

test('deleteCardPatches: 묘비 패치, 적용하면 deleted와 updatedAt', () => {
  const b = board();
  const ps = deleteCardPatches(b, 'a');
  assert.deepEqual(ps, [{ kind: 'card', boardId: 'b', id: 'a', fields: { deleted: true } }]);
  const d = applyPatches({ version: 1, boards: [b] }, ps.map((p) => ({ ...p, t: 50 })));
  assert.equal(d.boards[0].cards[0].deleted, true);
  assert.equal(d.boards[0].cards[0].updatedAt, 50);
  assert.deepEqual(deleteCardPatches(b, 'd'), []); // 이미 지운 것
  assert.deepEqual(deleteCardPatches(b, 'zz'), []);
});

test('deleteGroupPatches: 묶음은 묘비, 안의 카드는 groupId 키만 지우고 남는다', () => {
  const b = board();
  const ps = deleteGroupPatches(b, 'g');
  const d = applyPatches({ version: 1, boards: [b] }, ps.map((p) => ({ ...p, t: 70 })));
  const nb = d.boards[0];
  assert.equal(nb.groups[0].deleted, true);
  assert.equal(nb.groups[0].updatedAt, 70);
  for (const id of ['a', 'c']) {
    const c = nb.cards.find((x) => x.id === id);
    assert.equal('groupId' in c, false);
    assert.equal(c.updatedAt, 70);
    assert.equal(c.deleted, undefined);
  }
  assert.equal(nb.cards.find((x) => x.id === 'e').groupId, 'h');
  assert.deepEqual(deleteGroupPatches(nb, 'g'), []);
});

test('staleTombstones: 지운 지 7일이 지난 묘비만, 되살린 카드는 아니다', () => {
  const now = 100 * GC_AGE_MS;
  const doc = { boards: [{ id: 'b', cards: [
    { id: 'old', deleted: true, updatedAt: now - GC_AGE_MS },
    { id: 'fresh', deleted: true, updatedAt: now - GC_AGE_MS + 1 },
    { id: 'live', updatedAt: 0 },
    { id: 'revived', deleted: false, updatedAt: 0 },
  ] }, { id: 'b2' }] };
  assert.deepEqual(staleTombstones(doc, now).map((c) => c.id), ['old']);
  assert.deepEqual(staleTombstones(null, now), []);
});

test('viewCenter: view 상태의 가운데, 없거나 틀리면 기본 자리', () => {
  assert.deepEqual(viewCenter({ cx: 10, cy: 20, scale: 2 }), { x: 10, y: 20, scale: 2 });
  assert.deepEqual(viewCenter(null), { ...DEFAULT_CENTER, scale: 1 });
  assert.deepEqual(viewCenter({ cx: 10, cy: 20, scale: 0 }), { ...DEFAULT_CENTER, scale: 1 });
});

// --- collectCard ---

import { collectCard } from '../src/selection.js';

test('collectCard: 썸네일, 움직이는 GIF, 원본을 걷고 실패는 삼킨다', async () => {
  const log = [];
  const store = (name, fail) => ({ remove: async (id) => { log.push([name, id]); if (fail) throw new Error('x'); } });
  const jobs = collectCard(
    { id: 'c1', hasThumb: true, anim: true, origKey: 'orig/c1.gif' },
    { thumbs: store('thumbs'), gifs: store('gifs', true), blobs: store('blobs') },
  );
  await Promise.all(jobs);
  assert.deepEqual(log, [['thumbs', 'c1'], ['gifs', 'c1'], ['blobs', 'orig/c1.gif']]);
  // 썸네일 없는 카드: 썸네일은 건드리지 않지만 gif는(사본이 남았을 수 있어) 지운다
  log.length = 0;
  await Promise.all(collectCard({ id: 'c2' }, { thumbs: store('thumbs'), gifs: store('gifs'), blobs: store('blobs') }));
  assert.deepEqual(log, [['gifs', 'c2']]);
  // 동기적으로 던져도 괜찮다
  assert.doesNotThrow(() => collectCard({ id: 'c3', hasThumb: true }, { thumbs: { remove() { throw new Error('y'); } } }));
});

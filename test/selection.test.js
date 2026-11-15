import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normSelected, resolveSelected, deleteCard, deleteGroup, viewCenter, DEFAULT_CENTER } from '../src/selection.js';
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

test('deleteCard: 묘비로 남기고 updatedAt을 올린다', () => {
  const b = board();
  const c = deleteCard(b, 'a', 50);
  assert.equal(c.id, 'a');
  assert.equal(b.cards[0].deleted, true);
  assert.equal(b.cards[0].updatedAt, 50);
  assert.equal(deleteCard(b, 'a', 60), null); // 이미 지운 것
  assert.equal(deleteCard(b, 'zz', 60), null);
});

test('deleteGroup: 묶음은 묘비, 안의 카드는 groupId 키만 지우고 남는다', () => {
  const b = board();
  const g = deleteGroup(b, 'g', 70);
  assert.equal(g.id, 'g');
  assert.equal(b.groups[0].deleted, true);
  assert.equal(b.groups[0].updatedAt, 70);
  for (const id of ['a', 'c']) {
    const c = b.cards.find((x) => x.id === id);
    assert.equal('groupId' in c, false);
    assert.equal(c.updatedAt, 70);
    assert.equal(c.deleted, undefined);
  }
  assert.equal(b.cards.find((x) => x.id === 'e').groupId, 'h');
  assert.equal(deleteGroup(b, 'g', 80), null);
});

test('viewCenter: view 상태의 가운데, 없거나 틀리면 기본 자리', () => {
  assert.deepEqual(viewCenter({ cx: 10, cy: 20, scale: 2 }), { x: 10, y: 20, scale: 2 });
  assert.deepEqual(viewCenter(null), { ...DEFAULT_CENTER, scale: 1 });
  assert.deepEqual(viewCenter({ cx: 10, cy: 20, scale: 0 }), { ...DEFAULT_CENTER, scale: 1 });
});

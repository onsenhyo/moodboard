import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBoard, newGroup, liveGroups, effectiveGroupId, GROUP_DEFAULT_NAME, GROUP_DEFAULT_SIZE, GROUP_MIN_SIZE } from '../src/model.js';

test('newBoard는 빈 groups를 가진다', () => {
  const b = newBoard('보드');
  assert.deepEqual(b.groups, []);
  assert.deepEqual(b.cards, []);
});

test('newGroup: 기본 이름, collapsed false, 주어진 rect와 시각', () => {
  const g = newGroup({ rect: { x: 1, y: 2, w: 400, h: 300 } }, () => 42);
  assert.equal(typeof g.id, 'string');
  assert.ok(g.id.length > 0);
  assert.equal(g.name, '새 묶음');
  assert.equal(GROUP_DEFAULT_NAME, '새 묶음');
  assert.deepEqual(g.rect, { x: 1, y: 2, w: 400, h: 300 });
  assert.equal(g.collapsed, false);
  assert.equal(g.updatedAt, 42);
  assert.equal('deleted' in g, false);
  assert.notEqual(newGroup({ rect: g.rect }).id, g.id);
});

test('newGroup: 이름을 주면 그 이름, rect는 복사한다', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const g = newGroup({ name: '참고', rect });
  assert.equal(g.name, '참고');
  rect.x = 99;
  assert.equal(g.rect.x, 0);
  assert.equal(typeof g.updatedAt, 'number');
});

test('묶음 크기 상수', () => {
  assert.deepEqual(GROUP_DEFAULT_SIZE, { w: 400, h: 300 });
  assert.deepEqual(GROUP_MIN_SIZE, { w: 160, h: 100 });
});

test('liveGroups는 지운 묶음을 뺀다, groups가 없으면 []', () => {
  const b = { groups: [{ id: 'a' }, { id: 'b', deleted: true }, { id: 'c' }] };
  assert.deepEqual(liveGroups(b).map((g) => g.id), ['a', 'c']);
  assert.deepEqual(liveGroups({}), []);
  assert.deepEqual(liveGroups(null), []);
});

test('effectiveGroupId: 살아 있는 묶음만, orphan groupId는 null', () => {
  const b = { groups: [{ id: 'a' }, { id: 'gone', deleted: true }] };
  assert.equal(effectiveGroupId(b, { id: 'c1', groupId: 'a' }), 'a');
  assert.equal(effectiveGroupId(b, { id: 'c2', groupId: 'gone' }), null);
  assert.equal(effectiveGroupId(b, { id: 'c3', groupId: 'missing' }), null);
  assert.equal(effectiveGroupId(b, { id: 'c4' }), null);
  assert.equal(effectiveGroupId({}, { id: 'c5', groupId: 'a' }), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPartIds, exportAssetId, EXPORT_ASSET, MANIFEST_ASSET, CLIENT_PREFIX } from '../src/manifest.js';

test('매니페스트에서 보드 조각 id를 순서대로 꺼낸다', () => {
  const m = { client: [['moodboard-client-1', 1]], board: [['moodboard-board-js-1', 3], ['moodboard-board-js-2', 3]], export: ['moodboard-export', 2] };
  assert.deepEqual(boardPartIds(m), ['moodboard-board-js-1', 'moodboard-board-js-2']);
  assert.equal(exportAssetId(m), 'moodboard-export');
});

test('매니페스트가 없거나 모양이 틀리면 보드 조각은 빈 목록, 내보내기는 기본 id', () => {
  assert.deepEqual(boardPartIds(undefined), []);
  assert.deepEqual(boardPartIds({ board: 'x' }), []);
  assert.equal(exportAssetId(undefined), EXPORT_ASSET);
  assert.equal(exportAssetId({ export: [7] }), EXPORT_ASSET);
});

test('자산 id 이름', () => {
  assert.equal(MANIFEST_ASSET, 'moodboard-manifest');
  assert.equal(CLIENT_PREFIX + 1, 'moodboard-client-1');
});

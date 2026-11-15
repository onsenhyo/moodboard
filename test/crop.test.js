import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCrop, normCrop, isFull, cropSourceRect, cropHeight, cropPatch, uncropPatch, cropImageRect,
  cropHandleAt, dragCrop, createCropTracker, cropApplyPatch, CROP_MIN, FULL_CROP,
} from '../src/crop.js';
import { applyPatches } from '../src/patches.js';

const near = (a, b, msg) => {
  for (const k of Object.keys(b)) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${msg ?? ''} ${k}: ${a[k]} != ${b[k]}`);
};

test('canCrop: 썸네일이 있는 사진 카드만', () => {
  for (const kind of ['image', 'video', 'youtube', 'pinterest']) assert.equal(canCrop({ kind, hasThumb: true }), true, kind);
  assert.equal(canCrop({ kind: 'image', hasThumb: false }), false);
  assert.equal(canCrop({ kind: 'text', hasThumb: true }), false);
  assert.equal(canCrop({ kind: 'link', hasThumb: true }), false);
  assert.equal(canCrop(null), false);
});

test('normCrop: 잘못된 값은 null, 전체와 같으면 null, 그림 밖은 안으로', () => {
  assert.equal(normCrop(null), null);
  assert.equal(normCrop({ x: 0, y: 0, w: 1 }), null);
  assert.equal(normCrop({ x: 'a', y: 0, w: 1, h: 1 }), null);
  assert.equal(normCrop({ ...FULL_CROP }), null);
  assert.deepEqual(normCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
  near(normCrop({ x: 0.9, y: -1, w: 0.5, h: 0.01 }), { x: 0.9, y: 0, w: 0.1, h: CROP_MIN });
  assert.equal(isFull(FULL_CROP), true);
  assert.equal(isFull({ x: 0, y: 0, w: 0.99, h: 1 }), false);
});

test('cropSourceRect: crop과 썸네일 크기로 원본 px 사각형', () => {
  assert.deepEqual(cropSourceRect(null, 640, 480), { sx: 0, sy: 0, sw: 640, sh: 480 });
  near(cropSourceRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 640, 480), { sx: 160, sy: 240, sw: 320, sh: 120 });
  // 잘못된 crop은 전체로 그린다
  assert.deepEqual(cropSourceRect({ x: NaN, y: 0, w: 1, h: 1 }, 100, 50), { sx: 0, sy: 0, sw: 100, sh: 50 });
});

test('cropHeight: 폭을 지키고 잘린 비율로 높이를 맞춘다', () => {
  assert.equal(cropHeight(240, null, 640, 480), 180);
  assert.equal(cropHeight(240, { x: 0, y: 0, w: 0.5, h: 1 }, 640, 480), 360);
  assert.equal(cropHeight(240, { x: 0, y: 0.25, w: 1, h: 0.5 }, 640, 480), 90);
  assert.equal(cropHeight(240, null, 0, 480), null);
});

test('cropPatch와 uncropPatch: crop을 쓰고 지우며 manual.h를 맞춘다', () => {
  const card = { id: 'c', kind: 'image', hasThumb: true, manual: { x: 10, y: 20, w: 240, h: 180 }, updatedAt: 1 };
  const doc = { version: 1, boards: [{ id: 'b', cards: [card] }] };
  const p1 = cropPatch('b', card, { x: 0, y: 0, w: 0.5, h: 1 }, 640, 480);
  assert.deepEqual(p1, {
    kind: 'card', boardId: 'b', id: 'c',
    fields: { crop: { x: 0, y: 0, w: 0.5, h: 1 }, manual: { x: 10, y: 20, w: 240, h: 360 } },
  });
  const d1 = applyPatches(structuredClone(doc), [{ ...p1, t: 5 }]);
  const c1 = d1.boards[0].cards[0];
  assert.deepEqual(c1.crop, { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(c1.manual, { x: 10, y: 20, w: 240, h: 360 });
  assert.equal(c1.updatedAt, 5);

  const p2 = uncropPatch('b', c1, 640, 480);
  assert.deepEqual(p2.deleteKeys, ['crop']);
  const c2 = applyPatches(structuredClone(d1), [p2]).boards[0].cards[0];
  assert.ok(!('crop' in c2));
  assert.deepEqual(c2.manual, { x: 10, y: 20, w: 240, h: 180 });

  // 전체를 고르면 해제와 같다. 크기를 모르면 높이는 그대로
  assert.deepEqual(cropPatch('b', c1, FULL_CROP, 640, 480).deleteKeys, ['crop']);
  assert.equal(uncropPatch('b', c1, undefined, undefined).fields.manual.h, 360);
});

test('cropImageRect: 들어올 때의 crop이 사진 칸에 cover로 맞는 자리', () => {
  const inner = { x: 100, y: 50, w: 240, h: 180 };
  near(cropImageRect(inner, FULL_CROP, 640, 480), inner);
  // 왼쪽 절반을 자른 카드(240×360): 원본 전체는 폭 480, 왼쪽이 카드에 붙는다
  near(cropImageRect({ x: 0, y: 0, w: 240, h: 360 }, { x: 0, y: 0, w: 0.5, h: 1 }, 640, 480), { x: 0, y: 0, w: 480, h: 360 });
  near(cropImageRect({ x: 0, y: 0, w: 240, h: 360 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, 640, 480), { x: -240, y: 0, w: 480, h: 360 });
});

test('cropHandleAt: 모서리, 변, 안쪽, 바깥', () => {
  const r = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  const t = 0.02;
  assert.equal(cropHandleAt(r, 0.2, 0.2, t, t), 'nw');
  assert.equal(cropHandleAt(r, 0.81, 0.19, t, t), 'ne');
  assert.equal(cropHandleAt(r, 0.8, 0.8, t, t), 'se');
  assert.equal(cropHandleAt(r, 0.2, 0.8, t, t), 'sw');
  assert.equal(cropHandleAt(r, 0.5, 0.21, t, t), 'n');
  assert.equal(cropHandleAt(r, 0.5, 0.8, t, t), 's');
  assert.equal(cropHandleAt(r, 0.79, 0.5, t, t), 'e');
  assert.equal(cropHandleAt(r, 0.2, 0.5, t, t), 'w');
  assert.equal(cropHandleAt(r, 0.5, 0.5, t, t), 'move');
  assert.equal(cropHandleAt(r, 0.1, 0.5, t, t), null);
  assert.equal(cropHandleAt(r, 0.5, 0.9, t, t), null);
  // 작은 사각형은 가까운 쪽
  const s = { x: 0.5, y: 0.5, w: 0.02, h: 0.02 };
  assert.equal(cropHandleAt(s, 0.505, 0.505, t, t), 'nw');
  assert.equal(cropHandleAt(s, 0.518, 0.518, t, t), 'se');
});

test('dragCrop: 손잡이 끌기, 그림 안에 두기, 변마다 5% 이상', () => {
  const r = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  near(dragCrop(r, 'move', 0.1, -0.1), { x: 0.3, y: 0.1, w: 0.6, h: 0.6 });
  near(dragCrop(r, 'move', 0.5, -0.5), { x: 0.4, y: 0, w: 0.6, h: 0.6 }, '이동은 그림 안');
  near(dragCrop(r, 'e', 0.1, 0.3), { x: 0.2, y: 0.2, w: 0.7, h: 0.6 }, '변은 한 축만');
  near(dragCrop(r, 'e', 0.5, 0), { x: 0.2, y: 0.2, w: 0.8, h: 0.6 }, '오른쪽 끝까지');
  near(dragCrop(r, 'w', -0.5, 0), { x: 0, y: 0.2, w: 0.8, h: 0.6 }, '왼쪽 끝까지');
  near(dragCrop(r, 'w', 0.9, 0), { x: 0.8 - CROP_MIN, y: 0.2, w: CROP_MIN, h: 0.6 }, '최소 폭');
  near(dragCrop(r, 'n', 0, 0.9), { x: 0.2, y: 0.8 - CROP_MIN, w: 0.6, h: CROP_MIN }, '최소 높이');
  near(dragCrop(r, 's', 0, -0.9), { x: 0.2, y: 0.2, w: 0.6, h: CROP_MIN });
  near(dragCrop(r, 'se', 0.1, 0.1), { x: 0.2, y: 0.2, w: 0.7, h: 0.7 });
  near(dragCrop(r, 'nw', -0.3, -0.3), { x: 0, y: 0, w: 0.8, h: 0.8 });
  near(dragCrop(r, 'ne', 0.1, 0.1), { x: 0.2, y: 0.3, w: 0.7, h: 0.5 });
  near(dragCrop(r, 'sw', -0.1, -0.7), { x: 0.1, y: 0.2, w: 0.7, h: CROP_MIN });
});

test('createCropTracker: 처음 값은 건너뛰고 n이 바뀔 때만 id', () => {
  const next = createCropTracker({ id: 'a', n: 1 });
  assert.equal(next({ id: 'a', n: 1 }), null);
  assert.equal(next({ id: 'b', n: 2 }), 'b');
  assert.equal(next({ id: 'b', n: 2 }), null);
  assert.equal(next(null), null);
  assert.equal(next({ n: 3 }), null);
  assert.equal(createCropTracker(null)({ id: 'x', n: 9 }), 'x');
});

test('photoSource: 정지 썸네일과 GIF 프레임 모두 card.crop 비율로 원본 사각형을 낸다', async () => {
  const { photoSource } = await import('../src/render.js');
  const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.8 };
  // ImageBitmap(정지 썸네일)은 width/height, VideoFrame(GIF 프레임)은 displayWidth/displayHeight
  assert.deepEqual(photoSource({ crop }, { width: 200, height: 100 }), { sx: 50, sy: 10, sw: 100, sh: 80 });
  assert.deepEqual(photoSource({ anim: true, crop }, { displayWidth: 400, displayHeight: 200 }), { sx: 100, sy: 20, sw: 200, sh: 160 });
  assert.deepEqual(photoSource({ anim: true }, { displayWidth: 40, displayHeight: 30 }), { sx: 0, sy: 0, sw: 40, sh: 30 });
});

test('cropApplyPatch: 들어올 때 잡아 둔 썸네일 크기로 적용한다(그 사이 비트맵 캐시가 비어도)', () => {
  const card = { id: 'c', kind: 'image', hasThumb: true, manual: { x: 10, y: 20, w: 240, h: 180 } };
  const rect = { x: 0, y: 0, w: 0.5, h: 1 };
  const c = { id: 'c', base: { ...FULL_CROP }, rect, size: { width: 640, height: 480 } };
  assert.deepEqual(cropApplyPatch('b', card, c, null), cropPatch('b', card, rect, 640, 480));
  // 잡아 둔 크기가 없으면 지금 크기를 쓴다
  assert.deepEqual(cropApplyPatch('b', card, { ...c, size: null }, { width: 640, height: 480 }), cropPatch('b', card, rect, 640, 480));
  // 둘 다 없으면 높이를 맞출 수 없으므로 적용하지 않는다
  assert.equal(cropApplyPatch('b', card, { ...c, size: null }, null), null);
  // 바뀐 것이 없으면(전체 → 전체) 없음
  assert.equal(cropApplyPatch('b', card, { ...c, rect: { ...FULL_CROP } }, null), null);
  // 전체로 되돌리면 해제
  const cropped = { ...card, crop: { x: 0, y: 0, w: 0.5, h: 1 } };
  assert.deepEqual(cropApplyPatch('b', cropped, { ...c, rect: { ...FULL_CROP } }, null).deleteKeys, ['crop']);
  assert.equal(cropApplyPatch('b', null, c, null), null);
});

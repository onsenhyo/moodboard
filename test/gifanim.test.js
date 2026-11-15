import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animDelay, frameDelay, advance, ANIM_FRAME_MS, createGifPlayer } from '../src/gifanim.js';

test('animDelay: anim 카드가 화면에 있고 표면과 페이지가 보일 때만 약 30fps로 돈다', () => {
  const on = { animating: true, surfaceVisible: true, pageVisible: true };
  assert.equal(Math.round(1000 / ANIM_FRAME_MS), 30);
  assert.equal(animDelay(on), ANIM_FRAME_MS);
  assert.equal(animDelay({ ...on, sinceLastMs: 10 }), ANIM_FRAME_MS - 10);
  assert.equal(animDelay({ ...on, sinceLastMs: 100 }), 0);
  assert.equal(animDelay({ ...on, animating: false }), null);
  assert.equal(animDelay({ ...on, surfaceVisible: false }), null);
  assert.equal(animDelay({ ...on, pageVisible: false }), null);
});

test('frameDelay: 10ms 이하와 이상한 값은 100ms', () => {
  assert.equal(frameDelay(0), 100);
  assert.equal(frameDelay(10), 100);
  assert.equal(frameDelay(NaN), 100);
  assert.equal(frameDelay(20), 20);
  assert.equal(frameDelay(150), 150);
});

test('advance: 프레임 길이만큼 지나면 다음으로, 끝에서 처음으로, 준비 안 된 프레임에서는 머문다', () => {
  const durs = [100, 50, 200];
  const ready = new Set([0, 1, 2]);
  const durOf = (i) => (ready.has(i) ? durs[i] : null);
  const p = { cur: 0, due: undefined };
  assert.equal(advance(p, 0, 3, durOf), false); // 첫 프레임 시작
  assert.equal(p.due, 100);
  assert.equal(advance(p, 99, 3, durOf), false);
  assert.equal(advance(p, 100, 3, durOf), true);
  assert.equal(p.cur, 1);
  assert.equal(advance(p, 160, 3, durOf), true); // 150에서 2로
  assert.equal(p.cur, 2);
  assert.equal(advance(p, 360, 3, durOf), true); // 350에서 0으로 돈다
  assert.equal(p.cur, 0);
  ready.delete(1);
  assert.equal(advance(p, 500, 3, durOf), false); // 1이 아직 없으면 0에 머문다
  assert.equal(p.cur, 0);
  ready.add(1);
  assert.equal(advance(p, 501, 3, durOf), true);
  assert.equal(p.cur, 1);
});

test('advance: 한참 밀렸으면 따라잡지 않고 지금부터 센다. 한 프레임짜리는 움직이지 않는다', () => {
  const p = { cur: 0, due: 100 };
  assert.equal(advance(p, 10_000, 2, () => 100), true);
  assert.equal(p.cur, 1);
  assert.equal(p.due, 10_100);
  const one = { cur: 0, due: undefined };
  assert.equal(advance(one, 1e9, 1, () => 100), false);
  assert.equal(one.cur, 0);
});

test('createGifPlayer: 처음 frame에서만 읽고(lazy), retain 밖의 카드는 놓으며, 원본이 없으면 invalidate 뒤 다시 읽는다', async () => {
  const loads = [];
  const player = createGifPlayer({ load: async (id) => { loads.push(id); return null; }, useDecoder: false });
  assert.equal(player.frame({ id: 'a' }, 0), null);
  assert.equal(player.frame({ id: 'a' }, 1), null);
  await new Promise((r) => setTimeout(r, 0));
  player.frame({ id: 'a' }, 2);
  assert.deepEqual(loads, ['a']); // 없던 원본은 invalidate 전에는 다시 읽지 않는다
  player.invalidate();
  player.frame({ id: 'a' }, 3);
  assert.deepEqual(loads, ['a', 'a']);
  player.retain(new Set());
  player.frame({ id: 'a' }, 4);
  assert.deepEqual(loads, ['a', 'a', 'a']); // 놓은 카드는 다시 읽는다
});

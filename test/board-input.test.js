import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wheelView, isMouseWheel, gestureView, deltaPx, stateFromView, viewFromState, createCmdTracker, keyEffect, LINE_PX,
} from '../src/board/input.js';
import { MIN_SCALE, MAX_SCALE } from '../src/interaction.js';
import { toWorld } from '../src/layout.js';

const SIZE = { w: 800, h: 600 };
const V = { x: 100, y: 50, scale: 2 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('wheel: px 단위 이동은 화면 px를 배율로 나눠 월드에서 옮긴다', () => {
  const v = wheelView(V, { deltaX: 20, deltaY: -40, deltaMode: 0, x: 0, y: 0 }, SIZE);
  assert.deepEqual(v, { x: 110, y: 30, scale: 2 });
});

test('wheel: 줄 단위(deltaMode 1)는 16px, 쪽 단위(2)는 표면 크기', () => {
  assert.deepEqual(deltaPx({ deltaX: 1, deltaY: 3, deltaMode: 1 }, SIZE), { dx: LINE_PX, dy: 3 * LINE_PX });
  assert.deepEqual(deltaPx({ deltaX: 0.5, deltaY: 1, deltaMode: 2 }, SIZE), { dx: 400, dy: 600 });
  const v = wheelView({ x: 0, y: 0, scale: 1 }, { deltaY: 2, deltaMode: 1, x: 0, y: 0 }, SIZE);
  assert.deepEqual(v, { x: 0, y: 32, scale: 1 });
});

test('wheel: shift만 누른 세로 휠은 가로로 옮긴다', () => {
  const v = wheelView({ x: 0, y: 0, scale: 1 }, { deltaX: 0, deltaY: 30, shiftKey: true, x: 0, y: 0 }, SIZE);
  assert.deepEqual(v, { x: 30, y: 0, scale: 1 });
});

test('wheel: delta가 0이면 같은 view 객체', () => {
  assert.equal(wheelView(V, { deltaX: 0, deltaY: 0, x: 1, y: 1 }, SIZE), V);
  assert.equal(wheelView(V, { deltaY: 0, ctrlKey: true, x: 1, y: 1 }, SIZE), V);
});

test('ctrl+wheel(집기): 위로 집으면 확대, 커서 아래 월드 점이 그대로 있다', () => {
  const at = { x: 300, y: 200 };
  const before = toWorld(V, at);
  const v = wheelView(V, { deltaY: -10, ctrlKey: true, ...at }, SIZE);
  assert.ok(v.scale > V.scale);
  near(v.scale, 2 * Math.exp(0.1));
  const after = toWorld(v, at);
  near(after.x, before.x);
  near(after.y, before.y);
  assert.ok(wheelView(V, { deltaY: 10, ctrlKey: true, ...at }, SIZE).scale < V.scale);
});

test('ctrl+wheel: 큰 마우스 휠 한 칸도 한 번에 너무 크게 확대하지 않고, 배율은 MIN·MAX 안', () => {
  const one = wheelView({ x: 0, y: 0, scale: 1 }, { deltaY: -1000, ctrlKey: true, x: 0, y: 0 }, SIZE);
  near(one.scale, Math.exp(0.5));
  let v = { x: 0, y: 0, scale: 1 };
  for (let i = 0; i < 50; i++) v = wheelView(v, { deltaY: -100, ctrlKey: true, x: 10, y: 10 }, SIZE);
  assert.equal(v.scale, MAX_SCALE);
  for (let i = 0; i < 100; i++) v = wheelView(v, { deltaY: 100, ctrlKey: true, x: 10, y: 10 }, SIZE);
  assert.equal(v.scale, MIN_SCALE);
});

test('ctrl+wheel 줄 단위도 px로 바꿔 확대한다', () => {
  const v = wheelView({ x: 0, y: 0, scale: 1 }, { deltaY: -1, deltaMode: 1, ctrlKey: true, x: 0, y: 0 }, SIZE);
  near(v.scale, Math.exp(LINE_PX * 0.01));
});

test('gesture: base × e.scale로 맞추고 커서를 고정한다', () => {
  const at = { x: 400, y: 300 };
  const before = toWorld(V, at);
  const v = gestureView(V, 2, { scale: 1.5, ...at });
  near(v.scale, 3);
  const after = toWorld(v, at);
  near(after.x, before.x);
  near(after.y, before.y);
  assert.equal(gestureView(V, 2, { scale: 100, ...at }).scale, MAX_SCALE);
  assert.equal(gestureView(V, 2, { scale: 0, ...at }), V);
  assert.equal(gestureView(V, 2, { scale: 1, ...at }), V);
});

test('view 상태: 화면 가운데 월드 좌표와 배율로 오가고 되돌리면 같다', () => {
  const s = stateFromView(V, SIZE);
  assert.deepEqual(s, { cx: 300, cy: 200, scale: 2 });
  assert.deepEqual(viewFromState(s, SIZE), V);
  assert.equal(viewFromState(null, SIZE), null);
  assert.equal(viewFromState({ cx: 1, cy: 'a', scale: 1 }, SIZE), null);
  assert.equal(viewFromState({ cx: 1, cy: 1, scale: 0 }, SIZE), null);
  assert.equal(viewFromState({ cx: 0, cy: 0, scale: 99 }, SIZE).scale, MAX_SCALE);
});

test('cmd: 처음 값은 실행하지 않고 n이 바뀔 때만 op를 돌려준다', () => {
  const next = createCmdTracker({ op: 'fit', n: 1 });
  assert.equal(next({ op: 'fit', n: 1 }), null);
  assert.equal(next({ op: 'zoom_in', n: 2 }), 'zoom_in');
  assert.equal(next({ op: 'zoom_in', n: 2 }), null);
  assert.equal(next({ op: 'zoom_in', n: 3 }), 'zoom_in');
  assert.equal(next(null), null);
  assert.equal(next({ n: 4 }), null);
  const fresh = createCmdTracker(null);
  assert.equal(fresh({ op: 'zoom_out', n: 1 }), 'zoom_out');
});

test('키: Delete·Backspace는 지우기, Esc는 선택 풀기, 수정 키와 입력 중에는 없음', () => {
  assert.equal(keyEffect({ key: 'Delete' }), 'delete');
  assert.equal(keyEffect({ key: 'Backspace' }), 'delete');
  assert.equal(keyEffect({ key: 'Escape' }), 'clear');
  assert.equal(keyEffect({ key: 'Backspace', metaKey: true }), null);
  assert.equal(keyEffect({ key: 'Delete', ctrlKey: true }), null);
  assert.equal(keyEffect({ key: 'Delete', editing: true }), null);
  assert.equal(keyEffect({ key: 'a' }), null);
  assert.equal(keyEffect(null), null);
});

test('isMouseWheel: 트랙패드(wheelDeltaY = -3 × deltaY)와 가로 성분은 마우스가 아니고, 120 단위 휠과 줄 단위는 마우스다', () => {
  assert.equal(isMouseWheel({ deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 }), false);
  assert.equal(isMouseWheel({ deltaX: 2, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 }), false);
  assert.equal(isMouseWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 }), true);
  assert.equal(isMouseWheel({ deltaX: 0, deltaY: -125, deltaMode: 0, wheelDeltaY: 120 }), true);
  assert.equal(isMouseWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }), true);
  assert.equal(isMouseWheel({ deltaX: 0, deltaY: 7, deltaMode: 0 }), false);
});

test('마우스 휠은 커서를 고정하고 확대·축소하며, 한 칸은 약 1.2배다', () => {
  const at = { x: 300, y: 200 };
  const before = toWorld(V, at);
  const v = wheelView(V, { deltaY: -100, mouse: true, ...at }, SIZE);
  near(v.scale, 2 * Math.exp(0.18));
  const after = toWorld(v, at);
  near(after.x, before.x);
  near(after.y, before.y);
  assert.ok(wheelView(V, { deltaY: 100, mouse: true, ...at }, SIZE).scale < V.scale);
  near(wheelView(V, { deltaY: -1000, mouse: true, ...at }, SIZE).scale, v.scale);
});

test('shift + 마우스 휠은 확대하지 않고 가로로 옮긴다', () => {
  const v = wheelView({ x: 0, y: 0, scale: 1 }, { deltaY: 30, mouse: true, shiftKey: true, x: 0, y: 0 }, SIZE);
  assert.deepEqual(v, { x: 30, y: 0, scale: 1 });
});

test('keyEffect: ⌘Z·Ctrl+Z 되돌리기, 시프트·Ctrl+Y 다시 하기, 한글 입력(key ㅋ)에서도, 편집 중에는 없음', () => {
  const k = (e) => keyEffect({ key: 'z', code: 'KeyZ', ...e });
  assert.equal(k({ metaKey: true }), 'undo');
  assert.equal(k({ ctrlKey: true }), 'undo');
  assert.equal(k({ ctrlKey: true, key: 'ㅋ' }), 'undo');
  assert.equal(k({ metaKey: true, shiftKey: true, key: 'Z' }), 'redo');
  assert.equal(keyEffect({ key: 'y', code: 'KeyY', ctrlKey: true }), 'redo');
  assert.equal(keyEffect({ key: 'y', code: 'KeyY', metaKey: true }), null);
  assert.equal(k({ ctrlKey: true, altKey: true }), null);
  assert.equal(k({}), null);
  assert.equal(k({ ctrlKey: true, editing: true }), null);
});

// sandbox 보드의 입력을 view 변화로 바꾸는 순수 도구. 브라우저 API를 쓰지 않는다.
//
// view = {x, y, scale}: interaction.js와 같은 모양(화면 = (월드 − view.xy) × scale).
// wheelView(view, e, size) -> view
//   e = {deltaX, deltaY, deltaMode, ctrlKey, shiftKey, x, y}. x·y는 표면 안 CSS px.
//   deltaMode 0은 px, 1은 줄(16px), 2는 쪽(표면 높이·폭). ctrl은 집기(트랙패드 핀치)라서 커서를 고정하고 확대한다.
//   ctrl 없는 wheel은 이동이다. shift만 누르고 deltaX가 0이면 deltaY를 가로로 쓴다(마우스 휠).
// gestureView(view, base, e, size) -> view
//   WebKit gesturestart/gesturechange. base는 gesturestart 때의 scale, e.scale은 그때부터의 배수다.
// stateFromView / viewFromState: 창 상태 view {cx, cy, scale}(화면 가운데의 월드 좌표)와 바꾼다.
// createCmdTracker(initial) -> (cmd) -> op|null: cmd {op, n}의 n이 바뀔 때만 op를 돌려준다.
//   처음 값(창을 다시 열 때 남은 cmd)은 실행하지 않는다.
// keyEffect(e) -> 'delete'|'clear'|null: e = {key, metaKey, ctrlKey, altKey, editing}.

import { zoomAt, MIN_SCALE, MAX_SCALE } from '../interaction.js';

export const LINE_PX = 16;
// ctrl+wheel 한 단위(px)의 확대 세기. 트랙패드 핀치 deltaY는 작게 여러 번 온다.
export const PINCH_K = 0.01;
// 마우스 휠 한 칸(약 100px)이 너무 크게 확대하지 않게 한 번에 쓰는 delta를 자른다.
const PINCH_MAX_DELTA = 50;

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function deltaPx(e, size) {
  const mode = e.deltaMode | 0;
  const kx = mode === 1 ? LINE_PX : mode === 2 ? size.w : 1;
  const ky = mode === 1 ? LINE_PX : mode === 2 ? size.h : 1;
  let dx = (Number(e.deltaX) || 0) * kx;
  let dy = (Number(e.deltaY) || 0) * ky;
  if (e.shiftKey && !dx) { dx = dy; dy = 0; }
  return { dx, dy };
}

export function wheelView(view, e, size) {
  const { dx, dy } = deltaPx(e, size);
  if (e.ctrlKey) {
    const d = Math.max(-PINCH_MAX_DELTA, Math.min(PINCH_MAX_DELTA, dy));
    if (!d) return view;
    return zoomAt(view, Math.exp(-d * PINCH_K), { x: e.x, y: e.y });
  }
  if (!dx && !dy) return view;
  return { x: view.x + dx / view.scale, y: view.y + dy / view.scale, scale: view.scale };
}

export function gestureView(view, base, e) {
  const s = Number(e.scale);
  if (!(s > 0) || !(base > 0)) return view;
  const target = clampScale(base * s);
  if (target === view.scale) return view;
  return zoomAt(view, target / view.scale, { x: e.x, y: e.y });
}

export function stateFromView(view, size) {
  const r = (v, k) => Math.round(v * k) / k;
  return {
    cx: r(view.x + size.w / 2 / view.scale, 100),
    cy: r(view.y + size.h / 2 / view.scale, 100),
    scale: r(view.scale, 10000),
  };
}

export function viewFromState(v, size) {
  if (!v || typeof v !== 'object') return null;
  const { cx, cy } = v;
  const scale = Number(v.scale);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(scale > 0)) return null;
  const s = clampScale(scale);
  return { x: cx - size.w / 2 / s, y: cy - size.h / 2 / s, scale: s };
}

export function createCmdTracker(initial) {
  let last = initial && typeof initial === 'object' ? initial.n : undefined;
  return (cmd) => {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') return null;
    if (cmd.n === last) return null;
    last = cmd.n;
    return cmd.op;
  };
}

export function keyEffect(e) {
  if (!e || e.editing) return null;
  if (e.key === 'Escape') return 'clear';
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) return 'delete';
  return null;
}

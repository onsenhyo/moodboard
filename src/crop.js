// 사진 카드 자르기의 순수한 부분. render.js, board/board.js, main.js, viewer.js가 쓰고 node 테스트로 확인한다.
//
// 카드 필드 crop = {x, y, w, h}: 원본(썸네일) 그림에 대한 0~1 비율. 없으면 그림 전체다.
// - canCrop(card): 썸네일로 그리는 사진 카드(image, video, youtube, pinterest)인가.
// - normCrop(v) -> 올바른 crop | null. 숫자가 아니거나 그림 밖이면 null, 전체와 같으면 null.
// - cropSourceRect(crop, tw, th) -> {sx, sy, sw, sh}: 썸네일 px에서 그릴 원본 사각형.
// - cropHeight(w, crop, tw, th) -> 폭 w를 지키고 잘린 비율에 맞춘 카드 높이.
// - cropPatch(boardId, card, crop, tw, th) / uncropPatch(boardId, card, tw, th): crop을 쓰거나 지우고 manual.h를 맞추는 패치.
// - cropImageRect(inner, base, tw, th) -> 자르기 화면에서 원본 전체를 그릴 화면 rect.
//   base(들어올 때의 crop)가 카드 사진 칸(inner)에 cover로 들어가게 둔 자리다.
// - cropHandleAt(rect, u, v, tolU, tolV) -> 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|null (u, v는 0~1 그림 좌표)
// - dragCrop(rect, handle, du, dv, min) -> 손잡이를 du, dv만큼 끈 새 rect. 그림 안에 두고 변마다 min(5%) 이상.
// - createCropTracker(initial): 창 상태 crop_target {id, n}의 n이 바뀔 때만 id를 낸다.

export const CROP_KINDS = Object.freeze(new Set(['image', 'video', 'youtube', 'pinterest']));
export const CROP_MIN = 0.05;
export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const CROP_HINT = '드래그로 자르기 · Enter 적용 · Esc 취소';
const EPS = 1e-6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const canCrop = (card) => !!(card && card.hasThumb && !card.deleted && CROP_KINDS.has(card.kind));

export function normCrop(v) {
  if (!v || typeof v !== 'object') return null;
  const { x, y, w, h } = v;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const nx = clamp(x, 0, 1 - CROP_MIN), ny = clamp(y, 0, 1 - CROP_MIN);
  const nw = clamp(w, CROP_MIN, 1 - nx), nh = clamp(h, CROP_MIN, 1 - ny);
  if (isFull({ x: nx, y: ny, w: nw, h: nh })) return null;
  return { x: nx, y: ny, w: nw, h: nh };
}

export const isFull = (r) => !r || (r.x <= EPS && r.y <= EPS && r.w >= 1 - EPS && r.h >= 1 - EPS);

export function cropSourceRect(crop, tw, th) {
  const c = normCrop(crop) ?? FULL_CROP;
  return { sx: c.x * tw, sy: c.y * th, sw: c.w * tw, sh: c.h * th };
}

export function cropHeight(w, crop, tw, th) {
  const { sw, sh } = cropSourceRect(crop, tw, th);
  if (!(sw > 0 && sh > 0 && w > 0)) return null;
  return Math.max(1, Math.round((w * sh) / sw));
}

function manualWithHeight(card, crop, tw, th) {
  const m = card.manual ?? { x: 0, y: 0, w: 240, h: 180 };
  const h = tw > 0 && th > 0 ? cropHeight(m.w, crop, tw, th) : null;
  return { x: m.x, y: m.y, w: m.w, h: h ?? m.h };
}

// 전체를 고르면 자르기 해제와 같다.
export function cropPatch(boardId, card, crop, tw, th) {
  const c = normCrop(crop);
  if (!c) return uncropPatch(boardId, card, tw, th);
  return { kind: 'card', boardId, id: card.id, fields: { crop: c, manual: manualWithHeight(card, c, tw, th) } };
}

export function uncropPatch(boardId, card, tw, th) {
  return { kind: 'card', boardId, id: card.id, fields: { manual: manualWithHeight(card, null, tw, th) }, deleteKeys: ['crop'] };
}

export function cropImageRect(inner, base, tw, th) {
  const { sx, sy, sw, sh } = cropSourceRect(base, tw, th);
  const k = Math.max(inner.w / sw, inner.h / sh);
  return {
    x: inner.x + inner.w / 2 - (sx + sw / 2) * k,
    y: inner.y + inner.h / 2 - (sy + sh / 2) * k,
    w: tw * k,
    h: th * k,
  };
}

export function cropHandleAt(rect, u, v, tolU, tolV) {
  const { x, y, w, h } = rect;
  const r = x + w, b = y + h;
  const inX = u >= x - tolU && u <= r + tolU;
  const inY = v >= y - tolV && v <= b + tolV;
  if (!inX || !inY) return null;
  const nearL = Math.abs(u - x) <= tolU, nearR = Math.abs(u - r) <= tolU;
  const nearT = Math.abs(v - y) <= tolV, nearB = Math.abs(v - b) <= tolV;
  // 사각형이 작아 양쪽이 다 가까우면 더 가까운 쪽을 고른다.
  const horiz = nearL && nearR ? (Math.abs(u - x) <= Math.abs(u - r) ? 'w' : 'e') : nearL ? 'w' : nearR ? 'e' : '';
  const vert = nearT && nearB ? (Math.abs(v - y) <= Math.abs(v - b) ? 'n' : 's') : nearT ? 'n' : nearB ? 's' : '';
  if (vert || horiz) return vert + horiz;
  if (u > x && u < r && v > y && v < b) return 'move';
  return null;
}

export function dragCrop(rect, handle, du, dv, min = CROP_MIN) {
  let { x, y, w, h } = rect;
  if (handle === 'move') {
    return { x: clamp(x + du, 0, 1 - w), y: clamp(y + dv, 0, 1 - h), w, h };
  }
  let l = x, t = y, r = x + w, b = y + h;
  if (handle.includes('w')) l = clamp(l + du, 0, r - min);
  if (handle.includes('e')) r = clamp(r + du, l + min, 1);
  if (handle.includes('n')) t = clamp(t + dv, 0, b - min);
  if (handle.includes('s')) b = clamp(b + dv, t + min, 1);
  return { x: l, y: t, w: r - l, h: b - t };
}

export function createCropTracker(initial) {
  let last = initial && typeof initial === 'object' ? initial.n : undefined;
  return (v) => {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string') return null;
    if (v.n === last) return null;
    last = v.n;
    return v.id;
  };
}

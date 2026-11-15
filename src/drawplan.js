// 캔버스 그리기의 순수한 부분. render.js(브라우저 전용)가 쓰고, node 테스트로 확인한다.
//
// drawList(scene) -> [{kind:'background'} | {kind:'group', id} | {kind:'card', id} | {kind:'selection', target:'card'|'group', id}]
//   그리는 순서: 바탕 → 살아 있는 묶음(수동 배치에서만) → visibleCards → 선택선.
// cardChrome(theme, card, s, scale) -> {outer, inner, matBg, caption, badgeAt, shadows}
//   s는 카드의 화면 rect. 사진 카드(hasThumb)는 라이트에서 흰 매트 안쪽(inner)에 그림을 그린다.
// groupBox(group, s) -> 묶음의 화면 상자. 접힌 묶음은 28px 제목줄만.
// groupLabel(theme, group, count) -> 묶음 이름 글자. 펼침 '▾ 이름', 접힘 '▸ 이름 · N장'.
// groupMembers(cards, groupId) -> 그 묶음에 든 카드.

import { visibleCards } from './interaction.js';
import { GROUP_TITLE_PX } from './layout.js';

// 매트 캡션에 쓰는 종류 이름. 이 밖의 종류는 캡션이 없다.
export const CAPTION_WORDS = Object.freeze({ youtube: 'youtube', pinterest: 'pinterest', image: 'image', video: 'video' });

const BADGE_INSET = 6;
const CAPTION_LEFT = 2; // 매트 안쪽 왼쪽에서 더 들어가는 거리(목업 left:8 = pad 6 + 2)
const CAPTION_BOTTOM = 5; // 카드 아래에서 글자 바닥까지(목업 bottom:5)
const CAPTION_MIN_PX = 13; // 매트 아랫단이 이보다 얇으면 캡션을 쓰지 않는다

const live = (groups) => (groups ?? []).filter((g) => g && !g.deleted);

export function drawList(scene) {
  const out = [{ kind: 'background' }];
  const manual = scene.mode !== 'sorted';
  const groups = manual ? live(scene.groups) : [];
  for (const g of groups) out.push({ kind: 'group', id: g.id });
  const cards = visibleCards({ mode: scene.mode, cards: scene.cards ?? [], groups: scene.groups ?? [] });
  for (const c of cards) out.push({ kind: 'card', id: c.id });
  if (scene.selectedId && cards.some((c) => c.id === scene.selectedId)) {
    out.push({ kind: 'selection', target: 'card', id: scene.selectedId });
  } else if (scene.selectedGroupId && groups.some((g) => g.id === scene.selectedGroupId)) {
    out.push({ kind: 'selection', target: 'group', id: scene.selectedGroupId });
  }
  return out;
}

export function cardChrome(theme, card, s, scale = 1) {
  const photo = !!card?.hasThumb;
  const base = {
    outer: s,
    inner: s,
    matBg: null,
    caption: null,
    badgeAt: { x: s.x + BADGE_INSET, y: s.y + BADGE_INSET },
    shadows: theme.shadow ?? [],
  };
  if (!photo || !theme.mat) return base;
  const pad = theme.mat.pad * scale;
  const bottom = theme.mat.bottom * scale;
  const inner = { x: s.x + pad, y: s.y + pad, w: s.w - pad * 2, h: s.h - pad - bottom };
  if (inner.w < 1 || inner.h < 1) return base; // 너무 작으면 매트 없이 꽉 채운다
  const word = CAPTION_WORDS[card.kind] ?? null;
  const caption = word && bottom >= CAPTION_MIN_PX
    ? { text: word, x: inner.x + CAPTION_LEFT * scale, y: s.y + s.h - CAPTION_BOTTOM * scale }
    : null;
  return {
    ...base,
    inner,
    matBg: theme.matBg ?? '#ffffff',
    caption,
    badgeAt: { x: inner.x + BADGE_INSET, y: inner.y + BADGE_INSET },
  };
}

export function groupBox(group, s) {
  if (!group?.collapsed) return s;
  return { x: s.x, y: s.y, w: s.w, h: Math.min(s.h, GROUP_TITLE_PX) };
}

export function groupLabel(theme, group, count) {
  const name = String(group?.name ?? '');
  const shown = theme.groupLabelUpper ? name.toUpperCase() : name;
  return group?.collapsed ? `▸ ${shown} · ${count}장` : `▾ ${shown}`;
}

export function groupMembers(cards, groupId) {
  return (cards ?? []).filter((c) => c && !c.deleted && c.groupId === groupId);
}

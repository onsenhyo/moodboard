// 캔버스 그리기의 순수한 부분. render.js(브라우저 전용)가 쓰고, node 테스트로 확인한다.
//
// drawList(scene) -> [{kind:'background'} | {kind:'group', id} | {kind:'card', id} | {kind:'selection', target:'card'|'group', id}]
//   그리는 순서: 바탕 → 살아 있는 묶음(수동 배치에서만) → visibleCards → 선택선.
// captionFor(card) -> label | 'youtube'|'pinterest'|'video' | null. label이 없는 image는 캡션이 없다.
// footText, wrapLines, fitLine: 사진 카드 아랫단(캡션 + 메모 2줄)의 글 고르기와 줄 나누기(measure 콜백).
// cardChrome(theme, card, s, scale, measure) -> {outer, inner, matBg, foot, lines, badgeAt, shadows}
//   라이트 매트는 사방 pad이고, 아랫단은 캡션과 메모를 담을 만큼 커진다. 다크는 사진 아래 띠.
//   s는 카드의 화면 rect. 사진 카드(hasThumb)는 라이트에서 흰 매트 안쪽(inner)에 그림을 그린다.
// groupBox(group, s) -> 묶음의 화면 상자. 접힌 묶음은 28px 제목줄만.
// groupLabel(theme, group, count) -> 묶음 이름 글자. 펼침 '이름'(상자 위 바깥), 접힘 '이름 · N장'(제목줄 안).
// groupToggle(group, s) -> {glyph:'▾'|'▸', zone}. zone은 interaction.js의 접기 판정 영역과 같은
//   상자 안 왼쪽 위 24×28 화면 px다. 글리프는 그 가운데에 그린다.
// groupMembers(cards, groupId) -> 그 묶음에 든 카드.

import { visibleCards } from './interaction.js';
import { GROUP_TITLE_PX, GROUP_TOGGLE_PX } from './layout.js';

// 매트 캡션에 쓰는 종류 이름. 이 밖의 종류(image 포함)는 label이 없으면 캡션이 없다.
export const CAPTION_WORDS = Object.freeze({ youtube: 'youtube', pinterest: 'pinterest', video: 'video' });
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const cardLabel = (card) => trimmed(card?.label);
export const cardMemo = (card) => trimmed(card?.memo);
// label이 있으면 label, 없으면 종류 이름(image·link·text는 null).
export const captionFor = (card) =>
  cardLabel(card) ?? (card && Object.hasOwn(CAPTION_WORDS, card.kind) ? CAPTION_WORDS[card.kind] : null);

// 사진 카드 아랫단 글 {caption, label, memo} | null.
// 라이트(매트)는 캡션이나 메모가 있으면 쓴다. 다크(꽉 찬 사진)는 label이나 메모가 있을 때만 사진 아래 띠를 둔다.
export function footText(theme, card) {
  const memo = cardMemo(card);
  const label = cardLabel(card);
  if (!theme?.mat && !memo && !label) return null;
  const caption = captionFor(card);
  return caption || memo ? { caption, label: !!label, memo } : null;
}

// 아랫단 치수(세계 px). 캡션 한 줄 14, 메모 한 줄 13, 위아래 3. 캡션만 있으면 20(= mat.captionBottom).
// x는 카드 왼쪽에서 글까지(라이트 = 매트 4 + 2, 다크 띠 = 8). 뷰어 CSS도 이 값을 쓴다.
export const FOOT = Object.freeze({ top: 3, bottom: 3, capH: 14, memoH: 13, memoLines: 2, xMat: 2, xStrip: 8, maxShare: 0.6 });

// 한 줄에 맞춘다. 넘치거나 more(뒤에 글이 더 있음)이면 맞는 데까지 자르고 '…'를 붙인다. measure(text) -> 폭.
export function fitLine(text, maxW, measure, more = false) {
  const s = String(text ?? '');
  if (!more && measure(s) <= maxW) return s;
  const ch = [...s];
  let lo = 0, hi = ch.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(ch.slice(0, mid).join('') + '…') <= maxW) lo = mid; else hi = mid - 1;
  }
  return ch.slice(0, lo).join('') + '…';
}

// 글자 단위로 줄을 나눈다(줄바꿈은 지킨다). maxLines를 넘으면 마지막 줄 끝에 '…'.
export function wrapLines(text, maxW, maxLines, measure) {
  const chars = [...String(text ?? '')].filter((c) => c !== '\r');
  if (!chars.length || maxLines < 1 || !(maxW > 0)) return [];
  const out = [];
  let line = '', more = false;
  for (const ch of chars) {
    if (ch === '\n' || (line && measure(line + ch) > maxW)) {
      if (out.length === maxLines - 1) { more = true; break; }
      out.push(line);
      line = ch === '\n' ? '' : ch;
    } else line += ch;
  }
  out.push(fitLine(line, maxW, measure, more));
  return out;
}

// '11px 글꼴'의 크기를 k배로.
export const scaleFont = (font, k) => String(font).replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${+(n * k).toFixed(2)}px`);

const BADGE_INSET = 6;
const CAPTION_MIN_PX = 13; // 캡션 한 줄 자리(20 × 배율)가 이보다 얇으면 글을 쓰지 않는다
const approx = (t) => [...t].length * 6;

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

// measure(text, font) -> 배율 1 글꼴의 폭. 줄 나누기는 세계 px로 하므로 확대해도 줄이 바뀌지 않는다.
// lines: [{text, x, y(가운데), font(배율 적용), color}]. foot: 아랫단(라이트 매트 아래, 다크 띠) 화면 rect와 bg.
export function cardChrome(theme, card, s, scale = 1, measure = approx) {
  const base = {
    outer: s,
    inner: s,
    matBg: null,
    foot: null,
    lines: [],
    badgeAt: { x: s.x + BADGE_INSET, y: s.y + BADGE_INSET },
    shadows: theme.shadow ?? [],
  };
  if (!card?.hasThumb) return base;
  const mat = theme.mat;
  const ft = footText(theme, card);
  if (!mat && !ft) return base;
  const k = scale;
  const pad = mat ? mat.pad : 0;
  const tx = mat ? pad + FOOT.xMat : FOOT.xStrip;
  const tw = s.w / k - tx * 2;
  const memo = ft?.memo ? wrapLines(ft.memo, tw, FOOT.memoLines, (t) => measure(t, theme.memoFont)) : [];
  let footH = ft ? FOOT.top + (ft.caption ? FOOT.capH : 0) + FOOT.memoH * memo.length + FOOT.bottom : mat.bottom;
  footH = Math.min(footH, Math.max(mat ? mat.bottom : 0, (s.h / k - pad) * FOOT.maxShare)) * k;
  const p = pad * k;
  const inner = { x: s.x + p, y: s.y + p, w: s.w - p * 2, h: s.h - p - footH };
  if (inner.w < 1 || inner.h < 1) return base; // 너무 작으면 매트 없이 꽉 채운다
  const fy = inner.y + inner.h;
  const out = {
    ...base,
    inner,
    matBg: mat ? theme.matBg ?? '#ffffff' : null,
    foot: ft ? { x: s.x, y: fy, w: s.w, h: s.y + s.h - fy, bg: mat ? null : theme.stripBg } : null,
    badgeAt: { x: inner.x + BADGE_INSET, y: inner.y + BADGE_INSET },
  };
  if (ft && (FOOT.top + FOOT.capH + FOOT.bottom) * k >= CAPTION_MIN_PX) {
    const x = s.x + tx * k;
    let y = fy + FOOT.top * k;
    if (ft.caption) {
      out.lines.push({
        text: fitLine(ft.caption, tw, (t) => measure(t, theme.captionFont)), x, y: y + (FOOT.capH * k) / 2,
        font: scaleFont(theme.captionFont, k), color: ft.label ? theme.labelColor : theme.captionColor,
      });
      y += FOOT.capH * k;
    }
    for (const text of memo) {
      out.lines.push({ text, x, y: y + (FOOT.memoH * k) / 2, font: scaleFont(theme.memoFont, k), color: theme.memoColor });
      y += FOOT.memoH * k;
    }
  }
  return out;
}

export function groupBox(group, s) {
  if (!group?.collapsed) return s;
  return { x: s.x, y: s.y, w: s.w, h: Math.min(s.h, GROUP_TITLE_PX) };
}

export function groupLabel(theme, group, count) {
  const name = String(group?.name ?? '');
  const shown = theme.groupLabelUpper ? name.toUpperCase() : name;
  return group?.collapsed ? `${shown} · ${count}장` : shown;
}

export function groupToggle(group, s) {
  const zone = { x: s.x, y: s.y, w: Math.min(s.w, GROUP_TOGGLE_PX), h: Math.min(s.h, GROUP_TITLE_PX) };
  return { glyph: group?.collapsed ? '▸' : '▾', zone, cx: zone.x + zone.w / 2, cy: zone.y + zone.h / 2 };
}

export function groupMembers(cards, groupId) {
  return (cards ?? []).filter((c) => c && !c.deleted && c.groupId === groupId);
}

// 떨군 파일과 붙여 넣은 링크·글을 카드로 만든다. 플랫폼 호출은 모두 deps로 받는다.
//
// deps = {
//   readBytes(fileId) -> Promise<ArrayBuffer>,
//   blobPut(key, fileId) -> Promise<void>,
//   makeThumb(bytes, mime) -> Promise<{jpegB64, pixels, width?, height?}|null>,
//   thumbs: ThumbStore,            // put(cardId, b64) -> {error:'full'} | undefined
//   gifs: ThumbStore|null,         // 움직이는 GIF 원본(gifs_00..31). 없으면 GIF도 정지 썸네일만 둔다
//   now() -> ms,
//   placeAt() -> {x, y},
//   httpRead(permission, path, query) -> Promise<{bytes: ArrayBuffer, mime}>,   // ingestText만
// }

import { newCard, TEXT_DEFAULT_COLOR } from './model.js';
import { classifyInput } from './classify.js';
import { dominantColor } from './color.js';

export const PLACEHOLDER_NOTE = '미리보기를 만들 수 없어요';
export const PIN_SHORT_NOTE = '브라우저 주소창의 주소를 넣어 주세요';

const CARD_W = 240;
const CARD_H = 180;
const TITLE_MAX = 40;
// 이 크기(원본 바이트) 이하의 GIF는 원본 base64를 gif 저장소에도 넣어 보드에서 움직인다.
// base64로 933,336자라 접두를 붙여도 1,000,000바이트 shard 하나에 들어간다.
export const GIF_ANIM_MAX = 700_000;
const PIN_IMG_HOST = 'i.pinimg.com';
const PIN_IMG_PREFIXES = ['/originals/', '/1200x/', '/736x/', '/564x/', '/474x/', '/236x/'];

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4',
};

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/mp4',
};

// macOS WebView에서 Finder로 끌어온 파일은 mime이 비어 올 수 있어 확장자로 채운다.
function mimeOf(f) {
  const mime = typeof f.mime === 'string' ? f.mime : '';
  if (mime && mime !== 'application/octet-stream') return mime;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(f.name ?? ''));
  return (m && EXT_MIME[m[1].toLowerCase()]) || mime;
}

function isSupported(mime) {
  return typeof mime === 'string' && (mime.startsWith('image/') || mime === 'video/mp4');
}

function extOf(name, mime) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''));
  if (m) return m[1].toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const sub = String(mime ?? '').split('/')[1]?.split(/[+;]/)[0]?.replace(/^x-/, '').toLowerCase();
  return sub && /^[a-z0-9.-]+$/.test(sub) ? sub : 'bin';
}

function manualFor(deps, thumb) {
  const w = CARD_W;
  const tw = thumb?.width, th = thumb?.height;
  const h = tw > 0 && th > 0 ? Math.round((w * th) / tw) : CARD_H;
  return { ...deps.placeAt(), w, h };
}

async function safeThumb(deps, bytes, mime) {
  try {
    const t = await deps.makeThumb(bytes, mime);
    return t && typeof t.jpegB64 === 'string' && t.jpegB64 ? t : null;
  } catch {
    return null;
  }
}

// 썸네일을 저장한다. 결과: 'ok' | 'full' | 'failed'.
async function putThumb(deps, cardId, b64) {
  try {
    const r = await deps.thumbs.put(cardId, b64);
    return r?.error === 'full' ? 'full' : 'ok';
  } catch {
    return 'failed';
  }
}

function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// 작은 GIF의 원본을 gif 저장소에 넣는다. 넣었으면 참. 차거나 실패하면 정지 카드로 남긴다.
async function putGif(deps, cardId, bytes) {
  if (!deps.gifs || !bytes || bytes.byteLength > GIF_ANIM_MAX) return false;
  try {
    const r = await deps.gifs.put(cardId, toBase64(bytes));
    return r?.error !== 'full';
  } catch {
    return false;
  }
}

// --- 파일 ---

export async function ingestFiles(files, deps) {
  const cards = [];
  for (const f of files ?? []) {
    if (!f) continue;
    const mime = mimeOf(f);
    if (!isSupported(mime)) continue;
    const card = newCard({
      kind: mime === 'video/mp4' ? 'video' : 'image',
      title: String(f.name ?? ''),
      updatedAt: deps.now(),
    });
    card.origKey = `orig/${card.id}.${extOf(f.name, mime)}`;

    let thumb = null;
    let bytes = null;
    if (f.size !== 0) {
      try {
        bytes = await deps.readBytes(f.id);
        if (bytes && bytes.byteLength > 0) thumb = await safeThumb(deps, bytes, mime);
      } catch {
        thumb = null;
      }
    }

    let hasThumb = false;
    if (thumb) {
      const r = await putThumb(deps, card.id, thumb.jpegB64);
      if (r === 'full') return { cards, full: true };
      hasThumb = r === 'ok';
    }
    // 움직이는 GIF: 정지 썸네일은 그대로 두고 원본을 gif 저장소에 더 넣는다.
    if (hasThumb && mime === 'image/gif' && (await putGif(deps, card.id, bytes))) card.anim = true;

    try {
      await deps.blobPut(card.origKey, f.id);
    } catch {
      // 원본은 이 PC에 없을 뿐, 카드는 남긴다.
    }

    card.hasThumb = hasThumb;
    card.color = hasThumb ? dominantColor(thumb.pixels) : TEXT_DEFAULT_COLOR;
    card.manual = manualFor(deps, hasThumb ? thumb : null);
    if (!hasThumb) card.note = PLACEHOLDER_NOTE;
    cards.push(card);
  }
  return { cards, full: false };
}

// --- 링크와 글 ---

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function linkCard(url, deps, extra = {}) {
  return newCard({
    kind: 'link', url, title: hostOf(url), hasThumb: false,
    manual: manualFor(deps, null), updatedAt: deps.now(), ...extra,
  });
}

function textCard(text, deps) {
  const first = text.split(/\r?\n/)[0];
  return newCard({
    kind: 'text', text, title: [...first].slice(0, TITLE_MAX).join(''),
    color: TEXT_DEFAULT_COLOR, hasThumb: false,
    manual: manualFor(deps, null), updatedAt: deps.now(),
  });
}

async function readJson(deps, perm, path, query) {
  const { bytes } = await deps.httpRead(perm, path, query);
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (!o || typeof o !== 'object') throw new Error('bad json');
  return o;
}

// 썸네일이 있는 링크 카드를 마무리한다. 저장 공간이 차면 null.
async function finishWithThumb(card, thumb, deps) {
  let hasThumb = false;
  if (thumb) {
    const r = await putThumb(deps, card.id, thumb.jpegB64);
    if (r === 'full') return null;
    hasThumb = r === 'ok';
  }
  card.hasThumb = hasThumb;
  card.color = hasThumb ? dominantColor(thumb.pixels) : TEXT_DEFAULT_COLOR;
  card.manual = manualFor(deps, hasThumb ? thumb : null);
  return card;
}

async function youtubeCard(videoId, deps) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let meta;
  try {
    meta = await readJson(deps, 'yt-oembed', '/oembed', { url, format: 'json' });
  } catch {
    return { card: linkCard(url, deps), full: false };
  }
  let thumb = null;
  try {
    const { bytes, mime } = await deps.httpRead('yt-thumb', `/vi/${videoId}/hqdefault.jpg`, {});
    thumb = await safeThumb(deps, bytes, mime || 'image/jpeg');
  } catch {
    thumb = null;
  }
  const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : url;
  const card = newCard({ kind: 'youtube', url, title, updatedAt: deps.now() });
  const done = await finishWithThumb(card, thumb, deps);
  return done ? { card: done, full: false } : { card: null, full: true };
}

function pinImgPath(thumbnailUrl) {
  let u;
  try { u = new URL(thumbnailUrl); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== PIN_IMG_HOST) return null;
  return PIN_IMG_PREFIXES.some((p) => u.pathname.startsWith(p)) ? u.pathname : null;
}

async function pinterestCard(pinId, deps) {
  const url = `https://www.pinterest.com/pin/${pinId}/`;
  const fallback = () => ({ card: linkCard(url, deps), full: false });
  let meta;
  try {
    meta = await readJson(deps, 'pin-oembed', '/oembed.json', { url });
  } catch {
    return fallback();
  }
  const path = typeof meta.thumbnail_url === 'string' ? pinImgPath(meta.thumbnail_url) : null;
  if (!path) return fallback();
  let thumb;
  try {
    const { bytes, mime } = await deps.httpRead('pin-img', path, {});
    thumb = await safeThumb(deps, bytes, mime || 'image/jpeg');
  } catch {
    return fallback();
  }
  if (!thumb) return fallback();
  const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : 'Pinterest';
  const card = newCard({ kind: 'pinterest', url, title, updatedAt: deps.now() });
  const done = await finishWithThumb(card, thumb, deps);
  return done ? { card: done, full: false } : { card: null, full: true };
}

export async function ingestText(raw, deps) {
  const c = classifyInput(raw);
  if (!c) return { card: null, full: false };
  switch (c.kind) {
    case 'youtube': return youtubeCard(c.videoId, deps);
    case 'pinterest': return pinterestCard(c.pinId, deps);
    case 'pin_short': return { card: linkCard(c.url, deps, { note: PIN_SHORT_NOTE }), full: false };
    case 'link': return { card: linkCard(c.url, deps), full: false };
    case 'text': return { card: textCard(c.text, deps), full: false };
    default: return { card: null, full: false };
  }
}

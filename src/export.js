// 단일 HTML 내보내기. 순수 모듈이며 Node에서 테스트한다.
//
// planExport(board, {thumbSizes, origSizes}) -> {estimate, level, videos}
// buildExportChunks(board, plan, {thumb, video, viewerJs}) -> AsyncIterable<Uint8Array>
//   thumb(cardId) -> Promise<base64|null>, video(cardId) -> Promise<ArrayBuffer|Uint8Array|null>,
//   viewerJs는 src/viewer/viewer.js를 iife로 번들한 문자열(빌드 1단계의 dist/viewer.txt).
// runExport({name, files, chunks}) -> {status:'done', name} | {status:'cancelled'}
//
// 만드는 HTML의 순서:
//   <!DOCTYPE html>, head(인라인 CSS, viewport), <script type="application/json" id="board">,
//   카드마다 <script type="text/plain" data-thumb="id">base64, 영상마다 data-video 블록, 뷰어 스크립트.
// 외부 요청은 없다. 원본 링크는 뷰어가 target=_blank rel=noopener 앵커로 만든다.

import { liveGroups, effectiveGroupId } from './model.js';

export const WARN_BYTES = 50_000_000;
export const BLOCK_BYTES = 95_000_000;
export const OVERHEAD_BYTES = 200_000;
export const CHUNK_MAX = 4 * 1024 * 1024;
export const NO_ORIG_REASON = '원본 없음';
const VIDEO_MIME = 'video/mp4';
const FALLBACK_NAME = '무드보드';

const liveCards = (board) => (board?.cards ?? []).filter((c) => !c.deleted);
const b64Len = (bytes) => (bytes * 4) / 3;

export function planExport(board, { thumbSizes = new Map(), origSizes = new Map() } = {}) {
  let raw = 0;
  const videos = [];
  for (const c of liveCards(board)) {
    if (c.hasThumb) raw += thumbSizes.get(c.id) ?? 0;
    if (c.kind !== 'video' || !c.includeVideo) continue;
    const size = origSizes.get(c.id);
    if (typeof size === 'number' && size >= 0) {
      raw += size;
      videos.push({ cardId: c.id, embed: true });
    } else {
      videos.push({ cardId: c.id, embed: false, reason: NO_ORIG_REASON });
    }
  }
  const estimate = Math.ceil(b64Len(raw)) + OVERHEAD_BYTES;
  const level = estimate > BLOCK_BYTES ? 'block' : estimate > WARN_BYTES ? 'warn' : 'ok';
  return { estimate, level, videos };
}

const mb = (bytes) => Math.round(bytes / 1_000_000);

// block → notice, warn → export_info. ok는 둘 다 비운다.
export function exportMessages(board, plan) {
  if (plan.level === 'block') {
    const byId = new Map(liveCards(board).map((c) => [c.id, c]));
    const titles = plan.videos.filter((v) => v.embed).map((v) => byId.get(v.cardId)?.title || v.cardId);
    const base = `내보내기 파일이 너무 커요 (약 ${mb(plan.estimate)} MB)`;
    return { notice: titles.length ? `${base}. 재생 포함을 끌 영상: ${titles.join(', ')}` : base, info: '' };
  }
  return { notice: null, info: plan.level === 'warn' ? `약 ${mb(plan.estimate)} MB` : '' };
}

export function exportFileName(name) {
  const clean = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return `${clean || FALLBACK_NAME}.html`;
}

// --- 글 다루기 ---

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
// JSON 안의 '<'를 모두 <로 바꿔 </script와 <!--가 생기지 않게 한다. JSON.parse 결과는 같다.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// 뷰어 코드 안의 </script와 <!--를 끊는다(문자열·정규식 안에서는 뜻이 같다).
const jsForScript = (js) => String(js).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let part = [];
  let i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    part.push(B64[n >> 18], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]);
    if (part.length >= 32768) { out += part.join(''); part = []; }
  }
  const rest = u8.length - i;
  if (rest === 1) {
    const n = u8[i] << 16;
    part.push(B64[n >> 18], B64[(n >> 12) & 63], '==');
  } else if (rest === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    part.push(B64[n >> 18], B64[(n >> 12) & 63], B64[(n >> 6) & 63], '=');
  }
  return out + part.join('');
}

// 뷰어에 넘길 카드. 원본 키와 저장 시각은 빼고, 수동 배치 자리와 색은 그대로 둔다.
// groupId는 살아 있는 묶음을 가리킬 때만 남긴다.
function viewerCard(board, c, embedded) {
  const out = { id: c.id, kind: c.kind, title: c.title ?? '', color: c.color, manual: c.manual, hasThumb: !!c.hasThumb };
  const groupId = effectiveGroupId(board, c);
  if (groupId) out.groupId = groupId;
  if (c.url) out.url = c.url;
  if (typeof c.text === 'string') out.text = c.text;
  if (c.note) out.note = c.note;
  if (c.kind === 'video') out.video = embedded.has(c.id);
  return out;
}

// 뷰어에 넘길 묶음. 지운 묶음은 빼고, 접힘은 그대로 내보낸다.
const viewerGroup = (g) => ({
  id: g.id, name: g.name ?? '', rect: { x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h }, collapsed: !!g.collapsed,
});

// 뼈대만 둔다. 색과 글꼴은 뷰어가 THEMES에서 골라 <style id="theme">로 넣는다(prefers-color-scheme).
// 둥근 모서리는 쓰지 않는다.
const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
@media (prefers-color-scheme: dark){html,body{background:#141416;color:#e9e6df}}
#bar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid transparent;z-index:2}
#bar h1{font-size:15px;font-weight:600;margin:0 auto 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#bar button{font:inherit;border:1px solid transparent;padding:4px 10px;cursor:pointer}
#stage{position:fixed;top:44px;left:0;right:0;bottom:0;overflow:hidden;cursor:grab;touch-action:none}
#stage.panning{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.group{position:absolute;border:1px solid transparent}
.group .label{position:absolute;left:10px;top:-1px;transform:translateY(-100%);display:flex;align-items:center;gap:6px;white-space:nowrap}
.group .gdot{flex:none;width:7px;height:7px;clip-path:circle(50%)}
.group.collapsed .label{position:static;transform:none;height:100%;padding:0 10px}
.card{position:absolute;overflow:hidden;cursor:pointer;user-select:none}
.card.anim,.group.anim{transition:left .3s cubic-bezier(.33,1,.68,1),top .3s cubic-bezier(.33,1,.68,1),width .3s cubic-bezier(.33,1,.68,1),height .3s cubic-bezier(.33,1,.68,1)}
.card.hidden,.group.hidden{display:none}
.card .pic{position:absolute;inset:0;overflow:hidden}
.card img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.card .cap{position:absolute;left:8px;bottom:5px;white-space:nowrap}
.card .ph{position:absolute;inset:0;padding:14px;white-space:pre-wrap;word-break:break-word;overflow:hidden}
.card .ph b{display:block;margin-bottom:4px}
.card.link .ph,.card.placeholder .ph{padding-top:34px}
.card .accent{position:absolute;left:0;top:0;bottom:0}
.card .tdot{position:absolute;right:8px;bottom:8px;width:10px;height:10px;clip-path:circle(50%)}
.card .badge{position:absolute;padding:1px 5px;line-height:1.3}
.card .note{position:absolute;left:0;right:0;bottom:0;padding:4px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:3;padding:24px}
#lb.open{display:flex}
#lb .box{max-width:min(1100px,100%);max-height:100%;display:flex;flex-direction:column;gap:10px;align-items:center}
#lb img,#lb video{width:min(1100px,calc(100vw - 48px));height:calc(100vh - 160px);object-fit:contain}
#lb .txt{padding:20px;white-space:pre-wrap;word-break:break-word;max-height:calc(100vh - 160px);overflow:auto;min-width:min(480px,100%)}
#lb .meta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center;color:#fff}
#lb .title{font-weight:600}
#lb a{color:#8ab4ff}
#lb .close{position:fixed;top:12px;right:16px;font:inherit;font-size:20px;color:#fff;background:none;border:0;cursor:pointer}
`.trim();

function head(board) {
  return '<!DOCTYPE html>\n<html lang="ko"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(board?.name ?? FALLBACK_NAME)}</title>`
    + `<style>${CSS}</style></head><body>\n`;
}

// 바이트를 CHUNK_MAX 크기의 조각으로 모은다. 큰 조각 하나도 나눠서 낸다.
function createPacker() {
  const enc = new TextEncoder();
  let buf = new Uint8Array(CHUNK_MAX);
  let used = 0;
  return {
    *add(input) {
      let bytes = typeof input === 'string' ? enc.encode(input) : input;
      while (bytes.length) {
        const n = Math.min(CHUNK_MAX - used, bytes.length);
        buf.set(bytes.subarray(0, n), used);
        used += n;
        bytes = bytes.subarray(n);
        if (used === CHUNK_MAX) { yield buf; buf = new Uint8Array(CHUNK_MAX); used = 0; }
      }
    },
    *end() {
      if (used) yield buf.slice(0, used);
      used = 0;
    },
  };
}

// 영상 base64를 한 번에 이만큼 바이트씩(3의 배수) 바꿔 메모리를 아낀다.
const VIDEO_SLICE = 3 * 1024 * 1024;

export async function* buildExportChunks(board, plan, readers) {
  const { thumb, video, viewerJs = '' } = readers;
  const cards = liveCards(board);
  const embedIds = (plan?.videos ?? []).filter((v) => v.embed).map((v) => v.cardId);
  // 실제로 읽은 영상만 embedded로 표시해야 하므로 영상을 먼저 연다.
  const videoData = new Map();
  for (const id of embedIds) {
    const bytes = await video(id);
    if (bytes) videoData.set(id, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }
  const embedded = new Set(videoData.keys());
  const pack = createPacker();

  const data = {
    name: board?.name ?? '',
    groups: liveGroups(board).filter((g) => g.rect).map(viewerGroup),
    cards: cards.map((c) => viewerCard(board, c, embedded)),
  };
  yield* pack.add(head(board));
  yield* pack.add(`<script type="application/json" id="board">${jsonForScript(data)}</script>\n`);

  for (const c of cards) {
    if (!c.hasThumb) continue;
    const b64 = await thumb(c.id);
    if (typeof b64 !== 'string' || !b64) continue;
    // base64에는 '<'가 없지만 저장 값이 깨졌을 때를 대비해 걸러 낸다.
    yield* pack.add(`<script type="text/plain" data-thumb="${escapeHtml(c.id)}">${b64.replace(/[^A-Za-z0-9+/=]/g, '')}</script>\n`);
  }

  for (const [id, bytes] of videoData) {
    yield* pack.add(`<script type="text/plain" data-video="${escapeHtml(id)}" data-mime="${VIDEO_MIME}">`);
    for (let i = 0; i < bytes.length; i += VIDEO_SLICE) yield* pack.add(bytesToBase64(bytes.subarray(i, i + VIDEO_SLICE)));
    yield* pack.add('</script>\n');
    videoData.set(id, null); // 다 쓴 영상은 놓아준다
  }

  yield* pack.add(`<script>${jsForScript(viewerJs)}</script>\n</body></html>\n`);
  yield* pack.end();
}

// 저장 창을 열고 조각을 차례로 쓴다. files = {savePrompt, write, close, abort}.
// 취소면 아무것도 쓰지 않는다. 쓰다 실패하면 abort한 뒤 오류를 다시 던진다.
export async function runExport({ name, files, chunks }) {
  const fileName = exportFileName(name);
  const fileId = await files.savePrompt({ suggested_name: fileName, mime: 'text/html' });
  if (!fileId) return { status: 'cancelled' };
  let offset = 0;
  try {
    for await (const chunk of chunks()) {
      await files.write(fileId, offset, chunk);
      offset += chunk.byteLength;
    }
    await files.close(fileId);
  } catch (err) {
    try { await files.abort(fileId); } catch { /* 원래 오류를 알린다 */ }
    throw err;
  }
  return { status: 'done', name: fileName };
}

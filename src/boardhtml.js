// sandbox 보드 HTML을 client가 만든다. sandbox 블록은 assets.bytes를 받지 못해서(쉘 sandbox.tsx는
// ks-client-asset-bytes에 답하지 않는다) 보드 코드는 client가 읽어 client 출력 board_html로 넘기고,
// 블록은 value: {client:'board_html'}로 그린다.
//
// 보드 코드 자산 moodboard-board-js-1..N(javascript): 각 자산은 base64(gzip(dist/board.js))를 나눈
// 조각 하나를 문자열 리터럴 한 문장("…";)으로 담는다(scripts/pack.mjs). 조각 길이는 마지막을 빼고
// 4의 배수라 문자열을 그대로 이어 붙이면 base64 전체가 된다.
// 쉘 테마 바탕(theme.js SHELL surfaceSolid)으로 칠해 보드가 늦게 떠도 바탕이 튀지 않게 한다.

import { SHELL } from './theme.js';

export const BOARD_JS_PREFIX = 'moodboard-board-js-';
export const boardPartId = (i) => BOARD_JS_PREFIX + (i + 1);

const L = SHELL.light;
const D = SHELL.dark;
const STYLE =
  `html,body{margin:0;height:100%;overflow:hidden;background:${L.surfaceSolid};color:${L.text};font:13px system-ui,sans-serif}` +
  `@media (prefers-color-scheme:dark){html,body{background:${D.surfaceSolid};color:${D.text}}}` +
  `.mb-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:${L.muted}}` +
  `@media (prefers-color-scheme:dark){.mb-msg{color:${D.muted}}}`;

const page = (body) =>
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>무드보드</title><style>' + STYLE +
  '</style></head><body>' + body + '</body></html>\n';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const message = (text) => '<div class="mb-msg" role="status">' + escapeHtml(text) + '</div>';

// 모든 조각을 읽기 전 출력 기본값.
export const placeholderHtml = page(message('보드를 불러오는 중…'));

export const errorHtml = (text) => page(message('보드를 불러오지 못했어요: ' + text));

// 프레임 안에서 base64(gzip)를 풀어 eval한다. 실패하면 화면에 오류를 쓴다.
// base64에는 '<'가 없어 </script>로 끊길 걱정이 없다.
export function boardHtml(b64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('보드 코드가 base64가 아닙니다');
  const script = '(async()=>{if(typeof DecompressionStream==="undefined")throw new Error("DecompressionStream을 쓸 수 없습니다");' +
    'const b=Uint8Array.from(atob("' + b64 + '"),c=>c.charCodeAt(0));' +
    '(0,eval)(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text())})()' +
    '.catch(e=>{console.error("moodboard-board: 번들을 풀지 못했습니다",e);' +
    'const d=document.createElement("div");d.className="mb-msg";d.setAttribute("role","alert");' +
    'd.textContent="보드를 불러오지 못했어요: "+(e&&e.message||String(e));document.body.replaceChildren(d)});';
  return page('<script>' + script + '</script>');
}

// base64 문자열을 조각으로 나눈다. 조각 자산 본문은 JSON 문자열 + ';\n'(base64 글자는 이스케이프되지 않는다)이고,
// 그 본문의 base64가 max자 이하가 되는 가장 긴 4의 배수 길이로 자른다. 4의 배수라 이어 붙이면 원래 base64다.
export function splitParts(b64, max) {
  const overhead = 4; // 따옴표 둘, ';', '\n'
  let len = Math.floor(max / 4) * 3 - overhead;
  len -= len % 4;
  if (len <= 0) throw new Error('조각 한도가 너무 작습니다');
  const parts = [];
  for (let i = 0; i < b64.length; i += len) parts.push(b64.slice(i, i + len));
  return parts.length ? parts : [''];
}

// 조각 자산 한 개의 바이트(ArrayBuffer)에서 base64 조각을 꺼낸다.
export function partText(bytes) {
  const text = new TextDecoder().decode(bytes).trim().replace(/;$/, '');
  const value = JSON.parse(text);
  if (typeof value !== 'string') throw new Error('보드 코드 조각이 문자열이 아닙니다');
  return value;
}

// ids의 조각을 모두 읽어 보드 HTML을 만든다. 하나라도 실패하면 던진다.
export async function loadBoardHtml(ids, bytesOf) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('보드 코드 조각 목록이 없습니다');
  const parts = await Promise.all(ids.map(async (id) => {
    try {
      return partText(await bytesOf(id));
    } catch (e) {
      throw new Error(`${id}: ${e?.message ?? String(e)}`);
    }
  }));
  return boardHtml(parts.join(''));
}

// 올릴 자산 세 개를 만든다. 각 업로드의 base64(upload_asset의 data_base64)가 BUDGET자를 넘으면 실패한다.
// 컨트롤러가 base64를 MCP 호출에 손으로 옮겨 싣기 때문이다.
//
// - moodboard (javascript): dist/moodboard.js(client)를 gzip으로 줄여 풀고 eval하는 로더. → dist/moodboard.upload.{js,b64}
// - moodboard-board (html): dist/board.js(sandbox 보드)를 gzip base64로 담고 풀어 eval하는 HTML. → dist/board.html, dist/board.upload.b64
// - moodboard-export (javascript): 내보내기 코드와 뷰어 dist/export.js(src/export-entry.js의 iife)의
//   base64(gzip)을 문자열 리터럴 한 문장으로 담는다. client가 내보낼 때만 kaleidoscope.assets.bytes로 읽어 푼다.
//   → dist/export.upload.{js,b64}
// 프레임 CSP(sandbox-frame.ts)는 script-src data: blob: 'unsafe-eval'이다. 인라인 <script>는 쉘이 data: 주소로 바꿔 싣는다.
// 사용: npm run build (마지막 단계). 자산마다 크기와 sha256을 찍고 dist/assets.json에 남긴다.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const BUDGET = 28_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => join(ROOT, 'dist', name);
const gz64 = (buf) => gzipSync(buf, { level: 9 }).toString('base64');

const unpack = (b64) =>
  'const b=Uint8Array.from(atob("' + b64 + '"),c=>c.charCodeAt(0));' +
  '(0,eval)(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text())';

// 풀기나 실행이 실패하면 프레임은 오류를 바깥으로 넘기지 않으므로, 선언한 출력 notice로 알린다.
function clientLoader(src) {
  return '(async()=>{if(typeof DecompressionStream==="undefined")throw new Error("DecompressionStream을 쓸 수 없습니다");' +
    unpack(gz64(src)) + '})()' +
    '.catch(e=>{console.error("moodboard: 번들을 풀지 못했습니다",e);' +
    'try{window.kaleidoscope.publish({notice:"앱을 불러오지 못했어요: "+(e&&e.message||String(e)),has_notice:true})}catch(_){}});\n';
}

// sandbox HTML. 보드 그림이 늦게 떠도 바탕이 테마 바탕(theme.js SHELL surfaceSolid)으로 보이게 칠해 둔다.
function boardHtml(src) {
  const script = '(async()=>{' + unpack(gz64(src)) + '})()' +
    '.catch(e=>{console.error("moodboard-board: 번들을 풀지 못했습니다",e);' +
    'document.body.textContent="보드를 불러오지 못했어요: "+(e&&e.message||String(e))});';
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>무드보드</title><style>' +
    'html,body{margin:0;height:100%;overflow:hidden;background:#f7f3f7;color:#302a36;font:13px system-ui,sans-serif}' +
    '@media (prefers-color-scheme:dark){html,body{background:#2a2230;color:#ece3f2}}' +
    '</style></head><body><script>' + script + '</script></body></html>\n';
}

const lazyAsset = (src) => JSON.stringify(gz64(src)) + ';\n';

const assets = [
  { id: 'moodboard', format: 'javascript', from: 'moodboard.js', out: 'moodboard.upload.js', b64: 'moodboard.upload.b64', make: clientLoader },
  { id: 'moodboard-board', format: 'html', from: 'board.js', out: 'board.html', b64: 'board.upload.b64', make: boardHtml },
  { id: 'moodboard-export', format: 'javascript', from: 'export.js', out: 'export.upload.js', b64: 'export.upload.b64', make: lazyAsset },
];

const report = [];
let over = false;
for (const a of assets) {
  const src = readFileSync(dist(a.from));
  const body = Buffer.from(a.make(src));
  const b64 = body.toString('base64');
  writeFileSync(dist(a.out), body);
  writeFileSync(dist(a.b64), b64);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const ok = b64.length <= BUDGET;
  if (!ok) over = true;
  report.push({
    id: a.id, format: a.format, file: `dist/${a.out}`, base64_file: `dist/${a.b64}`,
    bytes: body.length, source_bytes: src.length, base64_chars: b64.length, sha256,
  });
  console.log(`${ok ? 'ok  ' : 'OVER'} ${a.id} (${a.format}): base64 ${b64.length}/${BUDGET}자, ${body.length}바이트(원본 ${src.length}), sha256 ${sha256}`);
}
writeFileSync(dist('assets.json'), JSON.stringify(report, null, 2) + '\n');
if (over) {
  console.error(`base64가 ${BUDGET}자를 넘는 자산이 있습니다. 코드를 더 나누세요.`);
  process.exit(1);
}

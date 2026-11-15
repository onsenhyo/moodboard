// 올릴 자산을 만든다. 각 업로드의 base64(upload_asset의 data_base64)가 한도를 넘으면 실패한다.
// 컨트롤러가 base64를 MCP 호출에 손으로 옮겨 싣기 때문이다.
//
// - moodboard (javascript, client 진입점): dist/moodboard.js를 gzip으로 줄여 풀고 eval하는 로더. BUDGET자까지.
//   로더는 보드 코드 조각 id 목록을 globalThis.MOODBOARD_BOARD_PARTS에 넣는다. → dist/moodboard.upload.{js,b64}
// - moodboard-board-js-1..N (javascript, 보드 코드 조각): base64(gzip(dist/board.js))를 PART_MAX자 이하
//   업로드가 되도록 나눈 조각 하나를 문자열 리터럴 한 문장으로 담는다. sandbox는 assets.bytes를 받지 못해서
//   client가 조각을 모두 읽어 보드 HTML(src/boardhtml.js)을 만들고 출력 board_html로 넘긴다.
//   → dist/board-js-<i>.upload.{js,b64}
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
import { BOARD_JS_PREFIX, splitParts } from '../src/boardhtml.js';

export const BUDGET = 28_000;
export const PART_MAX = 24_000; // 보드 코드 조각 하나의 base64 한도

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => join(ROOT, 'dist', name);
const gz64 = (buf) => gzipSync(buf, { level: 9 }).toString('base64');

const unpack = (b64) =>
  'const b=Uint8Array.from(atob("' + b64 + '"),c=>c.charCodeAt(0));' +
  '(0,eval)(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text())';

// 풀기나 실행이 실패하면 프레임은 오류를 바깥으로 넘기지 않으므로, 선언한 출력 notice로 알린다.
function clientLoader(src, partIds) {
  return 'globalThis.MOODBOARD_BOARD_PARTS=' + JSON.stringify(partIds) + ';' +
    '(async()=>{if(typeof DecompressionStream==="undefined")throw new Error("DecompressionStream을 쓸 수 없습니다");' +
    unpack(gz64(src)) + '})()' +
    '.catch(e=>{console.error("moodboard: 번들을 풀지 못했습니다",e);' +
    'try{window.kaleidoscope.publish({notice:"앱을 불러오지 못했어요: "+(e&&e.message||String(e)),has_notice:true})}catch(_){}});\n';
}

const lazyAsset = (src) => JSON.stringify(gz64(src)) + ';\n';
const b64len = (n) => Math.ceil(n / 3) * 4;

const boardParts = splitParts(gz64(readFileSync(dist('board.js'))), PART_MAX);
const partIds = boardParts.map((_, i) => BOARD_JS_PREFIX + (i + 1));

const assets = [
  {
    id: 'moodboard', format: 'javascript', from: 'moodboard.js', out: 'moodboard.upload.js', b64: 'moodboard.upload.b64',
    make: (src) => clientLoader(src, partIds), budget: BUDGET,
  },
  ...boardParts.map((part, i) => ({
    id: partIds[i], format: 'javascript', from: 'board.js', out: `board-js-${i + 1}.upload.js`, b64: `board-js-${i + 1}.upload.b64`,
    make: () => JSON.stringify(part) + ';\n', budget: PART_MAX, part: i + 1, parts: boardParts.length,
  })),
  { id: 'moodboard-export', format: 'javascript', from: 'export.js', out: 'export.upload.js', b64: 'export.upload.b64', make: lazyAsset, budget: BUDGET },
];

const report = [];
let over = false;
for (const a of assets) {
  const src = readFileSync(dist(a.from));
  const body = Buffer.from(a.make(src));
  const b64 = body.toString('base64');
  if (b64.length !== b64len(body.length)) throw new Error('base64 길이 계산이 맞지 않습니다');
  writeFileSync(dist(a.out), body);
  writeFileSync(dist(a.b64), b64);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const ok = b64.length <= a.budget;
  if (!ok) over = true;
  report.push({
    id: a.id, format: a.format, file: `dist/${a.out}`, base64_file: `dist/${a.b64}`,
    bytes: body.length, source_bytes: src.length, base64_chars: b64.length, budget: a.budget, sha256,
    ...(a.part ? { group: 'board-js', part: a.part, parts: a.parts } : {}),
  });
  console.log(`${ok ? 'ok  ' : 'OVER'} ${a.id} (${a.format}): base64 ${b64.length}/${a.budget}자, ${body.length}바이트(원본 ${src.length}), sha256 ${sha256}`);
}
writeFileSync(dist('assets.json'), JSON.stringify(report, null, 2) + '\n');
if (over) {
  console.error('base64가 한도를 넘는 자산이 있습니다. 코드를 더 나누세요.');
  process.exit(1);
}

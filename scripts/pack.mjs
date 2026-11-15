// 올릴 자산을 만든다. 각 업로드의 base64(upload_asset의 data_base64)가 한도를 넘으면 실패한다.
// 컨트롤러가 base64를 MCP 호출에 손으로 옮겨 싣기 때문이다.
//
// - moodboard (javascript, client 진입점): 작은 로더. moodboard-manifest를 읽어 globalThis.MOODBOARD_MANIFEST에
//   두고, 매니페스트의 client 조각을 모두 읽어 이어 붙이고 gzip을 풀어 eval한다. 조각 수가 바뀌어도 그대로다.
//   → dist/moodboard.upload.{js,b64}
// - moodboard-manifest (javascript, JSON 한 덩이): {client:[[id,판]…], board:[[id,판]…], export:[id,판]}.
//   조각 배치나 판이 바뀌면 이것의 판만 올린다. → dist/manifest.upload.{js,b64}
// - moodboard-client-1..N (javascript, client 코드 조각): base64(gzip(dist/moodboard.js)) 조각.
// - moodboard-board-js-1..N (javascript, 보드 코드 조각): base64(gzip(dist/board.js)) 조각. sandbox는 assets.bytes를
//   받지 못해 client가 조각을 모두 읽어 보드 HTML(src/boardhtml.js)을 만들고 출력 board_html로 넘긴다.
//   조각 하나는 문자열 리터럴 한 문장("…";)이고, 업로드 base64가 PART_MAX자 이하가 되게 자른다(src/boardhtml.js splitParts).
// - moodboard-export (javascript): 내보내기 코드와 뷰어 dist/export.js의 base64(gzip)를 문자열 리터럴 한 문장으로.
//   client가 내보낼 때만 읽어 푼다. → dist/export.upload.{js,b64}
// 판은 scripts/versions.json 한 곳에서 정하고(묶음마다 하나), 자산마다 dist/assets.json에 남긴다. gen-app이 그것을 선언한다.
// 프레임 CSP(sandbox-frame.ts)는 script-src data: blob: 'unsafe-eval'이다.
// 사용: npm run build (마지막 단계).

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BOARD_JS_PREFIX, splitParts } from '../src/boardhtml.js';
import { MANIFEST_ASSET, CLIENT_PREFIX, EXPORT_ASSET } from '../src/manifest.js';

export const BUDGET = 28_000;
export const PART_MAX = 24_000; // 조각 하나의 base64 한도

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => join(ROOT, 'dist', name);
const gz64 = (buf) => gzipSync(buf, { level: 9 }).toString('base64');
const V = JSON.parse(readFileSync(join(ROOT, 'scripts', 'versions.json'), 'utf8'));

// 진입 로더. 매니페스트와 조각 형식만 알고 조각 수나 판은 모른다.
// 풀기나 실행이 실패하면 프레임은 오류를 바깥으로 넘기지 않으므로, 선언한 출력 notice로 알린다.
const entryLoader =
  '(async()=>{if(typeof DecompressionStream==="undefined")throw new Error("DecompressionStream을 쓸 수 없습니다");' +
  'const k=window.kaleidoscope,t=async i=>new TextDecoder().decode(await k.assets.bytes(i)).trim();' +
  'const m=JSON.parse(await t(' + JSON.stringify(MANIFEST_ASSET) + '));globalThis.MOODBOARD_MANIFEST=m;' +
  'const s=(await Promise.all(m.client.map(([i])=>t(i).then(x=>JSON.parse(x.replace(/;$/,"")))))).join("");' +
  'const b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));' +
  '(0,eval)(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text())})()' +
  '.catch(e=>{console.error("moodboard: 앱 코드를 불러오지 못했습니다",e);' +
  'try{window.kaleidoscope.publish({notice:"앱을 불러오지 못했어요: "+(e&&e.message||String(e)),has_notice:true})}catch(_){}});\n';

const partAssets = (from, prefix, group, version) => {
  const parts = splitParts(gz64(readFileSync(dist(from))), PART_MAX);
  return parts.map((part, i) => ({
    id: prefix + (i + 1), version, from, out: `${group}-${i + 1}.upload.js`, b64: `${group}-${i + 1}.upload.b64`,
    body: JSON.stringify(part) + ';\n', budget: PART_MAX, group, part: i + 1, parts: parts.length,
  }));
};

const clientParts = partAssets('moodboard.js', CLIENT_PREFIX, 'client', V.client);
const boardParts = partAssets('board.js', BOARD_JS_PREFIX, 'board-js', V.board);
const exportAsset = {
  id: EXPORT_ASSET, version: V.export, from: 'export.js', out: 'export.upload.js', b64: 'export.upload.b64',
  body: JSON.stringify(gz64(readFileSync(dist('export.js')))) + ';\n', budget: BUDGET, group: 'export',
};
const manifest = {
  client: clientParts.map((a) => [a.id, a.version]),
  board: boardParts.map((a) => [a.id, a.version]),
  export: [exportAsset.id, exportAsset.version],
};

const assets = [
  { id: 'moodboard', version: V.entry, out: 'moodboard.upload.js', b64: 'moodboard.upload.b64', body: entryLoader, budget: BUDGET, group: 'entry' },
  { id: MANIFEST_ASSET, version: V.manifest, out: 'manifest.upload.js', b64: 'manifest.upload.b64', body: JSON.stringify(manifest) + '\n', budget: BUDGET, group: 'manifest' },
  ...clientParts,
  ...boardParts,
  exportAsset,
];

const report = [];
let over = false;
for (const a of assets) {
  const body = Buffer.from(a.body);
  const b64 = body.toString('base64');
  writeFileSync(dist(a.out), body);
  writeFileSync(dist(a.b64), b64);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const ok = b64.length <= a.budget;
  if (!ok) over = true;
  report.push({
    id: a.id, version: a.version, format: 'javascript', group: a.group,
    ...(a.part ? { part: a.part, parts: a.parts } : {}),
    file: `dist/${a.out}`, base64_file: `dist/${a.b64}`,
    bytes: body.length, ...(a.from ? { source_bytes: readFileSync(dist(a.from)).length } : {}),
    base64_chars: b64.length, budget: a.budget, sha256,
  });
  console.log(`${ok ? 'ok  ' : 'OVER'} ${a.id}@${a.version}: base64 ${b64.length}/${a.budget}자, ${body.length}바이트, sha256 ${sha256}`);
}
writeFileSync(dist('assets.json'), JSON.stringify(report, null, 2) + '\n');
if (over) {
  console.error('base64가 한도를 넘는 자산이 있습니다. 코드를 더 나누세요.');
  process.exit(1);
}

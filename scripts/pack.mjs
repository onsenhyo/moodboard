// dist/moodboard.js를 gzip으로 줄여 올릴 자산 dist/moodboard.upload.js를 만든다.
// upload_asset은 data_base64를 도구 인자로 받으므로 크기를 줄이려고 둔다(42KB → 약 23KB).
// 프레임 CSP가 'unsafe-eval'과 data:/blob:을 허용하므로, 자산은 풀어서 eval로 실행한다.
// 사용: npm run build && node scripts/pack.mjs   → sha256과 base64 파일 경로를 찍는다.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'dist', 'moodboard.js'));
const gz = gzipSync(src, { level: 9 }).toString('base64');

const loader =
  '(async()=>{const b=Uint8Array.from(atob("' + gz + '"),c=>c.charCodeAt(0));' +
  '(0,eval)(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text())})()' +
  '.catch(e=>console.error("moodboard: 번들을 풀지 못했습니다",e));\n';

const out = join(ROOT, 'dist', 'moodboard.upload.js');
const b64Out = join(ROOT, 'dist', 'moodboard.upload.b64');
writeFileSync(out, loader);
writeFileSync(b64Out, Buffer.from(loader).toString('base64'));
const sha = createHash('sha256').update(loader).digest('hex');
console.log(`${out}: ${loader.length}바이트 (원본 ${src.length})`);
console.log(`sha256 ${sha}`);
console.log(`base64 ${b64Out}`);

// 내보내기 자산(moodboard-export)의 진입점. client 자산 크기를 줄이려고 내보내기 코드와 뷰어를 따로 묶는다.
// iife(global moodboardExport)로 묶고 scripts/pack.mjs가 base64(gzip) 문자열 리터럴 한 문장으로 담는다.
// client(main.js loadExport)는 내보낼 때만 kaleidoscope.assets.bytes로 읽어 풀고 eval한다.
export { planExport, buildExportChunks, exportMessages, runExport } from './export.js';
// 빌드 1단계(npm run build:viewer)가 만든 뷰어 iife. esbuild text loader로 문자열이 된다.
export { default as VIEWER_JS } from '../dist/viewer.txt';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import {
  planExport, buildExportChunks, exportMessages, exportFileName, runExport, bytesToBase64,
  CHUNK_MAX, WARN_BYTES, BLOCK_BYTES, OVERHEAD_BYTES,
} from '../src/export.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1000;
const MB = 1000 * 1000;

const card = (id, kind, extra = {}) => ({
  id, kind, title: id, color: '#ff0000', manual: { x: 0, y: 0, w: 240, h: 180 },
  hasThumb: false, includeVideo: false, updatedAt: 1, ...extra,
});
const boardOf = (cards, name = '내 보드') => ({ id: 'b1', name, cards, updatedAt: 1 });

function tenThumbs() {
  const cards = Array.from({ length: 10 }, (_, i) => card('img' + i, 'image', { hasThumb: true }));
  const thumbSizes = new Map(cards.map((c) => [c.id, 100 * KB]));
  return { cards, thumbSizes };
}

// --- planExport ---

test('기준 값은 십진 바이트다', () => {
  assert.equal(WARN_BYTES, 50_000_000);
  assert.equal(BLOCK_BYTES, 95_000_000);
  assert.equal(OVERHEAD_BYTES, 200_000);
});

test('썸네일 100KB 10장이면 ok, 크기는 base64 팽창과 고정 오버헤드를 더한다', () => {
  const { cards, thumbSizes } = tenThumbs();
  const plan = planExport(boardOf(cards), { thumbSizes, origSizes: new Map() });
  assert.equal(plan.level, 'ok');
  assert.equal(plan.estimate, Math.ceil(10 * 100 * KB * 4 / 3) + 200_000);
  assert.deepEqual(plan.videos, []);
});

test('재생 포함 영상 40MB가 더해지면 warn(약 53MB+)', () => {
  const { cards, thumbSizes } = tenThumbs();
  cards.push(card('v1', 'video', { includeVideo: true, origKey: 'orig/v1' }));
  const plan = planExport(boardOf(cards), { thumbSizes, origSizes: new Map([['v1', 40 * MB]]) });
  assert.equal(plan.level, 'warn');
  assert.ok(plan.estimate > 53 * MB && plan.estimate < 56 * MB, String(plan.estimate));
  assert.deepEqual(plan.videos, [{ cardId: 'v1', embed: true }]);
});

test('80MB 영상이면 block', () => {
  const { cards, thumbSizes } = tenThumbs();
  cards.push(card('v1', 'video', { includeVideo: true, origKey: 'orig/v1' }));
  const plan = planExport(boardOf(cards), { thumbSizes, origSizes: new Map([['v1', 80 * MB]]) });
  assert.equal(plan.level, 'block');
});

test('경계: 정확히 50,000,000은 ok, 95,000,000은 warn', () => {
  // 영상 크기 x에 대해 estimate = ceil(x*4/3) + 200,000
  const at = (target) => {
    const c = card('v', 'video', { includeVideo: true });
    return planExport(boardOf([c]), { thumbSizes: new Map(), origSizes: new Map([['v', (target - 200_000) * 3 / 4]]) });
  };
  assert.equal(at(50_000_000).level, 'ok');
  assert.equal(at(50_000_004).level, 'warn');
  assert.equal(at(95_000_000).level, 'warn');
  assert.equal(at(95_000_004).level, 'block');
});

test('원본이 없는 영상은 embed:false, reason 원본 없음이고 크기에 넣지 않는다', () => {
  const c = card('v1', 'video', { includeVideo: true, origKey: 'orig/v1' });
  const plan = planExport(boardOf([c]), { thumbSizes: new Map(), origSizes: new Map([['v1', null]]) });
  assert.deepEqual(plan.videos, [{ cardId: 'v1', embed: false, reason: '원본 없음' }]);
  assert.equal(plan.estimate, 200_000);
  const plan2 = planExport(boardOf([c]), { thumbSizes: new Map(), origSizes: new Map() });
  assert.deepEqual(plan2.videos, [{ cardId: 'v1', embed: false, reason: '원본 없음' }]);
});

test('videos에는 재생 포함을 켠 영상 카드만, 지운 카드는 빼고 넣는다', () => {
  const cards = [
    card('v-on', 'video', { includeVideo: true }),
    card('v-off', 'video', { includeVideo: false }),
    card('v-del', 'video', { includeVideo: true, deleted: true }),
    card('img', 'image', { includeVideo: true, hasThumb: true }),
    card('img-del', 'image', { hasThumb: true, deleted: true }),
  ];
  const origSizes = new Map([['v-on', 1000], ['v-off', 1000], ['v-del', 1000], ['img', 1000]]);
  const thumbSizes = new Map([['img', 300], ['img-del', 3 * MB]]);
  const plan = planExport(boardOf(cards), { thumbSizes, origSizes });
  assert.deepEqual(plan.videos, [{ cardId: 'v-on', embed: true }]);
  assert.equal(plan.estimate, Math.ceil((300 + 1000) * 4 / 3) + 200_000);
});

// --- 알림 문구 ---

test('block이면 notice에 크기와 재생 포함을 끌 영상 이름', () => {
  const cards = [card('a', 'video', { includeVideo: true, title: '바다' }), card('b', 'video', { includeVideo: true, title: '산' })];
  const plan = planExport(boardOf(cards), { thumbSizes: new Map(), origSizes: new Map([['a', 40 * MB], ['b', 40 * MB]]) });
  assert.equal(plan.level, 'block');
  const m = exportMessages(boardOf(cards), plan);
  assert.equal(m.notice, `내보내기 파일이 너무 커요 (약 ${Math.round(plan.estimate / MB)} MB). 재생 포함을 끌 영상: 바다, 산`);
  assert.equal(m.info, '');
});

test('warn이면 export_info에 약 N MB, ok면 빈 글', () => {
  const cards = [card('a', 'video', { includeVideo: true })];
  const warn = planExport(boardOf(cards), { thumbSizes: new Map(), origSizes: new Map([['a', 45 * MB]]) });
  assert.equal(warn.level, 'warn');
  assert.deepEqual(exportMessages(boardOf(cards), warn), { notice: null, info: `약 ${Math.round(warn.estimate / MB)} MB` });
  const ok = planExport(boardOf([]), { thumbSizes: new Map(), origSizes: new Map() });
  assert.deepEqual(exportMessages(boardOf([]), ok), { notice: null, info: '' });
});

test('파일 이름은 보드 이름.html, 경로 문자는 바꾼다', () => {
  assert.equal(exportFileName('내 보드'), '내 보드.html');
  assert.equal(exportFileName('a/b:c'), 'a_b_c.html');
  assert.equal(exportFileName('  '), '무드보드.html');
});

// --- base64 ---

test('bytesToBase64는 Buffer와 같은 결과', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100_000, 100_001]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

// --- buildExportChunks ---

let viewerJs;
async function viewer() {
  if (!viewerJs) {
    const r = await esbuild.build({
      entryPoints: [join(ROOT, 'src/viewer/viewer.js')], bundle: true, format: 'iife', minify: true, write: false,
    });
    viewerJs = r.outputFiles[0].text;
  }
  return viewerJs;
}

const thumbB64 = (seed) => Buffer.from(Uint8Array.from({ length: 3000 }, (_, i) => (i + seed) & 255)).toString('base64');
const videoBytes = Uint8Array.from({ length: 5 * 1024 * 1024 + 7 }, (_, i) => (i * 31) & 255);

function fixture() {
  const cards = [
    card('img-1', 'image', { hasThumb: true, color: '#3366ff' }),
    card('yt-1', 'youtube', { hasThumb: true, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', color: '#cc0000' }),
    card('pin-1', 'pinterest', { hasThumb: true, url: 'https://www.pinterest.com/pin/123/', note: '메모' }),
    card('txt-1', 'text', { text: '</script><script>alert(1)</script> & <b>', color: '#00aa00' }),
    card('link-1', 'link', { url: 'https://example.com/a?b=1' }),
    card('vid-1', 'video', { hasThumb: true, includeVideo: true, origKey: 'orig/vid-1', title: '영상' }),
    card('vid-2', 'video', { hasThumb: true, includeVideo: true, origKey: 'orig/vid-2' }),
    card('gone-1', 'image', { hasThumb: true, deleted: true }),
  ];
  const b = boardOf(cards, '여름 </title> 보드');
  const thumbs = new Map(cards.filter((c) => c.hasThumb).map((c, i) => [c.id, thumbB64(i)]));
  const plan = planExport(b, {
    thumbSizes: new Map([...thumbs].map(([k, v]) => [k, v.length * 3 / 4])),
    origSizes: new Map([['vid-1', videoBytes.length], ['vid-2', null]]),
  });
  const readers = {
    thumb: async (id) => thumbs.get(id) ?? null,
    video: async (id) => (id === 'vid-1' ? videoBytes.slice().buffer : null),
  };
  return { b, plan, readers, thumbs };
}

async function collect(iter) {
  const chunks = [];
  for await (const c of iter) chunks.push(c);
  return chunks;
}

test('buildExportChunks: 이어 붙이면 외부 요청 없는 단일 HTML, 조각은 4MiB 이하', async () => {
  const { b, plan, readers, thumbs } = fixture();
  const chunks = await collect(buildExportChunks(b, plan, { ...readers, viewerJs: await viewer() }));
  assert.equal(CHUNK_MAX, 4 * 1024 * 1024);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c instanceof Uint8Array);
    assert.ok(c.byteLength > 0 && c.byteLength <= CHUNK_MAX, String(c.byteLength));
  }
  const html = Buffer.concat(chunks).toString('utf8');
  writeFileSync('/tmp/moodboard-export-fixture.html', html);

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<style>/);
  // 외부 요청 0
  assert.doesNotMatch(html, /\bsrc\s*=\s*["']?\s*(https?:)?\/\//i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<iframe/i);
  // 모든 살아 있는 카드 id, 지운 카드는 없음
  for (const c of b.cards.filter((x) => !x.deleted)) assert.ok(html.includes(c.id), c.id);
  assert.ok(!html.includes('gone-1'));
  // 제목은 보드 이름(이스케이프)
  assert.match(html, /<title>여름 &lt;\/title&gt; 보드<\/title>/);

  // 구조: board JSON, 썸네일 블록, 영상 블록, 뷰어
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const live = b.cards.filter((x) => !x.deleted);
  const nThumbs = live.filter((x) => x.hasThumb).length;
  assert.equal(scripts.length, 1 + nThumbs + 1 + 1, '보드, 썸네일, 영상 1개, 뷰어');
  assert.equal(scripts[0][1], ' type="application/json" id="board"');
  const data = JSON.parse(scripts[0][2]);
  assert.equal(data.name, b.name);
  assert.deepEqual(data.cards.map((c) => c.id), live.map((c) => c.id));
  assert.equal(data.cards.find((c) => c.id === 'txt-1').text, '</script><script>alert(1)</script> & <b>');
  assert.deepEqual(data.cards.find((c) => c.id === 'img-1').manual, { x: 0, y: 0, w: 240, h: 180 });
  assert.equal(data.cards.find((c) => c.id === 'img-1').color, '#3366ff');
  assert.equal(data.cards.find((c) => c.id === 'vid-1').video, true);
  assert.equal(data.cards.find((c) => c.id === 'vid-2').video, false);
  assert.ok(!('origKey' in data.cards[0]));

  for (let i = 0; i < nThumbs; i++) {
    const [, attrs, body] = scripts[1 + i];
    const id = /data-thumb="([^"]+)"/.exec(attrs)[1];
    assert.match(attrs, /^ type="text\/plain" data-thumb="/);
    assert.equal(body, thumbs.get(id));
  }
  const [, vAttrs, vBody] = scripts[1 + nThumbs];
  assert.equal(vAttrs, ' type="text/plain" data-video="vid-1" data-mime="video/mp4"');
  assert.ok(Buffer.from(vBody, 'base64').equals(Buffer.from(videoBytes)));
  assert.equal(scripts[scripts.length - 1][1], '');
});

test('buildExportChunks: 큰 글 카드도 조각은 4MiB 이하', async () => {
  const big = card('t', 'text', { text: '가'.repeat(3 * 1024 * 1024) });
  const b = boardOf([big]);
  const plan = planExport(b, { thumbSizes: new Map(), origSizes: new Map() });
  const chunks = await collect(buildExportChunks(b, plan, { thumb: async () => null, video: async () => null, viewerJs: 'void 0' }));
  for (const c of chunks) assert.ok(c.byteLength <= CHUNK_MAX);
  assert.equal(JSON.parse(/id="board">([\s\S]*?)<\/script>/.exec(Buffer.concat(chunks).toString('utf8'))[1]).cards[0].text, big.text);
});

test('뷰어 코드 안의 </script는 이스케이프한다', async () => {
  const b = boardOf([]);
  const plan = planExport(b, { thumbSizes: new Map(), origSizes: new Map() });
  const chunks = await collect(buildExportChunks(b, plan, {
    thumb: async () => null, video: async () => null, viewerJs: 'var s="</script><!--";',
  }));
  const html = Buffer.concat(chunks).toString('utf8');
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.ok(!html.includes('<!--'));
});

test('뷰어 번들에 원격 주소 로딩이 없고 정렬은 앱과 같은 layout을 쓴다', async () => {
  const js = await viewer();
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|WebSocket|importScripts/);
  assert.ok(js.includes('noopener'));
  assert.ok(js.includes('_blank'));
});

// --- runExport ---

function fakeFiles({ fileId = 'f1', failAt = -1 } = {}) {
  const calls = [];
  return {
    calls,
    async savePrompt(opts) { calls.push(['save_prompt', opts]); return fileId; },
    async write(id, offset, bytes) {
      calls.push(['write', id, offset, bytes.byteLength]);
      if (calls.filter((c) => c[0] === 'write').length - 1 === failAt) throw new Error('디스크 가득');
    },
    async close(id) { calls.push(['close', id]); },
    async abort(id) { calls.push(['abort', id]); },
  };
}

async function* chunksOf(...sizes) { for (const n of sizes) yield new Uint8Array(n); }

test('runExport: offset을 누적하며 쓰고 close, 파일 이름을 돌려준다', async () => {
  const files = fakeFiles();
  const r = await runExport({ name: '내 보드', files, chunks: () => chunksOf(10, 20, 5) });
  assert.deepEqual(r, { status: 'done', name: '내 보드.html' });
  assert.deepEqual(files.calls, [
    ['save_prompt', { suggested_name: '내 보드.html', mime: 'text/html' }],
    ['write', 'f1', 0, 10], ['write', 'f1', 10, 20], ['write', 'f1', 30, 5],
    ['close', 'f1'],
  ]);
});

test('runExport: 저장 창을 취소하면 아무것도 쓰지 않는다', async () => {
  const files = fakeFiles({ fileId: null });
  let built = false;
  const r = await runExport({ name: 'x', files, chunks: () => { built = true; return chunksOf(1); } });
  assert.deepEqual(r, { status: 'cancelled' });
  assert.equal(files.calls.length, 1);
  assert.equal(built, false);
});

test('runExport: 중간에 실패하면 abort하고 오류를 던진다', async () => {
  const files = fakeFiles({ failAt: 1 });
  await assert.rejects(runExport({ name: 'x', files, chunks: () => chunksOf(1, 2, 3) }), /디스크 가득/);
  assert.deepEqual(files.calls.at(-1), ['abort', 'f1']);
  assert.ok(!files.calls.some((c) => c[0] === 'close'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  boardHtml, errorHtml, placeholderHtml, splitParts, partText, loadBoardHtml, boardPartId, BOARD_JS_PREFIX,
} from '../src/boardhtml.js';

const enc = (s) => new TextEncoder().encode(s).buffer;
const partBody = (s) => JSON.stringify(s) + ';\n';
const uploadB64 = (s) => Buffer.from(partBody(s)).toString('base64');

test('조각 id는 1부터', () => {
  assert.equal(boardPartId(0), BOARD_JS_PREFIX + '1');
  assert.equal(boardPartId(2), 'moodboard-board-js-3');
});

test('splitParts: 각 조각의 업로드 base64가 한도 이하이고, 이어 붙이면 원래 문자열', () => {
  const b64 = gzipSync(Buffer.from('x'.repeat(200_000) + Math.random())).toString('base64') +
    Buffer.alloc(60_000, 7).toString('base64');
  const parts = splitParts(b64, 24_000);
  assert.ok(parts.length >= 2);
  assert.equal(parts.join(''), b64);
  for (const p of parts) assert.ok(uploadB64(p).length <= 24_000, String(uploadB64(p).length));
  for (const p of parts.slice(0, -1)) {
    assert.equal(p.length % 4, 0);
    assert.equal(uploadB64(p).length, 24_000); // 한도를 꽉 채운다
  }
});

test('splitParts: 한도보다 작으면 조각 하나', () => {
  assert.deepEqual(splitParts('QUJD', 24_000), ['QUJD']);
});

test('partText는 문자열 리터럴 한 문장을 푼다', () => {
  assert.equal(partText(enc(partBody('QUJD'))), 'QUJD');
  assert.throws(() => partText(enc('42;')), /문자열이 아닙니다/);
});

test('loadBoardHtml은 조각을 순서대로 이어 HTML에 담는다', async () => {
  const b64 = Buffer.from('hello world, board').toString('base64');
  const parts = splitParts(b64, 16); // 조각 길이 8
  assert.ok(parts.length > 1);
  const ids = parts.map((_, i) => boardPartId(i));
  const asked = [];
  const html = await loadBoardHtml(ids, async (id) => { asked.push(id); return enc(partBody(parts[ids.indexOf(id)])); });
  assert.deepEqual(asked, ids);
  assert.ok(html.includes('atob("' + b64 + '")'));
  assert.equal(html, boardHtml(b64));
});

test('loadBoardHtml은 실패한 조각 id를 알린다', async () => {
  await assert.rejects(
    loadBoardHtml(['moodboard-board-js-1', 'moodboard-board-js-2'], async (id) => {
      if (id.endsWith('2')) throw new Error('선언하지 않은 자산');
      return enc(partBody('QUJD'));
    }),
    /moodboard-board-js-2: 선언하지 않은 자산/,
  );
  await assert.rejects(loadBoardHtml(undefined, async () => enc('')), /목록이 없습니다/);
});

test('boardHtml은 base64가 아니면 거부한다', () => {
  assert.throws(() => boardHtml('a"b</script>'), /base64가 아닙니다/);
});

test('자리표시와 오류 HTML은 테마 바탕에 글을 보이고, 오류 글은 이스케이프한다', () => {
  assert.ok(placeholderHtml.includes('보드를 불러오는 중…'));
  assert.ok(placeholderHtml.includes('#f7f3f7') && placeholderHtml.includes('#2a2230'));
  const html = errorHtml('<b>x</b> & "y"');
  assert.ok(html.includes('보드를 불러오지 못했어요: &#60;b&#62;x&#60;/b&#62; &#38; &#34;y&#34;'));
  assert.ok(!html.includes('<b>'));
});

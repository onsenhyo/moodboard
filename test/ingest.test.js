import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestFiles, ingestText, PLACEHOLDER_NOTE, PIN_SHORT_NOTE } from '../src/ingest.js';

const enc = (s) => new TextEncoder().encode(s).buffer;
const json = (o) => ({ bytes: enc(JSON.stringify(o)), mime: 'application/json' });
const RED = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0));

function fakeThumbs({ fullAfter = Infinity } = {}) {
  const t = {
    data: new Map(), puts: [],
    async put(cardId, b64) {
      if (t.data.size >= fullAfter) return { error: 'full' };
      t.puts.push(cardId);
      t.data.set(cardId, b64);
    },
    async get(cardId) { return t.data.get(cardId) ?? null; },
    async remove(cardId) { t.data.delete(cardId); },
  };
  return t;
}

// 가짜 deps. makeThumb은 mime이 heic이거나 0바이트면 null.
function fakeDeps(over = {}) {
  const calls = { blobPut: [], makeThumb: [], http: [] };
  let n = 0;
  const deps = {
    calls,
    readBytes: async (id) => (id.startsWith('empty') ? new ArrayBuffer(0) : new Uint8Array([1, 2, 3]).buffer),
    blobPut: async (key, fileId) => { calls.blobPut.push([key, fileId]); },
    makeThumb: async (bytes, mime) => {
      calls.makeThumb.push(mime);
      if (mime === 'image/heic' || bytes.byteLength === 0) return null;
      return { jpegB64: 'QUJD', pixels: RED, width: 640, height: 320 };
    },
    thumbs: fakeThumbs(),
    now: () => 1000,
    placeAt: () => ({ x: 10 * ++n, y: 20 }),
    httpRead: async () => { throw new Error('no http'); },
    ...over,
  };
  return deps;
}

const file = (id, name, mime, size = 3) => ({ id, name, mime, size });

test('이미지와 HEIC: 카드 2장, HEIC에는 note, blobPut 키', async () => {
  const deps = fakeDeps();
  const { cards, full } = await ingestFiles(
    [file('f1', 'cat.PNG', 'image/png'), file('f2', 'photo.heic', 'image/heic')], deps,
  );
  assert.equal(full, false);
  assert.equal(cards.length, 2);
  const [a, b] = cards;
  assert.equal(a.kind, 'image');
  assert.equal(a.title, 'cat.PNG');
  assert.equal(a.hasThumb, true);
  assert.equal(a.color, '#ff0000');
  assert.equal(a.note, undefined);
  assert.equal(a.origKey, `orig/${a.id}.png`);
  assert.equal(a.updatedAt, 1000);
  assert.deepEqual(a.manual, { x: 10, y: 20, w: 240, h: 120 });
  assert.equal(deps.thumbs.data.get(a.id), 'QUJD');

  assert.equal(b.kind, 'image');
  assert.equal(b.note, PLACEHOLDER_NOTE);
  assert.equal(PLACEHOLDER_NOTE, '미리보기를 만들 수 없어요');
  assert.equal(b.color, '#9e9e9e');
  assert.equal(b.hasThumb, false);
  assert.equal(b.origKey, `orig/${b.id}.heic`);
  assert.deepEqual(b.manual, { x: 20, y: 20, w: 240, h: 180 });

  assert.deepEqual(deps.calls.blobPut, [[`orig/${a.id}.png`, 'f1'], [`orig/${b.id}.heic`, 'f2']]);
});

test('0바이트 파일은 자리표시 카드, 예외 없음, 원본은 저장', async () => {
  const deps = fakeDeps();
  const { cards } = await ingestFiles([file('empty1', 'blank.jpg', 'image/jpeg', 0)], deps);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].note, PLACEHOLDER_NOTE);
  assert.equal(cards[0].hasThumb, false);
  assert.equal(cards[0].color, '#9e9e9e');
  assert.deepEqual(deps.calls.blobPut, [[`orig/${cards[0].id}.jpg`, 'empty1']]);
});

test('makeThumb이나 readBytes가 던져도 자리표시 카드로 넣고 다음 파일로 간다', async () => {
  const deps = fakeDeps({
    readBytes: async (id) => { if (id === 'bad') throw new Error('io'); return new Uint8Array([1]).buffer; },
  });
  const { cards } = await ingestFiles([file('bad', 'x.png', 'image/png'), file('ok', 'y.png', 'image/png')], deps);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].note, PLACEHOLDER_NOTE);
  assert.equal(cards[1].hasThumb, true);

  const deps2 = fakeDeps({ makeThumb: async () => { throw new Error('decode'); } });
  const r2 = await ingestFiles([file('a', 'z.webp', 'image/webp')], deps2);
  assert.equal(r2.cards[0].note, PLACEHOLDER_NOTE);
});

test('지원하지 않는 mime은 건너뛰고, mp4는 video 카드', async () => {
  const deps = fakeDeps();
  const { cards } = await ingestFiles([
    file('t', 'a.txt', 'text/plain'),
    file('m', 'b.mov', 'video/quicktime'),
    file('v', 'clip.mp4', 'video/mp4'),
  ], deps);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'video');
  assert.equal(cards[0].origKey, `orig/${cards[0].id}.mp4`);
  assert.equal(deps.calls.blobPut.length, 1);
});

test('확장자가 없으면 mime에서 정한다', async () => {
  const deps = fakeDeps();
  const { cards } = await ingestFiles([file('a', 'noext', 'image/jpeg'), file('b', 'vid', 'video/mp4')], deps);
  assert.equal(cards[0].origKey, `orig/${cards[0].id}.jpg`);
  assert.equal(cards[1].origKey, `orig/${cards[1].id}.mp4`);
});

test('blobPut이 던져도 카드는 남고, 썸네일이 있으면 note는 없다', async () => {
  const deps = fakeDeps({ blobPut: async () => { throw new Error('disk'); } });
  const { cards } = await ingestFiles([file('a', 'a.png', 'image/png'), file('b', 'b.heic', 'image/heic')], deps);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].hasThumb, true);
  assert.equal(cards[0].note, undefined);
  assert.equal(cards[1].note, PLACEHOLDER_NOTE);
});

test('썸네일 저장 공간이 차면 그 카드와 원본을 넣지 않고 멈춘다', async () => {
  const deps = fakeDeps({ thumbs: fakeThumbs({ fullAfter: 1 }) });
  const { cards, full } = await ingestFiles([
    file('a', 'a.png', 'image/png'), file('b', 'b.png', 'image/png'), file('c', 'c.png', 'image/png'),
  ], deps);
  assert.equal(full, true);
  assert.equal(cards.length, 1);
  assert.deepEqual(deps.calls.blobPut, [[`orig/${cards[0].id}.png`, 'a']]);
  assert.deepEqual(deps.calls.makeThumb, ['image/png', 'image/png']);
});

// --- ingestText ---

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('youtube: oEmbed 다음 hqdefault 순으로 읽고 title은 oEmbed', async () => {
  const deps = fakeDeps({
    httpRead: async (perm, path, query) => {
      deps.calls.http.push([perm, path, query]);
      if (perm === 'yt_oembed') return json({ title: 'Never Gonna' });
      return { bytes: new Uint8Array([9, 9]).buffer, mime: 'image/jpeg' };
    },
  });
  const { card, full } = await ingestText('https://youtu.be/dQw4w9WgXcQ', deps);
  assert.equal(full, false);
  assert.deepEqual(deps.calls.http, [
    ['yt_oembed', '/oembed', { url: YT, format: 'json' }],
    ['yt_thumb', '/vi/dQw4w9WgXcQ/hqdefault.jpg', {}],
  ]);
  assert.equal(card.kind, 'youtube');
  assert.equal(card.url, YT);
  assert.equal(card.title, 'Never Gonna');
  assert.equal(card.hasThumb, true);
  assert.equal(card.color, '#ff0000');
  assert.equal(card.updatedAt, 1000);
  assert.equal(deps.thumbs.data.get(card.id), 'QUJD');
});

test('youtube: oEmbed가 실패하면 링크 카드', async () => {
  const deps = fakeDeps();
  const { card } = await ingestText(YT, deps);
  assert.equal(card.kind, 'link');
  assert.equal(card.url, YT);
  assert.equal(card.title, 'www.youtube.com');
  assert.equal(card.hasThumb, false);
});

test('youtube: 썸네일만 실패하면 youtube 카드, hasThumb false', async () => {
  const deps = fakeDeps({
    httpRead: async (perm) => {
      if (perm === 'yt_oembed') return json({});
      throw new Error('404');
    },
  });
  const { card } = await ingestText(YT, deps);
  assert.equal(card.kind, 'youtube');
  assert.equal(card.title, YT);
  assert.equal(card.hasThumb, false);
  assert.equal(card.color, '#9e9e9e');
});

test('youtube: 썸네일 저장 공간이 차면 카드 없이 full', async () => {
  const deps = fakeDeps({
    thumbs: fakeThumbs({ fullAfter: 0 }),
    httpRead: async (perm) => (perm === 'yt_oembed' ? json({ title: 't' }) : { bytes: new Uint8Array([1]).buffer, mime: 'image/jpeg' }),
  });
  assert.deepEqual(await ingestText(YT, deps), { card: null, full: true });
});

const PIN = 'https://www.pinterest.com/pin/123456/';

test('pinterest: oEmbed의 thumbnail_url 경로로 pin_img를 읽는다', async () => {
  const deps = fakeDeps({
    httpRead: async (perm, path, query) => {
      deps.calls.http.push([perm, path, query]);
      if (perm === 'pin_oembed') return json({ title: 'Nice pin', thumbnail_url: 'https://i.pinimg.com/736x/aa/bb.jpg' });
      return { bytes: new Uint8Array([7]).buffer, mime: 'image/jpeg' };
    },
  });
  const { card } = await ingestText('https://kr.pinterest.com/pin/123456/?foo=1', deps);
  assert.deepEqual(deps.calls.http, [
    ['pin_oembed', '/oembed.json', { url: PIN }],
    ['pin_img', '/736x/aa/bb.jpg', {}],
  ]);
  assert.equal(card.kind, 'pinterest');
  assert.equal(card.url, PIN);
  assert.equal(card.title, 'Nice pin');
  assert.equal(card.hasThumb, true);
});

test('pinterest: title이 없으면 Pinterest', async () => {
  const deps = fakeDeps({
    httpRead: async (perm) => (perm === 'pin_oembed'
      ? json({ thumbnail_url: 'https://i.pinimg.com/236x/aa/bb.jpg' })
      : { bytes: new Uint8Array([7]).buffer, mime: 'image/jpeg' }),
  });
  const { card } = await ingestText(PIN, deps);
  assert.equal(card.title, 'Pinterest');
});

test('pinterest: 허용되지 않은 썸네일 주소는 읽지 않고 링크 카드', async () => {
  for (const thumb of ['https://i.pinimg.com/170x/aa/bb.jpg', 'https://evil.example/736x/aa.jpg', 'not a url', undefined]) {
    const deps = fakeDeps({
      httpRead: async (perm, path, query) => {
        deps.calls.http.push([perm, path, query]);
        return json({ title: 'x', thumbnail_url: thumb });
      },
    });
    const { card } = await ingestText(PIN, deps);
    assert.equal(card.kind, 'link', String(thumb));
    assert.equal(card.url, PIN);
    assert.deepEqual(deps.calls.http.map((c) => c[0]), ['pin_oembed']);
  }
});

test('pinterest: oEmbed나 이미지 읽기가 실패하면 링크 카드', async () => {
  assert.equal((await ingestText(PIN, fakeDeps())).card.kind, 'link');
  const deps = fakeDeps({
    httpRead: async (perm) => {
      if (perm === 'pin_oembed') return json({ thumbnail_url: 'https://i.pinimg.com/736x/aa/bb.jpg' });
      throw new Error('500');
    },
  });
  assert.equal((await ingestText(PIN, deps)).card.kind, 'link');
});

test('pin.it은 안내가 붙은 링크 카드', async () => {
  const deps = fakeDeps();
  const { card } = await ingestText('https://pin.it/abc', deps);
  assert.equal(card.kind, 'link');
  assert.equal(card.url, 'https://pin.it/abc');
  assert.equal(card.note, '브라우저 주소창의 주소를 넣어 주세요');
  assert.equal(PIN_SHORT_NOTE, card.note);
  assert.equal(card.title, 'pin.it');
  assert.deepEqual(deps.calls.http, []);
});

test('일반 링크는 hostname 제목의 링크 카드', async () => {
  const { card, full } = await ingestText('https://example.com/a/b', fakeDeps());
  assert.equal(full, false);
  assert.equal(card.kind, 'link');
  assert.equal(card.title, 'example.com');
  assert.equal(card.hasThumb, false);
  assert.equal(card.note, undefined);
  assert.deepEqual(card.manual, { x: 10, y: 20, w: 240, h: 180 });
});

test('글 카드: 첫 줄 40자 제목, 기본 색', async () => {
  const long = '가'.repeat(50);
  const { card } = await ingestText(`${long}\n둘째 줄`, fakeDeps());
  assert.equal(card.kind, 'text');
  assert.equal(card.text, `${long}\n둘째 줄`);
  assert.equal(card.title, '가'.repeat(40));
  assert.equal(card.color, '#9e9e9e');
  assert.equal(card.hasThumb, false);
  assert.equal(card.updatedAt, 1000);
});

test('빈 입력은 카드 없음', async () => {
  assert.deepEqual(await ingestText('   ', fakeDeps()), { card: null, full: false });
});

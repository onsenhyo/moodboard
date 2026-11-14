import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelOutputs, EMPTY_PANEL } from '../src/panel.js';

const base = { id: 'c1', title: 't', url: null, text: null, color: '#9e9e9e', hasOrig: false, origKey: null, thumbDataUrl: null, includeVideo: false, note: null };

test('panelOutputs: 선택이 없으면 모든 칸을 끈다', () => {
  assert.deepEqual(panelOutputs(null), EMPTY_PANEL);
  assert.equal(EMPTY_PANEL.sel_kind, null);
  assert.equal(EMPTY_PANEL.sel_none, true);
  assert.equal(panelOutputs({ ...base, kind: 'text' }).sel_has, true);
  assert.equal(panelOutputs({ ...base, kind: 'text' }).sel_has_note, false);
});

test('panelOutputs: 원본이 있는 이미지는 blob 그림, 없으면 썸네일 미리보기', () => {
  const withOrig = panelOutputs({ ...base, kind: 'image', hasOrig: true, origKey: 'orig/c1.png', thumbDataUrl: 'data:x' });
  assert.deepEqual(withOrig.sel_image, { blob: 'orig/c1.png' });
  assert.equal(withOrig.sel_thumb_preview, false);
  assert.equal(withOrig.sel_openable, false);

  const noOrig = panelOutputs({ ...base, kind: 'image', origKey: 'orig/c1.png', thumbDataUrl: 'data:x' });
  assert.equal(noOrig.sel_image, null);
  assert.equal(noOrig.sel_thumb_preview, true);
  assert.equal(noOrig.sel_show_image, false);
  assert.equal(withOrig.sel_show_image, true);

  const nothing = panelOutputs({ ...base, kind: 'image', origKey: 'orig/c1.heic', note: '미리보기를 만들 수 없어요' });
  assert.equal(nothing.sel_thumb_preview, false);
  assert.equal(nothing.sel_has_note, true);
});

test('panelOutputs: 핀터레스트는 썸네일 미리보기와 브라우저로 열기', () => {
  const o = panelOutputs({ ...base, kind: 'pinterest', url: 'https://www.pinterest.com/pin/1/', thumbDataUrl: 'data:x' });
  assert.equal(o.sel_thumb_preview, true);
  assert.equal(o.sel_openable, true);
  assert.equal(o.sel_image, null);
});

test('panelOutputs: 영상은 원본이 있으면 media blob, 없으면 안내', () => {
  const v = panelOutputs({ ...base, kind: 'video', hasOrig: true, origKey: 'orig/c1.mp4', includeVideo: true });
  assert.deepEqual(v.sel_video, { blob: 'orig/c1.mp4' });
  assert.equal(v.sel_video_missing, false);
  assert.equal(v.sel_show_video, true);
  assert.equal(v.sel_is_video, true);
  assert.equal(v.sel_include_video, true);
  const m = panelOutputs({ ...base, kind: 'video', origKey: 'orig/c1.mp4' });
  assert.equal(m.sel_video, null);
  assert.equal(m.sel_video_missing, true);
});

test('panelOutputs: 유튜브는 web_view용 주소와 열기', () => {
  const y = panelOutputs({ ...base, kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ' });
  assert.equal(y.sel_is_youtube, true);
  assert.equal(y.embed_url, 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  assert.equal(y.sel_openable, true);
  assert.equal(y.sel_thumb_preview, false);
});

test('panelOutputs: 글 카드는 글과 색, 링크는 열기만', () => {
  const t = panelOutputs({ ...base, kind: 'text', text: '안녕\n둘째', color: '#ff0000' });
  assert.equal(t.sel_is_text, true);
  assert.equal(t.sel_text, '안녕\n둘째');
  assert.equal(t.sel_color, '#ff0000');
  assert.equal(t.sel_openable, false);
  const l = panelOutputs({ ...base, kind: 'link', url: 'https://pin.it/abc', note: '브라우저 주소창의 주소를 넣어 주세요' });
  assert.equal(l.sel_openable, true);
  assert.equal(l.sel_note, '브라우저 주소창의 주소를 넣어 주세요');
  assert.equal(l.sel_is_text, false);
});

test('panelOutputs: https가 아닌 주소는 열기를 끈다', () => {
  const l = panelOutputs({ ...base, kind: 'link', url: 'http://example.com' });
  assert.equal(l.sel_openable, false);
});

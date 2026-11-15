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

test('panelOutputs: 묶음 출력 키는 EMPTY_PANEL에도 있다', () => {
  assert.equal(EMPTY_PANEL.group_selected, null);
  assert.equal(EMPTY_PANEL.has_group_selected, false);
  assert.deepEqual(Object.keys(panelOutputs(null)).sort(), Object.keys(EMPTY_PANEL).sort());
});

test('panelOutputs: 묶음을 고르면 이름과 카드 수, 카드 쪽 출력은 비어 있다', () => {
  const o = panelOutputs({ group: { id: 'g1', name: '여름', count: 3 } });
  assert.deepEqual(o.group_selected, { id: 'g1', name: '여름', count: 3 });
  assert.equal(o.has_group_selected, true);
  assert.deepEqual(Object.keys(o).sort(), Object.keys(EMPTY_PANEL).sort());
  for (const k of Object.keys(EMPTY_PANEL)) {
    if (k === 'group_selected' || k === 'has_group_selected' || k === 'sel_none') continue;
    assert.deepEqual(o[k], EMPTY_PANEL[k], k);
  }
  // 묶음을 골랐으니 "카드를 누르면" 안내는 끈다
  assert.equal(o.sel_none, false);
  assert.equal(o.sel_has, false);
});

test('panelOutputs: 카드를 고르면 묶음 출력은 비어 있다', () => {
  const o = panelOutputs({ ...base, kind: 'text', text: 'a' });
  assert.equal(o.group_selected, null);
  assert.equal(o.has_group_selected, false);
  assert.deepEqual(Object.keys(o).sort(), Object.keys(EMPTY_PANEL).sort());
});

test('panelOutputs: 글 카드의 종이 색. 없으면 기본 종이 색을 보이고 has_text_paper는 거짓', () => {
  const plain = panelOutputs({ ...base, kind: 'text', text: 'a', paperDefault: '#342b3b' });
  assert.equal(plain.sel_paper, '#342b3b');
  assert.equal(plain.has_text_paper, false);
  const set = panelOutputs({ ...base, kind: 'text', text: 'a', paper: '#fff3b0', paperDefault: '#ffffff' });
  assert.equal(set.sel_paper, '#fff3b0');
  assert.equal(set.has_text_paper, true);
  // 글 카드가 아니면 종이 칸을 쓰지 않는다
  const img = panelOutputs({ ...base, kind: 'image', paper: '#fff3b0' });
  assert.equal(img.has_text_paper, false);
  assert.equal(EMPTY_PANEL.has_text_paper, false);
  assert.equal(EMPTY_PANEL.sel_paper, '#ffffff');
  assert.deepEqual(Object.keys(set).sort(), Object.keys(EMPTY_PANEL).sort());
});

test('panelOutputs: 이름은 모든 카드, 메모 입력칸은 사진·영상·유튜브·핀터레스트·링크만', () => {
  const img = panelOutputs({ kind: 'image', title: 'a.jpg', label: '바다', memo: '메모' });
  assert.equal(img.sel_title, 'a.jpg');
  assert.equal(img.sel_label, '바다');
  assert.equal(img.sel_heading, '바다');
  assert.equal(img.sel_memo, '메모');
  assert.equal(img.has_memo_input, true);
  for (const kind of ['video', 'youtube', 'pinterest', 'link']) assert.equal(panelOutputs({ kind }).has_memo_input, true, kind);
  const txt = panelOutputs({ kind: 'text', title: '글', memo: 'x' });
  assert.equal(txt.has_memo_input, false);
  assert.equal(txt.sel_memo, '');
  assert.equal(txt.sel_heading, '글');
  assert.equal(txt.sel_label, '');
  assert.deepEqual(Object.keys(txt).sort(), Object.keys(EMPTY_PANEL).sort());
  const g = panelOutputs({ group: { id: 'g', name: 'n', count: 1 } });
  assert.equal(g.has_memo_input, false);
  assert.equal(g.sel_label, '');
});

test('boardOutputs: 지운 보드는 고르기에서 빼고, 삭제 확인 글에 지금 보드 이름을 넣는다', async () => {
  const { boardOutputs, boardDeleteText } = await import('../src/panel.js');
  const boards = [
    { id: 'a', name: '여행' },
    { id: 'gone', name: '옛 보드', deleted: true },
    { id: 'b', name: '집' },
  ];
  const o = boardOutputs(boards, 'b');
  assert.deepEqual(o.board_options, [{ value: 'a', label: '여행' }, { value: 'b', label: '집' }]);
  assert.equal(o.board_label, '집');
  assert.equal(o.board_delete_text, '「집」 보드를 지울까요? 카드도 함께 지워져요.');
  assert.equal(boardDeleteText('여행'), '「여행」 보드를 지울까요? 카드도 함께 지워져요.');
  assert.equal(boardOutputs(boards, 'gone').board_label, '');
  assert.deepEqual(boardOutputs(null, null).board_options, []);
});

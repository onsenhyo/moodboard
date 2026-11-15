// 옆 칸 블록에 줄 값. 블록의 when은 참(true)일 때만 그리고 client 출력의 안쪽 필드를 읽지 못하므로,
// 칸마다 쓸 참거짓과 미디어 참조를 여기서 따로 낸다.

export const EMPTY_PANEL = Object.freeze({
  sel_has: false,
  sel_none: true,
  sel_kind: null,
  sel_title: '', // 카드의 원래 제목(이름 입력칸의 placeholder)
  sel_heading: '', // 옆 칸 머리: 이름(label)이 있으면 이름, 없으면 제목
  sel_label: '', // 이름 입력칸 값. label이 없으면 ''
  sel_memo: '', // 메모 입력칸 값. memo가 없으면 ''
  has_memo_input: false, // 메모 입력칸을 보이는 종류인가(MEMO_KINDS)
  sel_note: null,
  sel_has_note: false,
  sel_image: null, // 이미지 원본 {blob}
  sel_show_image: false,
  sel_thumb_preview: false, // 원본이 없을 때 썸네일을 미리보기 canvas에 그린다
  sel_is_video: false,
  sel_video: null, // 영상 원본 {blob}
  sel_show_video: false,
  sel_video_missing: false,
  sel_include_video: false,
  sel_is_youtube: false,
  embed_url: null,
  sel_is_text: false,
  sel_text: '',
  sel_color: '#9e9e9e',
  sel_paper: '#ffffff', // 글 카드 종이 색. 없으면 테마 textBg(sel.paperDefault)
  has_text_paper: false, // 글 카드에 종이 색을 정했는가([기본 종이] 단추)
  sel_openable: false,
  group_selected: null, // {id, name, count}
  has_group_selected: false,
});

const HEX = /^#[0-9a-f]{6}$/i;
// 메모 입력칸을 두는 종류. 글 카드는 글을 바로 고치므로 메모가 없다.
export const MEMO_KINDS = new Set(['image', 'video', 'youtube', 'pinterest', 'link']);
const str = (v) => (typeof v === 'string' ? v : '');
const isHttps = (u) => typeof u === 'string' && /^https:\/\/\S+$/i.test(u);

// sel: null(고른 것 없음) | {group:{id, name, count}}(묶음) | 카드 선택 객체.
// 묶음을 고르면 카드 칸은 모두 비우고, "카드를 누르면" 안내(sel_none)도 끈다.
export function panelOutputs(sel) {
  if (!sel) return { ...EMPTY_PANEL };
  if (sel.group) {
    const g = sel.group;
    return {
      ...EMPTY_PANEL,
      sel_none: false,
      group_selected: { id: g.id, name: g.name ?? '', count: Number.isFinite(g.count) ? g.count : 0 },
      has_group_selected: true,
    };
  }
  const kind = sel.kind ?? null;
  const picture = kind === 'image' || kind === 'pinterest';
  const origImage = picture && sel.hasOrig && sel.origKey ? { blob: sel.origKey } : null;
  const thumb = picture && !origImage && !!sel.thumbDataUrl;
  const video = kind === 'video';
  const origVideo = video && sel.hasOrig && sel.origKey ? { blob: sel.origKey } : null;
  const note = typeof sel.note === 'string' && sel.note ? sel.note : null;
  return {
    sel_has: true,
    sel_none: false,
    sel_kind: kind,
    sel_title: sel.title ?? '',
    sel_heading: str(sel.label).trim() || (sel.title ?? ''),
    sel_label: str(sel.label),
    sel_memo: MEMO_KINDS.has(kind) ? str(sel.memo) : '',
    has_memo_input: MEMO_KINDS.has(kind),
    sel_note: note,
    sel_has_note: !!note,
    sel_image: origImage,
    sel_show_image: !!origImage,
    sel_thumb_preview: thumb,
    sel_is_video: video,
    sel_video: origVideo,
    sel_show_video: !!origVideo,
    sel_video_missing: video && !sel.hasOrig,
    sel_include_video: !!sel.includeVideo,
    sel_is_youtube: kind === 'youtube',
    embed_url: kind === 'youtube' ? sel.embedUrl ?? null : null,
    sel_is_text: kind === 'text',
    sel_text: kind === 'text' ? sel.text ?? '' : '',
    sel_color: sel.color ?? EMPTY_PANEL.sel_color,
    sel_paper: HEX.test(sel.paper ?? '') ? sel.paper : sel.paperDefault ?? EMPTY_PANEL.sel_paper,
    has_text_paper: kind === 'text' && HEX.test(sel.paper ?? ''),
    sel_openable: kind !== 'text' && kind !== 'image' && kind !== 'video' && isHttps(sel.url),
    group_selected: null,
    has_group_selected: false,
  };
}

// 보드 고르기와 보드 메뉴에 줄 값. 지운 보드(deleted)는 고르기에서 뺀다.
export const boardDeleteText = (name) => `「${name ?? ''}」 보드를 지울까요? 카드도 함께 지워져요.`;
export function boardOutputs(boards, boardId) {
  const live = (Array.isArray(boards) ? boards : []).filter((b) => b && !b.deleted);
  const cur = live.find((b) => b.id === boardId) ?? null;
  return {
    board_options: live.map((b) => ({ value: b.id, label: b.name })),
    board_label: cur?.name ?? '',
    board_delete_text: boardDeleteText(cur?.name),
  };
}

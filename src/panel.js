// 옆 칸 블록에 줄 값. 블록의 when은 참(true)일 때만 그리고 client 출력의 안쪽 필드를 읽지 못하므로,
// 칸마다 쓸 참거짓과 미디어 참조를 여기서 따로 낸다.

export const EMPTY_PANEL = Object.freeze({
  sel_has: false,
  sel_none: true,
  sel_kind: null,
  sel_title: '',
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

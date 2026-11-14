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
  sel_openable: false,
});

const isHttps = (u) => typeof u === 'string' && /^https:\/\/\S+$/i.test(u);

export function panelOutputs(sel) {
  if (!sel) return { ...EMPTY_PANEL };
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
    sel_openable: kind !== 'text' && kind !== 'image' && kind !== 'video' && isHttps(sel.url),
  };
}

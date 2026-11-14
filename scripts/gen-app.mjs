// app/moodboard.json을 만든다. 썸네일 저장 항목 128개를 손으로 쓰지 않으려고 둔 스크립트다.
// 사용: node scripts/gen-app.mjs [자산 판]   (자산 판 기본값 1. dist/moodboard.js를 올린 판과 맞춘다)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_ID = 'moodboard';
const ASSET_VERSION = Number(process.argv[2] ?? 1);
const SHARDS = 128; // src/main.js의 SHARDS와 같아야 한다.

if (!Number.isInteger(ASSET_VERSION) || ASSET_VERSION < 1) throw new Error('자산 판은 1 이상의 정수');

const shardId = (i) => 'thumbs_' + String(i).padStart(3, '0');

// --- 저장 항목 ---
// 저장 스키마는 엄격하다. 선언하지 않은 필드는 쓰기에서 거부되므로 카드와 보드의 필드를 모두 적는다.
const str = { type: 'string' };
const optStr = { type: ['string', 'null'] };
const num = { type: 'number' };
const bool = { type: 'boolean' };

const cardSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: str,
    kind: str, // image | video | youtube | pinterest | link | text
    title: optStr,
    color: optStr,
    manual: {
      type: 'object',
      properties: { x: num, y: num, w: num, h: num },
      additionalProperties: false,
    },
    hasThumb: bool,
    includeVideo: bool,
    updatedAt: num,
    origKey: optStr, // orig/<id>.<ext>, 이 PC의 blobs 키
    note: optStr,
    url: optStr,
    text: optStr,
    deleted: bool,
  },
  additionalProperties: false,
};

const boardSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: str,
    name: str,
    cards: { type: 'array', items: cardSchema },
    updatedAt: num,
    deleted: bool,
  },
  additionalProperties: false,
};

const boardsEntry = {
  id: 'boards',
  key: 'boards',
  kind: 'json',
  label: '보드',
  presentation: 'hidden',
  schema: {
    type: 'object',
    required: ['boards'],
    properties: {
      version: num,
      boards: { type: 'array', items: boardSchema },
    },
    additionalProperties: false,
  },
  default: { version: 1, boards: [] },
};

const thumbEntries = Array.from({ length: SHARDS }, (_, i) => ({
  id: shardId(i),
  key: shardId(i),
  kind: 'json',
  label: '썸네일',
  presentation: 'hidden',
  schema: { type: 'object', additionalProperties: { type: 'string' } },
  default: {},
}));

const storageIds = ['boards', ...thumbEntries.map((e) => e.id)];

// --- client ---

const outputs = {
  // Task 6
  selected: null,
  selected_url: null,
  board_options: [],
  notice: null,
  export_info: '',
  has_export_info: false, // Task 8: warn일 때 export_info(약 N MB)를 보인다
  board: null,
  board_label: '',
  mode: 'manual',
  sorted: false,
  // Task 7: 블록 바인딩용 참거짓과 미디어 참조(src/panel.js)
  manual_mode: true,
  has_notice: false,
  sel_has: false,
  sel_none: true,
  sel_kind: null,
  sel_title: '',
  sel_note: null,
  sel_has_note: false,
  sel_image: null,
  sel_show_image: false,
  sel_thumb_preview: false,
  sel_is_video: false,
  sel_video: null,
  sel_show_video: false,
  sel_video_missing: false,
  sel_include_video: false,
  sel_is_youtube: false,
  embed_url: null,
  sel_is_text: false,
  sel_text: '',
  sel_color: '#9e9e9e',
  sel_openable: false,
};

const actions = [
  'drop', 'pick', 'add_text', 'sort_color', 'sort_manual', 'zoom_in', 'zoom_out', 'zoom_fit', 'pointer',
  'delete_selected', 'set_text_color', 'set_text', 'toggle_include_video', 'board_select', 'board_new',
  'board_rename', 'export',
];

// --- 화면 ---

const c = (name) => ({ client: name });
const when = (flag, child) => ({ type: 'when', value: c(flag), child });

const toolbar = {
  type: 'toolbar',
  start: [
    {
      type: 'select', label: '보드', label_position: 'hidden',
      value: c('board'), options: c('board_options'), on_change: c('board_select'),
    },
    { type: 'button', label: '새 보드', on_click: c('board_new') },
    { type: 'button', label: '이름 바꾸기', on_click: [{ set_state: 'rename_open', value: true }] },
    {
      type: 'input', label: '링크나 글', label_position: 'hidden', placeholder: '링크나 글을 넣고 Enter',
      value: { state: 'draft' }, commit: 'submit', on_change: { set_state: 'draft' }, on_submit: c('add_text'),
    },
    {
      type: 'button', label: '파일 추가',
      on_click: {
        pick_files: {
          accept: [
            { mime: 'image/*', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif'] },
            { mime: 'video/mp4', extensions: ['mp4', 'm4v'] },
          ],
          multiple: true, client: 'pick',
        },
      },
    },
  ],
  end: [
    { type: 'button', label: '색으로 정렬', variant: 'chip', pressed: c('sorted'), on_click: c('sort_color') },
    { type: 'button', label: '내 배치', variant: 'chip', pressed: c('manual_mode'), on_click: c('sort_manual') },
    { type: 'button', label: '−', description: '축소', on_click: c('zoom_out') },
    { type: 'button', label: '+', description: '확대', on_click: c('zoom_in') },
    { type: 'button', label: '맞춤', on_click: c('zoom_fit') },
    // 단일 HTML 내보내기(src/export.js). 저장 창은 client가 save_prompt로 연다.
    { type: 'button', label: '내보내기', on_click: c('export') },
  ],
};

const detail = {
  type: 'stack', direction: 'column', gap: 'small',
  children: [
    { type: 'text', style: 'title', value: c('sel_title') },
    when('sel_has_note', { type: 'text', style: 'meta', value: c('sel_note') }),
    // 이미지·핀터레스트: 원본이 이 PC에 있으면 blob, 없으면 썸네일을 미리보기 canvas에 그린다(image는 data: 주소를 받지 않는다).
    when('sel_show_image', { type: 'image', src: c('sel_image'), fit: 'contain', zoom: true }),
    when('sel_thumb_preview', { type: 'canvas', surface: 'preview', aspect_ratio: 1.333, description: c('sel_title') }),
    // 영상
    when('sel_show_video', { type: 'media', src: c('sel_video'), kind: 'video' }),
    when('sel_video_missing', { type: 'text', value: '원본은 다른 PC에 있어요' }),
    when('sel_is_video', {
      type: 'toggle', label: '내보내기에 재생 포함',
      value: c('sel_include_video'), on_change: c('toggle_include_video'),
    }),
    // 유튜브. web_view의 url은 창 상태만 받으므로 client가 yt_embed에 쓴다.
    when('sel_is_youtube', { type: 'web_view', url: { state: 'yt_embed' } }),
    // 글
    when('sel_is_text', {
      type: 'input', label: '글', label_position: 'hidden', multiline: true, rows: 6,
      value: c('sel_text'), on_change: c('set_text'),
    }),
    when('sel_is_text', { type: 'color', label: '색', value: c('sel_color'), on_change: c('set_text_color') }),
    when('sel_openable', { type: 'button', label: '브라우저로 열기', on_click: { open_url: c('selected_url') } }),
    {
      type: 'button', label: '삭제', variant: 'danger', on_click: c('delete_selected'),
      confirm: { title: '이 카드를 지울까요?', ok: '삭제' },
    },
  ],
};

const side = {
  type: 'stack', direction: 'column', gap: 'small',
  children: [
    when('sel_has', detail),
    when('sel_none', { type: 'text', style: 'meta', value: '카드를 누르면 여기에 자세히 보여요' }),
  ],
};

const renameDialog = {
  type: 'dialog',
  open: { state: 'rename_open' },
  title: '보드 이름 바꾸기',
  close_label: '바꾸기',
  child: {
    type: 'input', label: '새 이름', label_position: 'top', focus: { state: 'rename_open' },
    placeholder: c('board_label'), value: { state: 'board_name' },
    on_change: { set_state: 'board_name' },
    on_submit: c('board_rename'), // client 동작은 목록에 섞을 수 없다. 핸들러가 rename_open을 끈다
  },
  on_confirm: c('board_rename'),
  on_close: [{ set_state: 'rename_open', value: false }, { set_state: 'board_name', value: '' }],
};

const ui = {
  type: 'stack', direction: 'column', gap: 'none', fill: 2,
  children: [
    toolbar,
    when('has_notice', { type: 'notice', message: c('notice') }),
    when('has_export_info', { type: 'text', style: 'meta', value: c('export_info') }),
    {
      type: 'split', direction: 'row', sizes: [0.72, 0.28],
      children: [
        { type: 'canvas', surface: 'board', on_pointer: c('pointer'), description: '무드보드' },
        side,
      ],
    },
    renameDialog,
  ],
};

const app = {
  id: 'moodboard',
  name: '무드보드',
  description: '이미지, 영상, 링크, 글을 한 판에 모으고 색으로 정렬합니다.',
  requires: { blocks: 52, modules: { assets: 1, client: 7, http: 2, storage: 1, web: 1 } },
  permissions: [
    { module: 'http', id: 'yt-oembed', label: '유튜브 정보', base_url: 'https://www.youtube.com', paths: ['/oembed'] },
    { module: 'http', id: 'yt-thumb', label: '유튜브 썸네일', base_url: 'https://i.ytimg.com', paths: ['/vi/'] },
    { module: 'http', id: 'pin-oembed', label: '핀터레스트 정보', base_url: 'https://www.pinterest.com', paths: ['/oembed.json'] },
    {
      module: 'http', id: 'pin-img', label: '핀터레스트 이미지', base_url: 'https://i.pinimg.com',
      paths: ['/originals/', '/1200x/', '/736x/', '/564x/', '/474x/', '/236x/'],
    },
  ],
  state: { draft: '', board_name: '', board: null, yt_embed: null, rename_open: false },
  assets: [{ id: ASSET_ID, version: ASSET_VERSION }],
  storage: { entries: [boardsEntry, ...thumbEntries] },
  client: {
    runtime: 'javascript',
    entry: { id: ASSET_ID, version: ASSET_VERSION },
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, { default: v }])),
    actions,
    state_keys: ['draft', 'board_name', 'board', 'yt_embed', 'rename_open'],
    storage_entries: storageIds,
    http_permissions: ['yt-oembed', 'yt-thumb', 'pin-oembed', 'pin-img'],
    device_storage: { prefixes: ['orig/'] },
  },
  file_drop: {
    accept: [
      { mime: 'image/*', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif'] },
      { mime: 'video/mp4', extensions: ['mp4', 'm4v'] },
    ],
    multiple: true,
    client: 'drop',
  },
  window_size: { width: 1200, height: 800 },
  ui,
};

mkdirSync(join(ROOT, 'app'), { recursive: true });
writeFileSync(join(ROOT, 'app', 'moodboard.json'), JSON.stringify(app, null, 2) + '\n');
console.log(`app/moodboard.json: 자산 ${ASSET_ID}@${ASSET_VERSION}, 저장 항목 ${storageIds.length}개`);

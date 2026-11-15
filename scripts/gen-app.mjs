// app/moodboard.json을 만든다. 썸네일 저장 항목 128개를 손으로 쓰지 않으려고 둔 스크립트다.
// 사용: node scripts/gen-app.mjs [client 판] [board 판] [export 판]
//   client는 자산 moodboard(dist/moodboard.upload.js), board는 moodboard-board(dist/board.html),
//   export는 moodboard-export(dist/export.upload.js). 기본값 10 3 2. 올린 판과 맞춘다.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_ID = 'moodboard';
const BOARD_ASSET = 'moodboard-board';
const EXPORT_ASSET = 'moodboard-export'; // src/main.js의 EXPORT_ASSET과 같아야 한다.
const [ASSET_VERSION, BOARD_VERSION, EXPORT_VERSION] = [10, 3, 2].map((d, i) => Number(process.argv[2 + i] ?? d));
const SHARDS = 128; // src/main.js와 src/board/board.js의 SHARDS와 같아야 한다.

for (const v of [ASSET_VERSION, BOARD_VERSION, EXPORT_VERSION]) {
  if (!Number.isInteger(v) || v < 1) throw new Error('자산 판은 1 이상의 정수');
}

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
    groupId: str, // 묶음 id. 묶음 밖이면 필드가 없다
    paper: str, // 글 카드 종이 색 '#rrggbb'. 기본(테마 textBg)이면 필드가 없다
    deleted: bool,
    label: str, // 사용자가 붙인 이름. 없으면 필드가 없고 title을 쓴다
    memo: str, // 메모(500자까지). 없으면 필드가 없다
  },
  additionalProperties: false,
};

const groupSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: str,
    name: str,
    rect: {
      type: 'object',
      properties: { x: num, y: num, w: num, h: num },
      additionalProperties: false,
    },
    collapsed: bool,
    updatedAt: num,
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
    groups: { type: 'array', items: groupSchema },
    bg: str, // 보드 배경 '#rrggbb'. 기본(테마 bg)이면 필드가 없다
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
  // 4차: 카드 이름과 메모
  sel_heading: '',
  sel_label: '',
  sel_memo: '',
  has_memo_input: false,
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
  // 2차 Task 4: 묶음 선택(src/panel.js. 합치기 전에는 main.js의 SHIM이 채운다)
  group_selected: null, // {id, name, count}|null
  has_group_selected: false,
  group_count_label: '', // 옆 칸 'N장'. 블록은 group_selected.count를 읽지 못해 main.js가 따로 낸다
  // 3차 A: 보드 배경과 글 카드 종이 색
  board_bg: '#f7f3f7', // 툴바 [배경]. 보드 bg가 없으면 테마 bg
  has_board_bg: false,
  sel_paper: '#ffffff', // 옆 칸 [종이 색]. 카드 paper가 없으면 테마 textBg
  has_text_paper: false,
};

const actions = [
  'drop', 'pick', 'add_text', 'sort_color', 'sort_manual', 'zoom_in', 'zoom_out', 'zoom_fit',
  'delete_selected', 'set_text_color', 'set_text', 'toggle_include_video', 'board_select', 'board_new',
  'board_rename', 'export', 'group_add', 'group_rename', 'group_delete',
  'set_board_bg', 'reset_board_bg', 'set_text_paper', 'reset_text_paper',
  'set_card_label', 'set_card_memo',
];

// --- 창 상태 ---
// board(client가 씀), mode·cmd(툴바 → client가 씀), selected(보드가 쓰고 client도 씀), view·paste_inbox(보드가 씀).
const BOARD_STATE = ['board', 'selected', 'view', 'mode', 'cmd', 'paste_inbox'];

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
    { type: 'button', label: '묶음 추가', on_click: c('group_add') },
    // 보드 배경. 값이 없으면 테마 바탕을 보이고, [기본 배경]은 보드의 bg 키를 지운다.
    { type: 'color', label: '배경', value: c('board_bg'), on_change: c('set_board_bg') },
    { type: 'button', label: '기본 배경', on_click: c('reset_board_bg') },
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
    { type: 'text', style: 'title', value: c('sel_heading') },
    // 이름: Enter로 바꾼다. 비우고 Enter면 원래 제목(placeholder)으로 돌아간다.
    {
      type: 'input', label: '이름', label_position: 'top', placeholder: c('sel_title'),
      value: c('sel_label'), commit: 'submit', on_change: c('set_card_label'),
    },
    // 메모: 여러 줄이라 Enter는 줄바꿈이다. 입력칸을 떠날 때(blur) 저장한다.
    when('has_memo_input', {
      type: 'input', label: '메모', label_position: 'top', multiline: true, rows: 3,
      placeholder: '메모 (500자까지)', value: c('sel_memo'), commit: 'blur', on_change: c('set_card_memo'),
    }),
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
    when('sel_is_text', { type: 'color', label: '종이 색', value: c('sel_paper'), on_change: c('set_text_paper') }),
    when('has_text_paper', { type: 'button', label: '기본 종이', on_click: c('reset_text_paper') }),
    when('sel_openable', { type: 'button', label: '브라우저로 열기', on_click: { open_url: c('selected_url') } }),
    {
      type: 'button', label: '삭제', variant: 'danger', on_click: c('delete_selected'),
      confirm: { title: '이 카드를 지울까요?', ok: '삭제' },
    },
  ],
};

// 묶음을 골랐을 때 옆 칸. 이름은 Enter로 바꾼다.
const groupDetail = {
  type: 'stack', direction: 'column', gap: 'small',
  children: [
    {
      type: 'input', label: '묶음 이름', label_position: 'top', placeholder: '묶음 이름을 넣고 Enter',
      value: { state: 'group_name' }, commit: 'submit', on_change: { set_state: 'group_name' }, on_submit: c('group_rename'),
    },
    { type: 'text', style: 'meta', value: c('group_count_label') },
    {
      type: 'button', label: '묶음 삭제', variant: 'danger', on_click: c('group_delete'),
      confirm: { title: '이 묶음을 지울까요? 안의 카드는 남아요', ok: '삭제' },
    },
  ],
};

const side = {
  type: 'stack', direction: 'column', gap: 'small',
  children: [
    when('has_group_selected', groupDetail),
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
  type: 'stack', direction: 'column', gap: 'none', fill: 3, // 3 = split(캔버스+옆 칸)이 남은 높이를 채운다
  children: [
    toolbar,
    when('has_notice', { type: 'notice', message: c('notice') }),
    when('has_export_info', { type: 'text', style: 'meta', value: c('export_info') }),
    {
      type: 'split', direction: 'row', sizes: [0.72, 0.28],
      children: [
        // 보드는 sandbox가 그린다(src/board/board.js). 보통 iframe이라 wheel, 집기, 키보드, 붙여넣기를 받고
        // 쉘 테두리 없이 surface-solid 바탕에 놓인다. 주고받는 창 상태는 BOARD_STATE.
        {
          type: 'sandbox', asset: BOARD_ASSET, title: '무드보드: 끌어 옮기고, 두 손가락으로 이동, 집어서 확대',
          state_keys: BOARD_STATE, storage_entries: storageIds,
        },
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
  state: {
    draft: '', board_name: '', board: null, yt_embed: null, rename_open: false, group_name: '', theme: 'light',
    selected: null, view: null, mode: 'manual', cmd: null, paste_inbox: null,
  },
  assets: [
    { id: ASSET_ID, version: ASSET_VERSION },
    { id: BOARD_ASSET, version: BOARD_VERSION },
    { id: EXPORT_ASSET, version: EXPORT_VERSION },
  ],
  storage: { entries: [boardsEntry, ...thumbEntries] },
  client: {
    runtime: 'javascript',
    entry: { id: ASSET_ID, version: ASSET_VERSION },
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, { default: v }])),
    actions,
    state_keys: ['draft', 'board_name', 'yt_embed', 'rename_open', 'group_name', 'theme', ...BOARD_STATE],
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
console.log(`app/moodboard.json: 자산 ${ASSET_ID}@${ASSET_VERSION}, ${BOARD_ASSET}@${BOARD_VERSION}, `
  + `${EXPORT_ASSET}@${EXPORT_VERSION}, 저장 항목 ${storageIds.length}개`);

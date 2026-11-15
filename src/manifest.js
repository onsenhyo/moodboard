// 자산 매니페스트(moodboard-manifest). 진입 로더(scripts/pack.mjs)가 읽어 globalThis.MOODBOARD_MANIFEST에 둔다.
// 모양: {client:[[id,판]…], board:[[id,판]…], export:[id,판]}. 조각 배치가 바뀌면 매니페스트 판만 올라가고
// 진입 로더 moodboard는 그대로다.

export const MANIFEST_ASSET = 'moodboard-manifest';
export const CLIENT_PREFIX = 'moodboard-client-';
export const EXPORT_ASSET = 'moodboard-export';

const ids = (list) => (Array.isArray(list) ? list.map((e) => (Array.isArray(e) ? e[0] : e)).filter((id) => typeof id === 'string') : []);

// 보드 코드 조각 id 목록. 매니페스트가 없거나 비었으면 빈 배열(loadBoardHtml이 오류로 알린다).
export const boardPartIds = (m) => ids(m?.board);

// 내보내기 자산 id. 매니페스트에 없으면 기본 id.
export const exportAssetId = (m) => (Array.isArray(m?.export) && typeof m.export[0] === 'string' ? m.export[0] : EXPORT_ASSET);

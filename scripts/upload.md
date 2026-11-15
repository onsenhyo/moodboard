# 새 판 올리기

1. `npm test && npm run build` — build는 다섯 단계다.
   - `build:viewer`: 내보내기 뷰어(`src/viewer/viewer.js`)를 iife로 묶어 `dist/viewer.txt`.
   - `build:export`: `src/export-entry.js`(export.js + 뷰어 글, text loader)를 iife(global `moodboardExport`)로 `dist/export.js`.
   - `build:client`: `src/main.js` → `dist/moodboard.js`. `build:board`: `src/board/board.js` → `dist/board.js`.
   - `scripts/pack.mjs`: 올릴 자산을 만들고 판, base64 크기, sha256을 찍는다(`dist/assets.json`에도 남는다).
     판은 `scripts/versions.json` 한 곳에서 묶음마다 정한다. 조각은 업로드 base64가 24,000자 이하가 되게 자동으로 나누고,
     진입 로더·매니페스트·export는 28,000자를 넘으면 빌드가 실패한다.
2. 올릴 자산(바뀐 것만 올린다. 모두 javascript)
   - `moodboard` (진입 로더): `dist/moodboard.upload.b64`. 매니페스트를 읽어 `globalThis.MOODBOARD_MANIFEST`에 두고
     client 조각을 이어 풀어 eval한다. 조각 수나 판을 모르므로 로더 자체를 고칠 때만 판을 올린다.
   - `moodboard-manifest`: `dist/manifest.upload.b64`. `{client:[[id,판]…], board:[[id,판]…], export:[id,판]}`.
     내용이 바뀌면(조각 수, 다른 묶음의 판) 이 판을 올린다.
   - `moodboard-client-1`…`-N` (client 코드 조각): `dist/client-<i>.upload.b64`.
   - `moodboard-board-js-1`…`-N` (보드 코드 조각): `dist/board-js-<i>.upload.b64`.
     sandbox 블록은 `assets.bytes`를 받지 못해(쉘 `sandbox.tsx`가 답하지 않는다) client가 매니페스트의 board 조각을 읽어
     보드 HTML(`src/boardhtml.js`)을 만들고 출력 `board_html`로 한 번 낸다. 블록은 `value: {client:'board_html'}`.
   - `moodboard-export` (내보내기 코드와 뷰어. client가 내보낼 때만 읽는다): `dist/export.upload.b64`
   판 올리기: 묶음(client, board, export)의 조각 하나라도 바이트가 바뀌면 `versions.json`의 그 묶음 판을 1 올리고
   (묶음의 조각은 모두 같은 판으로 다시 올린다), 그러면 매니페스트 내용이 바뀌므로 `manifest`도 1 올린다.
   이전 `dist/assets.json`과 sha256을 견줘 바뀐 자산을 고른다.
3. `node scripts/gen-app.mjs` → `app/moodboard.json`. `dist/assets.json`의 자산과 판을 모두 선언하므로 build 뒤에 돌린다.
   지금 판: moodboard 12, manifest 1, client 조각 1, board 조각 1, export 2.
4. MCP `upload_asset`을 자산마다: id, version, format, sha256은 1의 값, data_base64는 `.b64` 내용.
5. MCP `preview_app`(definition = `app/moodboard.json`) — 오류와 warnings가 없어야 한다.
6. MCP `upload_app`(같은 definition) — `open_sent_to`가 1 이상인지 본다.
7. MCP `get_workspace` — 창이 새 판으로 떴고 data_errors가 없는지 본다.

주의
- 권한 id는 소문자·숫자·`-`만, client 출력·동작 이름은 소문자·숫자·`_`만 된다.
- client 동작(`{"client":…}`)은 동작 목록에 섞지 못한다. 단독으로 쓴다.
- 저장 스키마를 바꾸면 `src/model.js`·`src/ingest.js`가 쓰는 카드 필드를 모두 적었는지 확인한다.

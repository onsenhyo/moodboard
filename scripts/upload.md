# 새 판 올리기

1. `npm test && npm run build` — build는 다섯 단계다.
   - `build:viewer`: 내보내기 뷰어(`src/viewer/viewer.js`)를 iife로 묶어 `dist/viewer.txt`.
   - `build:export`: `src/export-entry.js`(export.js + 뷰어 글, text loader)를 iife(global `moodboardExport`)로 `dist/export.js`.
   - `build:client`: `src/main.js` → `dist/moodboard.js`. `build:board`: `src/board/board.js` → `dist/board.js`.
   - `scripts/pack.mjs`: 올릴 자산을 만들고 base64 크기와 sha256을 찍는다(`dist/assets.json`에도 남는다).
     client와 export는 28,000자, 보드 코드 조각은 24,000자를 넘으면 빌드가 실패한다.
     보드 코드(`dist/board.js`)는 base64(gzip)를 조각마다 24,000자 이하가 되게 자동으로 나눈다. 조각 수가 바뀌면
     client 로더의 조각 목록(`MOODBOARD_BOARD_PARTS`)도 바뀌므로 client 판도 올린다.
2. 올릴 자산(바뀐 것만 판을 1 올린다)
   - `moodboard` (javascript, client 로더): `dist/moodboard.upload.b64`
   - `moodboard-board-js-1`…`-N` (javascript, 보드 코드 조각. 모두 같은 판): `dist/board-js-<i>.upload.b64`.
     sandbox 블록은 `assets.bytes`를 받지 못해(쉘 `sandbox.tsx`가 답하지 않는다) client가 조각을 모두 읽어
     보드 HTML(`src/boardhtml.js`)을 만들고 출력 `board_html`로 한 번 낸다. 블록은 `value: {client:'board_html'}`.
   - `moodboard-export` (javascript, 내보내기 코드와 뷰어. client가 내보낼 때만 `assets.bytes`로 읽는다): `dist/export.upload.b64`
3. `node scripts/gen-app.mjs <client 판> <보드 코드 조각 판> <export 판>` → `app/moodboard.json`.
   조각 id는 `dist/assets.json`에서 읽으므로 build 뒤에 돌린다. 지금 판: client 11, 조각 1, export 2.
4. MCP `upload_asset`을 자산마다: id, version, format, sha256은 1의 값, data_base64는 `.b64` 내용.
5. MCP `preview_app`(definition = `app/moodboard.json`) — 오류와 warnings가 없어야 한다.
6. MCP `upload_app`(같은 definition) — `open_sent_to`가 1 이상인지 본다.
7. MCP `get_workspace` — 창이 새 판으로 떴고 data_errors가 없는지 본다.

주의
- 권한 id는 소문자·숫자·`-`만, client 출력·동작 이름은 소문자·숫자·`_`만 된다.
- client 동작(`{"client":…}`)은 동작 목록에 섞지 못한다. 단독으로 쓴다.
- 저장 스키마를 바꾸면 `src/model.js`·`src/ingest.js`가 쓰는 카드 필드를 모두 적었는지 확인한다.

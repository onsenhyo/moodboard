# 새 판 올리기

1. `npm test && npm run build`
2. `node scripts/pack.mjs` — `dist/moodboard.upload.js`(gzip 로더)와 sha256, `dist/moodboard.upload.b64`를 낸다.
3. `node scripts/gen-app.mjs <자산 판>` — 지난 자산 판보다 1 큰 수를 준다(`app/moodboard.json`).
4. MCP `upload_asset`: id `moodboard`, version `<자산 판>`, format `javascript`, sha256은 2의 값, data_base64는 `.b64` 내용.
5. MCP `preview_app`(definition = `app/moodboard.json`) — 오류와 warnings가 없어야 한다.
6. MCP `upload_app`(같은 definition) — `open_sent_to`가 1 이상인지 본다.
7. MCP `get_workspace` — 창이 새 판으로 떴고 data_errors가 없는지 본다.

주의
- 권한 id는 소문자·숫자·`-`만, client 출력·동작 이름은 소문자·숫자·`_`만 된다.
- client 동작(`{"client":…}`)은 동작 목록에 섞지 못한다. 단독으로 쓴다.
- 저장 스키마를 바꾸면 `src/model.js`·`src/ingest.js`가 쓰는 카드 필드를 모두 적었는지 확인한다.

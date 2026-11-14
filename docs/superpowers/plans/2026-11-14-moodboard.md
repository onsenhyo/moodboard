# 무드보드 앱 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미지·MP4·유튜브·핀터레스트·글을 자유 캔버스에 카드로 모으고, 색으로 정렬하고, 단일 HTML로 내보내는 kaleidoscope 개인 앱을 만든다.

**Architecture:** kaleidoscope 앱 정의(JSON) 하나와 client JavaScript 자산 하나로 구성한다. 자산은 `src/`의 ES 모듈을 esbuild로 묶어 만든다. 계산 로직은 순수 함수로 분리해 Node에서 테스트한다. 플랫폼 호출(`window.kaleidoscope`)은 `src/platform/`의 얇은 어댑터에만 두고, 테스트에서는 가짜로 바꾼다. 화면은 `canvas` 하나에 client가 그리고, 툴바·입력칸·옆 칸은 블록으로 만든다.

**Tech Stack:** kaleidoscope 앱 정의 + client 런타임(javascript), 바닐라 JS(ES2022), esbuild(번들), `node --test`(테스트). 런타임 의존성은 없다.

**Spec:** `docs/superpowers/specs/2026-11-14-moodboard-design.md` (실행자는 이 문서도 함께 읽는다)

**플랫폼 정본:** kaleidoscope 리포 `/Users/seunghyunhong/orca/projects/kaleido/kaleidoscope`의 `crates/contract/src/app_guide.txt`, `upload_app` 입력 스키마, `examples/image-cache.{json,js}`(http·blobs·pick_files 예), `examples/surface-gallery.*`(canvas 표면), `ui/src/blocks/sandbox-frame.ts`(브리지 API 목록).

## Global Constraints

- 앱 id는 `moodboard`, 이름은 `무드보드`이다. 화면 글은 한국어로 쓴다.
- `requires.modules`: `assets` 1, `client` ≥7(`file_drop`), `http` 2. `requires.blocks`는 사용하는 필드 중 가장 높은 판으로 맞춘다. 최소 52(blob 미디어)이고, `open_url` 36, `file_drop` 45, `list.layout` 46도 이 안에 든다.
- HTTP 권한은 정확히 다음 네 개다. 와일드카드를 쓰지 않고, 리다이렉트는 거부된다.
  - `yt_oembed`: `https://www.youtube.com` · `["/oembed"]`
  - `yt_thumb`: `https://i.ytimg.com` · `["/vi/"]`
  - `pin_oembed`: `https://www.pinterest.com` · `["/oembed.json"]`
  - `pin_img`: `https://i.pinimg.com` · `["/originals/","/1200x/","/736x/","/564x/","/474x/","/236x/"]` (Task 1에서 확인)
- `pin.it` 주소는 지원하지 않는다. 카드 안내 문구는 정확히 `브라우저 주소창의 주소를 넣어 주세요`이다.
- 원본 파일은 `blobs`에만 두고, 접두어는 `orig/`이다. 이미지는 `orig/<cardId>.<ext>`, 영상은 `orig/<cardId>.mp4`. 확장자는 원본 그대로 둔다.
- 썸네일: JPEG, 긴 변 640px·품질 0.75에서 시작해 base64 길이 ≤100,000자가 될 때까지 품질 0.75→0.5, 다음에 크기 640→480 순으로 낮춘다(Task 1 결과로 확정).
- 썸네일 저장: 고정 storage 항목 `thumbs_000`~`thumbs_127`(128개, 각 schema `{type:"object", additionalProperties:{type:"string"}}`, 값은 `{cardId: base64}`). 한도는 항목의 `JSON.stringify` 바이트 1,048,576이며 배치 상한은 1,000,000바이트로 둔다. 128개가 업로드에서 거부되면 32개로 줄인다(사용자 승인).
- storage 오류: 충돌은 `{code:'conflict', id:'STORAGE_ITEM_WRITE_CONFLICT'}`, 크기 초과는 `{id:'STORAGE_WRITE_JSON_TOO_LARGE'}`. 충돌 뒤에는 반드시 `getStorage`로 다시 읽은 다음 써야 한다(그냥 재시도하면 계속 충돌).
- canvas `on_pointer` 이벤트: `event = {phase:'down'|'move'|'up'|'cancel', pointer_id, x, y, buttons, shift, alt, ctrl, meta}`, x·y는 그린 영역 기준 0~1. move는 버튼 없이도 오며 프레임당 하나로 합쳐진다.
- 내보내기: 예상 크기가 50MB를 넘으면 경고하고, 95MB를 넘으면 막는다. 쓰기는 4MiB 조각 단위로 `files.write(sink, offset, bytes)`를 부른다.
- MP4 썸네일은 1초 지점의 장면이다. 영상이 1초보다 짧으면 0초 장면을 쓴다.
- 글 카드의 기본 색은 `#9e9e9e`이다. 채도가 0.15 미만인 색은 무채색 구역으로 보낸다.
- 정렬 모드에서는 카드를 옮길 수 없다. 옮기려 하면 `내 배치로 바꾸면 옮길 수 있어요`를 알린다.

## Review Focus

1. **망가진 URL이나 지원하지 않는 URL**(`pin.it`, `youtu.be/?`, 공백이 섞인 주소, `http://`): 예외가 나지 않고, 안내가 붙은 "기타 링크" 카드가 된다. → Task 2 `classifyInput` 테스트.
2. **디코드할 수 없는 파일**(HEIC 이미지, HEVC MP4, 0바이트 파일): 회색 자리표시 썸네일과 `미리보기를 만들 수 없어요` 문구가 붙은 카드로 들어가고, 다른 파일의 처리는 계속된다. → Task 5 `ingestFiles` 테스트.
3. **두 PC에서 동시에 편집**: 저장 충돌(revision CAS 실패)이 나면 최신 보드를 다시 읽고, 카드 단위로 합친 뒤 다시 저장한다. 어느 한쪽 카드도 사라지지 않는다. → Task 4 `mergeBoards` 테스트.
4. **원본이 없는 PC**: 크게 보기는 썸네일로, MP4는 `원본은 다른 PC에 있어요`로 보인다. 그 PC에서는 "재생 포함"을 켤 수 없고, 내보내기는 정지 장면으로 진행한다. → Task 8 `planExport` 테스트.
5. **카드가 아주 많은 보드**(500장): 썸네일 저장 공간 한도에 닿으면 새 카드 추가를 막고 한도를 알린다. 저장 단위 1MiB를 넘는 쓰기가 일어나지 않는다. → Task 4 `packThumbs` 테스트.

---

## 파일 구조 (moodboard 리포 루트 기준)

```
package.json                 # esbuild, 스크립트: build, test
app/moodboard.json           # 앱 정의 (Task 7)
src/model.js                 # 카드·보드 타입 생성자와 상수
src/classify.js              # 입력 문자열 → 카드 종류 판별
src/color.js                 # 대표 색 추출, hue 정렬 키
src/layout.js                # 정렬 배치, 화면 변환, 히트 테스트
src/interaction.js           # 포인터 상태 기계(순수)
src/store.js                 # 보드 직렬화, 병합, 썸네일 저장 단위 배치
src/ingest.js                # 파일/URL → 카드 + 썸네일 (플랫폼 주입)
src/thumb.js                 # 브라우저 전용: 이미지·영상 → JPEG 썸네일
src/render.js                # 브라우저 전용: canvas 그리기와 애니메이션
src/export.js                # 내보내기 계획과 HTML 문자열 생성
src/viewer/viewer.js         # 내보낸 HTML 안에 들어가는 읽기 전용 뷰어
src/platform/kaleidoscope.js # window.kaleidoscope 어댑터
src/main.js                  # client 진입점: 핸들러 연결
test/*.test.js               # node --test
dist/moodboard.js            # 번들 결과 (커밋하지 않음)
```

---

### Task 1: 플랫폼 확인 스파이크 (버리는 코드)

설계의 가정 세 가지를 실제 쉘에서 확인한다. 여기서 나온 결과로 Task 4의 썸네일 저장 방식을 확정한다.

**Files:**
- Create: `spike/spike.json`, `spike/spike.js` (확인 후 지우고, 결과만 `docs/spike-results.md`에 남긴다)

- [ ] **Step 1:** client 브리지에 모음(collection) 문서를 읽고 쓰는 호출이 있는지 확인한다. 소스 근거: `sandbox-frame.ts:161-163`에는 `getStorage(entry)`와 `setStorage(entry, content)`만 있고 doc 인자가 없다. `ui/src/runtime/client-runtime.ts`와 `crates/core/src/client_services.rs`에서 `collection`이나 `doc`을 받는 경로를 찾는다.
- [ ] **Step 2:** 고정 JSON storage 항목 두 개(`thumbs_00`, `thumbs_01`)를 선언하는 시험 앱을 올린다. `setStorage('thumbs_00', {…900KB 문자열…})`가 성공하는지, `1.1MB`가 거부되는지 확인한다. 그다음 두 번째 PC(또는 같은 원격 서버에 연결된 다른 쉘)에서 `getStorage`로 같은 값이 보이는지 확인한다. 두 번째 기기가 없으면 `read_app_storage` MCP 도구로 서버에 값이 있는지 확인한다.
- [ ] **Step 3:** `file_drop`으로 MP4를 받아 `<video>`(blob URL)의 `seeked` 이벤트 뒤에 OffscreenCanvas로 `drawImage`하고 `getImageData`가 되는지 확인한다(H.264 파일 하나, HEVC 파일 하나).
- [ ] **Step 4:** `pin_img` 권한을 `paths: ["/"]`로 둔 뒤 `/736x/…jpg`가 허용되는지 확인한다.
- [ ] **Step 5:** 결과를 `docs/spike-results.md`에 적는다. 시험 앱은 `delete_app`으로 지운다. **썸네일 저장 결정:** 모음 문서를 client에서 쓸 수 있으면 `collection` 방식을 쓴다. 쓸 수 없으면 고정 항목 `thumbs_00`~`thumbs_31`(항목당 ≤1MiB, 총 32MiB) 묶음 방식을 쓴다. 묶음 방식이면 보드 용량이 카드 약 300장(장당 ~100KB)으로 제한되므로, **사용자에게 보고하고 진행 승인을 받는다.**
- [ ] **Step 6: Commit** `git add docs/spike-results.md && git commit -m "플랫폼 확인 결과 기록"`

### Task 2: 프로젝트 골격 + 입력 판별

**Files:**
- Create: `package.json`, `src/model.js`, `src/classify.js`, `test/classify.test.js`

**Interfaces:**
- Produces:
  - `classifyInput(raw: string) -> {kind:'youtube', videoId} | {kind:'pinterest', pinId} | {kind:'pin_short', url} | {kind:'link', url} | {kind:'text', text} | null`
    - 앞뒤 공백만 있으면 `null`을 돌려준다.
  - `model.js`:
    - `newCard({kind, ...}) -> Card`
    - `Card = {id, kind:'image'|'video'|'youtube'|'pinterest'|'text'|'link', title, url?, text?, color:'#rrggbb', manual:{x,y,w,h}, origKey?, hasThumb:boolean, includeVideo:boolean, note?:string, updatedAt:number}`
    - `newBoard(name) -> Board`, `Board = {id, name, cards:Card[], updatedAt}`
    - `TEXT_DEFAULT_COLOR = '#9e9e9e'`

- [ ] **Step 1:** `package.json`을 만든다. `"type":"module"`이고 스크립트는 `"test":"node --test test/"`와 `"build":"esbuild src/main.js --bundle --format=iife --outfile=dist/moodboard.js"`이다. `.gitignore`에 `node_modules/`와 `dist/`를 추가한다.
- [ ] **Step 2: 실패하는 테스트**
```js
test('youtube 형태들', () => {
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'])
    assert.deepEqual(classifyInput(u), { kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
});
test('pinterest 지역 도메인', () => {
  for (const u of ['https://www.pinterest.com/pin/123456789/', 'https://kr.pinterest.com/pin/123456789/', 'https://pinterest.co.kr/pin/123456789'])
    assert.deepEqual(classifyInput(u), { kind: 'pinterest', pinId: '123456789' });
});
test('pin.it은 pin_short', () => assert.equal(classifyInput('https://pin.it/abc').kind, 'pin_short'));
test('기타 링크·http', () => assert.deepEqual(classifyInput(' http://example.com/a '), { kind: 'link', url: 'http://example.com/a' }));
test('망가진 youtube는 link', () => assert.equal(classifyInput('https://youtu.be/?').kind, 'link'));
test('글', () => assert.deepEqual(classifyInput('빛이 부서지는 오후'), { kind: 'text', text: '빛이 부서지는 오후' }));
test('빈 입력', () => assert.equal(classifyInput('   '), null));
```
- [ ] **Step 3:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 4:** `classifyInput`과 `model.js`를 구현한다. 판별은 `new URL()`로 하고, 예외가 나면 글로 본다. videoId는 11자 `[A-Za-z0-9_-]`이다.
- [ ] **Step 5:** `npm test` PASS를 확인한다.
- [ ] **Step 6: Commit** `git commit -am "입력 판별과 카드 모델"`

### Task 3: 대표 색과 정렬 배치

**Files:**
- Create: `src/color.js`, `src/layout.js`, `test/color.test.js`, `test/layout.test.js`

**Interfaces:**
- Produces:
  - `dominantColor(rgba: Uint8ClampedArray) -> '#rrggbb'`
    - 입력은 64×64 이하로 줄인 픽셀이다.
    - 색을 4비트 버킷으로 나눈 뒤 `count × (0.3 + saturation)`이 가장 큰 버킷의 평균색을 고른다.
    - 투명 픽셀(alpha < 128)은 무시한다.
  - `colorSortKey(hex) -> {group:0|1, hue:number, light:number}`: 채도가 0.15 미만이면 group 1(무채색)이다.
  - `sortedLayout(cards: Card[], {cols:number, cell:number, gap:number}) -> Map<cardId,{x,y,w,h}>`
    - 정렬은 group 오름차순, 다음 hue 오름차순, 다음 light 내림차순이다.
    - 무채색 group은 새 줄에서 시작한다.
    - 카드의 가로세로 비율은 유지하고, 각 칸 안에 맞춘다.
  - `toScreen(view:{x,y,scale}, rect) -> rect`, `toWorld(view, point) -> point`
  - `hitTest(cards, rectOf:(card)=>rect, worldPoint) -> {card, zone:'body'|'resize'} | null`
    - 가장 위(배열 끝)에 있는 카드부터 검사한다.
    - 오른쪽 아래 12×12 화면 px는 `resize` 구역이다. 크기는 `view.scale`로 나눠 계산한다.

- [ ] **Step 1: 실패하는 테스트**: 빨강 픽셀이 70%, 회색이 30%이면 결과 hue가 빨강 근처(±10°)이다. 회색이 90%이고 진파랑이 10%이면 파랑이 이긴다(채도 가중치 확인). 모두 투명이면 `#9e9e9e`이다. `sortedLayout`은 `['#ff0000','#0000ff','#808080','#00ff00']` 입력을 빨강→초록→파랑 순으로 놓고, 회색은 다음 줄 첫 칸에 놓는다. `hitTest`는 두 카드가 겹친 지점에서 배열 뒤쪽 카드를 돌려주고, 모서리 지점에서는 `zone:'resize'`를 돌려준다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `npm test`를 실행해 PASS를 확인한다.
- [ ] **Step 5: Commit** `git commit -am "대표 색, 정렬 배치, 히트 테스트"`

### Task 4: 저장 형식, 병합, 썸네일 배치

Task 1 결과: client는 모음 문서를 쓸 수 없으므로 묶음(shard) 방식으로 `ThumbStore`를 구현한다.

**Files:**
- Create: `src/store.js`, `test/store.test.js`

**Interfaces:**
- Consumes: `Card`, `Board` (Task 2)
- Produces:
  - storage 항목 `boards`(JSON): `{version:1, boards:Board[]}`. 썸네일 바이트는 넣지 않는다.
  - `mergeBoards(local: BoardsDoc, remote: BoardsDoc) -> BoardsDoc`
    - 보드와 카드를 id 기준으로 합친다. 같은 id면 `updatedAt`이 큰 쪽을 쓴다.
    - 삭제는 `deleted:true` 묘비로 남긴다. 묘비는 30일 뒤 정리한다.
  - `saveWithRetry(adapter, mutate:(doc)=>doc, {tries:3}) -> Promise<BoardsDoc>`: CAS 실패 시 다시 읽고 `mergeBoards` 후 재시도한다.
  - `packThumbs(existing: Map<shardId, Map<cardId,b64>>, add:{cardId,b64}, {shardLimit:1_000_000, shards:128}) -> {shardId} | {error:'full'}`; shardId는 `thumbs_000` 형식
  - `ThumbStore = {get(cardId)->Promise<b64|null>, put(cardId,b64)->Promise<void|{error:'full'}>, remove(cardId)}`

- [ ] **Step 1: 실패하는 테스트**
  - 병합: 로컬과 원격에 각자 새 카드가 하나씩 있으면 둘 다 남는다. 같은 카드를 양쪽에서 옮겼으면 `updatedAt`이 큰 쪽 좌표가 남는다. 한쪽이 삭제했으면 묘비가 이긴다.
  - `saveWithRetry`: 가짜 어댑터가 첫 번째 쓰기에서 `conflict`를 던지면, 다시 읽고 병합한 값으로 두 번째에 성공한다. 세 번 다 실패하면 에러를 던진다.
  - `packThumbs`: 300KB 썸네일 4장이 들어가면 같은 shard에 3장, 다음 shard에 1장이 놓인다(테스트는 `shards` 옵션을 작게 줘도 된다). 모든 shard가 다 차면 `{error:'full'}`을 돌려준다. 어떤 shard도 직렬화 크기가 1,000,000바이트를 넘지 않는다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다. storage 쓰기의 충돌 판별은 `isConflict(err) = err?.code === 'conflict'`이다.
- [ ] **Step 4:** `npm test`를 실행해 PASS를 확인한다.
- [ ] **Step 5: Commit** `git commit -am "보드 저장, 병합, 썸네일 저장소"`

### Task 5: 자료 넣기 (파일·URL → 카드)

**Files:**
- Create: `src/ingest.js`, `src/thumb.js`, `test/ingest.test.js`

**Interfaces:**
- Consumes: `classifyInput`, `newCard`, `dominantColor`, `ThumbStore`
- Produces:
  - `ingestFiles(files: ClientFile[], deps) -> Promise<Card[]>`
    - `deps = {readBytes(fileId), blobPut(key, fileId), makeThumb(bytes, mime) -> {jpegB64, pixels}|null, thumbs: ThumbStore, now(), placeAt() -> {x,y}}`
    - 이미지(`image/*`)와 `video/mp4`만 받는다. 실패한 파일은 자리표시 카드(`note:'미리보기를 만들 수 없어요'`, color `#9e9e9e`)로 넣고 다음 파일로 넘어간다.
  - `ingestText(raw: string, deps) -> Promise<Card|null>`
    - `deps`에는 `httpRead(permission, path, query) -> {bytes, mime}`가 추가된다.
    - youtube: `yt_oembed`로 `/oembed`(`url`, `format=json`)를 불러 title을 얻고, `yt_thumb`의 `/vi/<id>/hqdefault.jpg`로 썸네일을 얻는다.
    - pinterest: `pin_oembed`로 `/oembed.json`(`url=https://www.pinterest.com/pin/<id>/`)를 불러 `thumbnail_url`을 얻고, `pin_img`로 그 경로를 읽는다.
    - `pin_short`와 `link`는 썸네일 없는 카드다. `pin_short`에는 `note:'브라우저 주소창의 주소를 넣어 주세요'`를 단다.
    - HTTP가 실패하면 링크 카드로 내려간다.
  - `thumb.js` (브라우저 전용, 테스트하지 않는다): `makeThumb(bytes, mime) -> Promise<{jpegB64, pixels: Uint8ClampedArray}|null>`
    - 이미지는 `createImageBitmap`으로 연다. 영상은 `<video>`의 blob URL에서 `currentTime = min(1, duration)` 후 `seeked`, 이어서 `requestVideoFrameCallback`을 기다린 뒤 그린다(`seeked`에서 바로 그리면 검은 화면).
    - 썸네일 크기와 품질 단계는 Global Constraints를 따른다. `pixels`는 64×64로 줄인 RGBA이다.

- [ ] **Step 1: 실패하는 테스트** (deps는 가짜로 넣는다)
  - 이미지 1개와 HEIC 1개(`makeThumb`이 null)를 넣으면 카드 2장이 생기고, 두 번째에는 note가 붙는다. `blobPut`은 `orig/<id>.png`와 `orig/<id>.heic`로 불린다.
  - 0바이트 파일도 자리표시 카드가 되고 예외가 나지 않는다.
  - youtube URL이면 `httpRead`가 `('yt_oembed','/oembed',{url, format:'json'})` 다음 `('yt_thumb','/vi/dQw4w9WgXcQ/hqdefault.jpg',{})` 순으로 불리고, 카드 title이 oEmbed의 title이다.
  - oEmbed가 실패하면 `kind:'link'` 카드가 된다.
  - pinterest URL이면 `thumbnail_url` `https://i.pinimg.com/736x/aa/bb.jpg`에서 path `/736x/aa/bb.jpg`로 `pin_img`를 읽는다.
  - `pin.it`이면 note 문구가 정확히 일치한다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `npm test`를 실행해 PASS를 확인한다.
- [ ] **Step 5: Commit** `git commit -am "파일과 링크 넣기"`

### Task 6: 캔버스 그리기와 조작

**Files:**
- Create: `src/interaction.js`, `src/render.js`, `src/main.js`, `src/platform/kaleidoscope.js`, `test/interaction.test.js`

**Interfaces:**
- Consumes: `layout.js` 전부, `store.js`, `ingest.js`, `thumb.js`
- Produces:
  - `interaction.js`의 순수 상태 기계: `reduce(state, pointerEvent) -> {state, effects[]}`
    - pointerEvent 형태는 canvas `on_pointer`가 주는 것을 그대로 쓴다. 정확한 필드는 `crates/contract/src/lib.rs:1759-1777`과 `surface-gallery.js`에서 확인한다.
    - effects: `{type:'select', cardId|null}`, `{type:'moved', cardId, rect}`, `{type:'notice', text}`
  - client outputs(블록 바인딩용): `selected`(카드 요약 객체 또는 null), `selectedUrl`(string|null), `boardOptions`(`[{value,label}]`), `notice`(string|null), `exportInfo`(string)
  - client actions: `drop`(file_drop), `pick`(pick_files), `add_text`, `sort_color`, `sort_manual`, `zoom_in`, `zoom_out`, `zoom_fit`, `pointer`, `delete_selected`, `set_text_color`, `toggle_include_video`, `board_select`, `board_new`, `board_rename`, `export`

- [ ] **Step 1: 실패하는 테스트**
  - 수동 모드에서 카드 몸통을 누르고 끌면 `moved` effect가 나온다.
  - 모서리를 끌면 w와 h만 바뀐다.
  - 빈 곳을 끌면 `view.x`와 `view.y`가 바뀌고 effect는 없다.
  - 정렬 모드에서 카드를 끌면 좌표는 그대로이고 `notice` effect의 text가 `내 배치로 바꾸면 옮길 수 있어요`이다.
  - 클릭(이동 4px 미만)하면 `select`가 나온다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** `src/interaction.js`에 상태 기계를 구현한다.
- [ ] **Step 4:** `npm test`를 실행해 PASS를 확인한다.
- [ ] **Step 5:** `render.js`를 구현한다(브라우저 전용).
  - 카드는 썸네일이나 글 카드(종이색 `#f3efe6`, 오른쪽 아래 색 점), 종류 배지(▶ 🎞 📌 ✎ 🔗), note가 있으면 아래 띠로 그린다.
  - 모드가 바뀌면 300ms ease-out으로 보간한다.
  - `visible:false`이면 그리기 루프를 멈춘다(app_guide 14판 규칙).
  - 새 카드는 화면 가운데 ±40px 무작위 위치에 놓는다.
- [ ] **Step 6:** `main.js`에서 어댑터와 핸들러를 연결한다. `npm run build`가 성공하는지 확인한다.
- [ ] **Step 7: Commit** `git commit -am "캔버스 그리기와 조작"`

### Task 7: 앱 정의와 실제 쉘 확인

**Files:**
- Create: `app/moodboard.json`, `scripts/upload.md`(MCP로 올리는 순서 메모)

**Interfaces:**
- Consumes: Task 6의 client outputs와 actions 이름

- [ ] **Step 1:** 앱 정의를 쓴다. 필드는 `upload_app` 스키마 정본을 따른다.
  - **위쪽 toolbar**: 보드 select(`boardOptions`), [새 보드], [이름 바꾸기], 입력칸(링크나 글, commit `submit`, 제출하면 `add_text`), [파일 추가](`pick_files` → `pick`), [색으로 정렬]/[내 배치](chip, pressed), [−][+][맞춤], [내보내기].
  - **본문**: 분할 비율 0.72로 나눈다.
    - 왼쪽: `canvas` surface `board`, `on_pointer` → `pointer`.
    - 오른쪽 상세 칸(`when` selected):
      - 이미지와 핀터레스트는 `image`(원본 blob이 있으면 `{"blob":origKey}`, 없으면 썸네일)와 [브라우저로 열기](`open_url`, `selectedUrl`)를 둔다.
      - MP4는 `media`(blob). 원본이 없으면 `원본은 다른 PC에 있어요`를 보인다. "내보내기에 재생 포함" toggle을 둔다.
      - 유튜브는 `web_view`(`https://www.youtube.com/embed/<id>`)와 [브라우저로 열기]를 둔다.
      - 글은 여러 줄 input, 색 `color`, [삭제](danger)를 둔다.
  - `notice` 블록에 `notice`를 바인딩한다.
  - `file_drop`: accept는 `image/*`와 `video/mp4`, multiple true, client `drop`.
  - `storage.entries`: `boards`(JSON, 기본값 `{"version":1,"boards":[]}`)와 Task 1에서 정한 썸네일 항목들. `client.storage_entries`에도 넣는다.
  - `client.device_storage.prefixes`: `["orig/"]`. `client.http_permissions`: Global Constraints의 네 개.
- [ ] **Step 2:** `upload_asset`으로 `dist/moodboard.js`를 올리고, `preview_app`을 실행해 warnings가 0인지 확인한다.
- [ ] **Step 3:** `upload_app`을 실행한 뒤 `get_workspace`로 창이 떴고 data_errors가 0인지 확인한다.
- [ ] **Step 4:** 사용자에게 같이 보기를 켜 달라고 부탁한다. 다음을 확인한다.
  - (사용자) PNG 하나와 MP4 하나를 끌어다 놓는다.
  - (에이전트, `act_window`) 유튜브 URL, `kr.pinterest.com/pin/…` URL, `pin.it` URL, 글을 넣는다.
  - [색으로 정렬]과 [내 배치]를 왕복한 뒤 수동 좌표가 그대로인지 확인한다. 그림 확인에는 `read_window image:true`를 쓴다.
  - 카드를 선택해 옆 칸이 바뀌는지 확인한다.
  - 창을 닫았다 다시 열어 보드가 그대로인지 확인한다.
- [ ] **Step 5: Commit** `git add app scripts && git commit -m "앱 정의와 실제 쉘 확인"`

### Task 8: 내보내기

**Files:**
- Create: `src/export.js`, `src/viewer/viewer.js`, `test/export.test.js`
- Modify: `package.json`의 build 스크립트. viewer를 따로 번들한 결과를 문자열로 `export.js`에 넣도록 `--loader:.viewer.js=text` 또는 빌드 스크립트 2단계로 바꾼다.

**Interfaces:**
- Consumes: `Board`, `ThumbStore`, `sortedLayout`, blob 존재 여부 `hasOrig(key)->Promise<boolean>`
- Produces:
  - `planExport(board, {thumbSizes: Map<id,bytes>, origSizes: Map<id,bytes|null>}) -> {estimate:number, level:'ok'|'warn'|'block', videos:{cardId, embed:boolean, reason?}[]}`
    - warn 기준은 50,000,000, block 기준은 95,000,000이다(바이트, 십진).
    - base64 팽창(×4/3)을 크기 추정에 포함한다.
    - 원본이 없는 영상은 `embed:false, reason:'원본 없음'`이다.
  - `buildExportChunks(board, plan, readers) -> AsyncIterable<Uint8Array>`
    - HTML 앞부분, 카드별 data URL, 뒷부분을 차례로 내보낸다.
    - 조각 하나는 4MiB를 넘지 않는다.
  - 뷰어 기능: 화면 이동과 확대·축소, [색으로 정렬]/[내 배치] 전환, 카드 클릭 시 크게 보기, 원본 링크(`target=_blank`).
    - 외부 요청은 0개이다.

- [ ] **Step 1: 실패하는 테스트**
  - 썸네일 100KB 10장이면 ok이다. 재생 포함 영상 40MB 하나가 더해지면 warn(≈53MB)이다. 80MB 영상이면 block이다.
  - 원본이 없는 영상은 `embed:false`이다.
  - `buildExportChunks`를 끝까지 이어 붙인 결과는 다음을 만족한다.
    - `<!DOCTYPE html>`로 시작한다.
    - `http`로 시작하는 `src=`가 없다(외부 요청 0).
    - 모든 카드 id를 포함한다.
    - 모든 조각이 4MiB 이하이다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다. `export` 동작은 `planExport` 결과에 따라 진행한다.
  - block이면 `notice`에 막힌 이유와 재생 포함을 끌 영상 이름을 보인다.
  - warn이면 `exportInfo`에 크기를 보인다.
  - 그다음 `files.save_prompt({suggested_name:'<보드이름>.html', mime:'text/html'})`를 열고, offset을 누적하며 `files.write`, 마지막에 `files.close`를 부른다. 중간에 실패하면 `files.abort`를 부른다.
- [ ] **Step 4:** `npm test`를 실행해 PASS를 확인한다. 그다음 `npm run build`를 실행한다.
- [ ] **Step 5:** 쉘에서 내보내기를 실행한다(저장 창은 사용자가 조작). 결과 파일을 네트워크를 끈 브라우저에서 열어 다음을 확인한다: 썸네일 표시, 정렬 전환, 유튜브 링크 이동.
- [ ] **Step 6: Commit** `git commit -am "단일 HTML 내보내기"`

### Task 9: 두 번째 PC 확인과 마무리

- [ ] **Step 1:** 원격 서버에 연결된 두 번째 쉘에서 앱을 연다. 다음을 확인한다.
  - 보드와 썸네일이 보인다.
  - 이미지 크게 보기는 썸네일로 보인다.
  - MP4에는 `원본은 다른 PC에 있어요`가 보인다.
  - 이 PC에서 내보내기가 정지 장면으로 진행된다.
- [ ] **Step 2:** 두 PC에서 거의 동시에 카드를 하나씩 추가한 뒤, 양쪽 모두에 두 카드가 다 있는지 확인한다(Review Focus 3).
- [ ] **Step 3:** README에 사용법(넣기, 정렬, 내보내기, 원격 서버 연결 전제)을 적는다.
- [ ] **Step 4: Commit and push** `git commit -am "README와 다중 PC 확인" && git push`

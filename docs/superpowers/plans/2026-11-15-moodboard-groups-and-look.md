# 무드보드 2차 (묶음 상자 + 테마별 캔버스) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 캔버스에 묶음 상자를 추가하고, 쉘 라이트/다크 테마에 따라 A/B 스타일(각진 사진)로 다시 그린다.

**Architecture:** 기존 모듈 구조를 그대로 확장한다. 묶음 데이터는 `model.js`·`store.js`에, 조작은 순수 상태 기계 `interaction.js`에, 모양 값은 새 `theme.js` 한 곳에 두고 `render.js`와 내보내기 뷰어가 함께 쓴다.

**Tech Stack:** 기존과 같다(바닐라 ES 모듈, esbuild, `node --test`, kaleidoscope client).

**Spec:** `docs/superpowers/specs/2026-11-15-moodboard-groups-and-look-design.md` (1차: `2026-11-14-moodboard-design.md`)

## Global Constraints

- 테스트는 `npm test`(= `node --test 'test/**/*.test.js'`), 빌드는 `npm run build`(2단계: 뷰어 → main)이다. 앱 정의는 `node scripts/gen-app.mjs <자산판>`으로 만든다. 새 파일은 `git add`로 직접 추가한다(`commit -am`은 새 파일을 빠뜨린다).
- client 출력·동작 이름은 소문자·숫자·`_`만 쓴다. 저장 스키마는 엄격하므로, 새 필드는 `scripts/gen-app.mjs`의 cardSchema와 boardSchema에 모두 적는다.
- Group: `{id, name, rect:{x,y,w,h}, collapsed:boolean, updatedAt:number, deleted?:true}`. 새 묶음은 이름 `새 묶음`, 크기 400×300이고 화면 가운데에 놓는다. 최소 크기는 160×100이다.
- Card에는 `groupId?: string`을 추가한다.
- 묶음 제목줄의 높이는 화면 28px이다. 접기 단추(▾/▸)는 제목줄 왼쪽 24px 칸이다.
- 둥근 모서리는 어디에도 쓰지 않는다(`roundRect`·`arcTo` 제거).
- 디자인 토큰 값은 spec 4장 표의 값을 그대로 쓴다.
- 테마 판별은 `matchMedia('(prefers-color-scheme: dark)')`로 하고 `change` 이벤트로 다시 그린다. 판별 결과는 state 키 `theme`(`'light'|'dark'`)에도 써서 `get_workspace`로 확인할 수 있게 한다.

## Review Focus

1. **접힌 묶음 안의 카드**: 보이지 않으므로 누르거나 선택할 수 없고, 색 정렬 모드에서만 다시 보인다. → Task 2 `hitTest 접힌 묶음` 테스트.
2. **다른 PC가 지운 묶음**: 그 묶음을 가리키는 카드는 묶음 없는 카드로 그리고, 화면에서 사라지지 않는다. → Task 1 `orphan groupId` 테스트.
3. **groups 필드가 없는 기존 보드 문서**: 오류 없이 빈 묶음으로 읽힌다. → Task 1 `legacy doc` 테스트.
4. **겹친 묶음 위에 카드를 놓을 때**: 위에 그려진(배열 끝) 묶음에 들어간다. → Task 2 `겹친 묶음` 테스트.
5. **정렬 모드에서 묶음을 끌 때**: 묶음 좌표는 그대로이고 `내 배치로 바꾸면 옮길 수 있어요` 알림이 뜬다. → Task 2 `정렬 중 묶음 끌기` 테스트.

---

### Task 1: 묶음 데이터, 병합, 저장 스키마

**Files:**
- Modify: `src/model.js`, `src/store.js`, `scripts/gen-app.mjs`
- Test: `test/model.test.js`(새 파일), `test/store.test.js`

**Interfaces:**
- Produces:
  - `newGroup({name?, rect}, now = Date.now) -> Group`: id는 `crypto.randomUUID()`, `collapsed:false`.
  - `liveGroups(board) -> Group[]`: deleted를 뺀 묶음.
  - `effectiveGroupId(board, card) -> string|null`: 살아 있는 묶음을 가리킬 때만 id를 돌려주고, 아니면 null.
  - `mergeBoards`: `board.groups`도 카드와 같은 규칙(id별 updatedAt이 큰 쪽, 같으면 묘비)으로 합친다. `pruneTombstones`는 묶음 묘비도 정리한다.

- [ ] **Step 1: 실패하는 테스트**
  - `legacy doc`: groups가 없는 보드끼리 `mergeBoards`를 해도 오류가 없고, 결과의 `groups`는 `[]`이다.
  - 양쪽 PC가 서로 다른 묶음을 추가했으면 둘 다 남는다. 같은 묶음을 옮겼으면 updatedAt이 큰 쪽 rect가 남는다. 한쪽이 지웠으면 묘비가 이긴다.
  - `orphan groupId`: 지워진 묶음을 가리키는 카드에서 `effectiveGroupId`는 null이다.
  - `pruneTombstones`는 30일 지난 묶음 묘비를 지운다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다. 그다음 `gen-app.mjs`에 groupSchema(위 Group 필드)와 cardSchema의 `groupId`(string)를 추가하고, `node scripts/gen-app.mjs 6`을 실행한다.
- [ ] **Step 4:** `npm test` PASS를 확인한다.
- [ ] **Step 5: Commit** `묶음 데이터와 병합`

### Task 2: 묶음 조작 (상태 기계)

**Files:**
- Modify: `src/interaction.js`, `src/layout.js`
- Test: `test/interaction.test.js`, `test/layout.test.js`

**Interfaces:**
- Consumes: Task 1의 Group 모양
- Produces:
  - `state.groups: Group[]`(initialState에서 `[]`)
  - `hitTestGroup(groups, worldPoint, scale) -> {group, zone:'toggle'|'title'|'resize'|'body'}|null`
    - 위쪽부터 검사한다.
    - 제목줄은 rect 위쪽 `28/scale` 높이이고, 그 안에서 왼쪽 `24/scale`은 toggle이다.
    - 오른쪽 아래 `12/scale` 칸은 resize이다.
    - 접힌 묶음은 제목줄만 맞는다.
  - `memberOf(groups, rect) -> groupId|null`: 카드 중심이 들어가는 묶음 중 배열 끝(위) 것. 접힌 묶음은 제외한다.
  - `visibleCards(state) -> Card[]`: 수동 모드에서는 접힌 묶음의 카드를 뺀다. 정렬 모드에서는 모두 보인다.
  - 새 effects:
    - `{type:'group_moved', groupId, rect, cards:[{cardId, rect}]}`
    - `{type:'group_resized', groupId, rect}`
    - `{type:'group_toggled', groupId}`
    - `{type:'membership', cardId, groupId|null}`: 카드 `moved`와 함께 나간다.
    - `{type:'select', cardId:null, groupId}`
  - 정렬 모드에서는 묶음이 보이지 않으므로 hitTest 대상에서 뺀다.
  - 카드 히트가 묶음 히트보다 먼저다(카드가 위에 그려지므로).

- [ ] **Step 1: 실패하는 테스트**
  - 제목줄을 끌면 `group_moved`가 나오고, 멤버 카드 두 장의 rect가 같은 dx·dy로 움직인다. 멤버가 아닌 카드는 들어가지 않는다.
  - 모서리를 끌면 `group_resized`가 나오고 w·h는 최소 160×100이다.
  - toggle을 클릭하면 `group_toggled`가 나온다.
  - 묶음 몸통을 클릭하면 `select {groupId}`가 나온다.
  - 묶음 몸통을 끌면 화면을 이동한다(pan).
  - 카드를 묶음 안에 놓으면 `membership {groupId}`, 밖에 놓으면 `membership {groupId:null}`이 나온다.
  - `겹친 묶음`: 두 묶음이 겹친 자리에 놓으면 배열 끝 묶음의 id가 들어간다.
  - `hitTest 접힌 묶음`: 접힌 묶음 안 자리를 누르면 카드가 맞지 않고, `visibleCards`에도 그 카드가 없다.
  - `정렬 중 묶음 끌기`: `group_moved`가 없고 notice 문구가 정확히 `내 배치로 바꾸면 옮길 수 있어요`이다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `npm test` PASS를 확인한다.
- [ ] **Step 5: Commit** `묶음 조작`

### Task 3: 테마 토큰과 캔버스 다시 그리기

**Files:**
- Create: `src/theme.js`, `test/theme.test.js`
- Modify: `src/render.js`, `src/main.js`, `src/platform/kaleidoscope.js`, `scripts/gen-app.mjs`(state_keys에 `theme`)

**Interfaces:**
- Consumes: `visibleCards`, `state.groups`, `effectiveGroupId`
- Produces:
  - `THEMES = {light, dark}`: spec 4장 표의 값. 키는 `bg, grid|null, mat:{pad, bottom}|null, shadow:[{blur, y, color}], captionFont, captionColor, badgeBg, badgeInk, textBg, textInk, textFont, textAccentBar:boolean, groupFill, groupLine, groupLabelFont, groupLabelInk, groupLabelUpper:boolean, groupDot:boolean, selectLine`.
  - `themeName(isDark: boolean) -> 'light'|'dark'`
  - `groupDotColor(cards: Card[]) -> '#rrggbb'`: 채도가 있는 카드들의 hue 중앙값을 HSL(h, 0.55, 0.55)로 바꾼 값이다. 채도 있는 카드가 없으면 `#9e9e9e`.
  - `createRenderer({scene, thumbB64, theme: () => Theme})`: scene에 `groups`를 추가한다.

- [ ] **Step 1: 실패하는 테스트**
  - `THEMES.light.bg === '#f4f1ec'`, `THEMES.dark.bg === '#141416'`, `THEMES.dark.grid`는 18px 점 격자, `THEMES.light.mat`는 `{pad:6, bottom:22}`이다.
  - `groupDotColor`는 빨강·주황 카드로는 hue 0~40°, 회색만 있으면 `#9e9e9e`, 빈 배열도 `#9e9e9e`를 돌려준다.
  - `themeName(true) === 'dark'`
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** `theme.js`를 구현하고 `render.js`를 고친다.
  - 묶음 → 카드 → 선택선 순으로 그린다. 모든 사각형은 각지게 그리고 `roundRect`를 지운다.
  - 라이트에서 사진 카드는 흰 매트와 매트 아래 캡션(youtube/pinterest/image/video), 그림자 2겹으로 그린다.
  - 다크에서 사진 카드는 여백 없이 꽉 채운다.
  - 글 카드는 테마 토큰대로, 다크에서는 왼쪽 3px 색 띠를 그린다.
  - 묶음 이름은 상자 위쪽 바깥에 쓴다. 라이트는 대문자 세리프, 다크는 시스템 글꼴과 색 점이다.
  - 접힌 묶음은 제목줄과 `▸ 이름 · N장`만 그린다.
- [ ] **Step 4:** `main.js`에서 matchMedia를 구독한다. 바뀌면 다시 그리고 `setState('theme', name)`을 쓴다.
- [ ] **Step 5:** `npm test`와 `npm run build`가 PASS하는지 확인한다.
- [ ] **Step 6: Commit** `테마별 캔버스 디자인`

### Task 4: 묶음 UI 연결과 내보내기

**Files:**
- Modify: `src/main.js`, `src/panel.js`, `scripts/gen-app.mjs`, `src/export.js`, `src/viewer/viewer.js`
- Test: `test/panel.test.js`, `test/export.test.js`

**Interfaces:**
- Consumes: Task 2의 effects, Task 3의 `THEMES`·`groupDotColor`
- Produces:
  - client 동작:
    - `group_add`: 툴바 [묶음 추가] 단추. [파일 추가] 바로 뒤에 둔다.
    - `group_rename`: 옆 칸의 이름 입력. state 키 `group_name`, commit submit.
    - `group_delete`: 옆 칸 [묶음 삭제], danger. 묶음은 묘비로 남기고, 멤버 카드는 `groupId`를 지운 뒤 updatedAt을 갱신한다.
  - 출력:
    - `group_selected`: `{id, name, count}|null`
    - `has_group_selected`: boolean
  - 옆 칸: 묶음을 선택하면 카드 상세 대신 묶음 이름 입력, 카드 수, [묶음 삭제]가 보인다.
  - effects 저장: `group_moved`는 묶음과 멤버 카드를 한 번에 저장한다. 나머지는 해당 객체의 updatedAt을 갱신하고 기존 400ms 디바운스로 저장한다.
  - 내보내기:
    - HTML의 board JSON에 살아 있는 `groups`가 들어간다.
    - 뷰어는 `THEMES`를 함께 묶어 `prefers-color-scheme`으로 고른다.
    - 접힌 묶음의 카드는 수동 배치에서 숨긴다.

- [ ] **Step 1: 실패하는 테스트**
  - `panelOutputs`는 묶음을 선택하면 `group_selected`의 name과 count가 맞고, 카드 쪽 출력은 비어 있다.
  - 내보낸 HTML의 board JSON에 묶음이 있고, 지운 묶음은 없다.
  - 뷰어 번들에 `#f4f1ec`와 `#141416`이 모두 들어 있다.
  - 내보낸 HTML에 `roundRect`와 `border-radius`가 없다.
- [ ] **Step 2:** `npm test`를 실행해 FAIL을 확인한다.
- [ ] **Step 3:** 구현한다. 그다음 `node scripts/gen-app.mjs 6`을 다시 실행한다.
- [ ] **Step 4:** `npm test`와 `npm run build`가 PASS하는지 확인한다.
- [ ] **Step 5: Commit** `묶음 UI와 내보내기`

### Task 5: 올리고 실제 쉘에서 확인

- [ ] **Step 1:** `scripts/upload.md` 순서로 자산 6판과 앱을 올린다. base64는 Read로 정확히 옮긴다.
- [ ] **Step 2:** `get_workspace`로 창이 새 판이고 state `theme`가 지금 쉘 테마와 맞는지 확인한다. 사용자에게 쉘 테마를 라이트·다크로 바꿔 달라고 하고, 그때마다 `theme` 값이 바뀌는지 본다. 바뀌지 않으면 spec 5장의 대안으로 가며 사용자에게 알린다.
- [ ] **Step 3:** 사용자에게 같이 보기를 부탁한다. 다음을 `read_window image:true`로 확인한다: 묶음 추가·이동·접기, 카드 넣고 빼기, 두 테마의 모양, 사진 모서리가 각진지.
- [ ] **Step 4: Commit and push**

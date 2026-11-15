# 무드보드 3차: 색 설정, 캡션 정리, sandbox 보드

작성일 2026-11-15 · 사용자 요청과 위임("알아서 개선점 찾아서 수정")

## 사용자 요청
1. `image` 캡션을 뺀다. youtube, pinterest, video 캡션은 남긴다.
2. 배경색과 메모지(글 카드) 색을 사용자가 정할 수 있게 한다.
3. 노트북 터치패드만으로 확대·축소가 되게 한다.
4. 검은 테두리를 없앤다. kaleidoscope 쉘 PR 없이 해결한다.

## 결정 (에이전트 판단, 사용자 위임)
### A. 색 설정과 캡션 (먼저)
- 보드 배경
  - `Board.bg?: '#rrggbb'`를 둔다. 없으면 테마 bg를 쓴다.
  - 툴바에 `color` 블록 [배경]을 둔다. 바꾸면 보드에 저장된다.
  - [기본값]을 고르면 `bg` 키를 지운다.
  - 점 격자 색은 bg의 밝기에 맞춰 대비가 약하게 계산한다(밝은 bg는 검정 8%, 어두운 bg는 흰색 10%).
- 메모지 색
  - 글 카드에 `paper?: '#rrggbb'`를 둔다. 없으면 테마 textBg를 쓴다.
  - 옆 칸에 [종이 색] color를 둔다. 기존 색 점([색], 정렬용 `color`)은 그대로 둔다.
  - 글자색은 종이 밝기에 따라 자동으로 정한다(어두우면 밝은 글자).
- 캡션: kind가 `image`인 카드는 캡션을 쓰지 않는다. 매트 아래 여백도 위아래 같은 4px로 둔다.
- 내보낸 페이지에도 bg와 paper를 그대로 반영한다.

### B. sandbox 보드 (다음)
- 까닭: canvas 블록은 wheel이나 집기를 받지 않고, 쉘 테두리(반투명 1px 아래 #302a36)를 앱이 덮을 수 없다. sandbox는 테두리가 없고 바탕이 surface-solid이며 보통 iframe이라 wheel, gesture, 키보드, 붙여넣기를 받는다. EQ 앱이 같은 방식을 쓴다.
- 확인됨(spike `moodboard-spike2`)
  - sandbox에서 storage 읽기와 쓰기가 된다.
  - client의 `setState`가 sandbox에 도착한다.
  - wheel과 집기는 사용자 확인 대기 중이다.
- 나눔
  - sandbox(html 자산 `moodboard-board`)는 보드 그리기와 조작을 맡는다. 끌기, 크기 조절, 묶음, wheel 이동, ctrl+wheel과 gesture 확대, 키보드(Delete, Esc), ⌘V 붙여넣기다.
  - sandbox는 storage `boards`와 `thumbs_*`를 직접 읽고, 보드를 바꿀 때 `boards`에 쓴다(saveWithRetry).
  - client는 파일 넣기(file_drop), 링크 가져오기(http), blobs, 옆 칸 출력, 내보내기를 맡는다.
- 주고받는 state
  - `selected` {kind:'card'|'group', id}|null: sandbox가 쓴다.
  - `view` {cx, cy, scale}: sandbox가 쓴다. client가 새 카드를 놓을 자리를 정할 때 쓴다.
  - `mode` 'manual'|'sorted': 툴바 set_state로 바뀐다.
  - `cmd` {op:'zoom_in'|'zoom_out'|'fit', n}: 툴바가 쓰고 sandbox가 n이 바뀌면 실행한다.
  - `paste_inbox` {text, n}: sandbox가 쓰고 client가 ingestText를 돌린다.
- 자산 크기: client와 board html을 각각 따로 올린다. 각 업로드의 base64가 30,000자를 넘지 않게 한다(넘으면 빌드 실패).
- 확대·축소 버튼과 [맞춤]은 남긴다.

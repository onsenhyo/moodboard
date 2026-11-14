# 플랫폼 확인 결과 (Task 1 스파이크)

2026-11-14, macOS 쉘 1대(로컬 서버, `Seung의 노트북`)에서 시험 앱 `moodboard-spike`(3판)를 띄워 확인했다.
client가 결과를 창 상태(`probe`)에 올리고 `get_workspace`로 읽었다. 시험 앱은 확인 뒤 `delete_app`으로 지웠다.

## 결론 요약

| 항목 | 결과 |
|---|---|
| client에서 모음(collection) 문서 읽기·쓰기 | **불가.** 브리지에 doc 인자가 없다 |
| 썸네일 저장 방식 | **고정 항목 묶음 `thumbs_00`~`thumbs_31`** |
| storage 항목 한도 | 직렬화한 JSON **1,048,576바이트까지 성공, 1,048,577바이트부터 거부** |
| MP4(H.264) 장면 잡기 | blob URL → `<video>` → seek → OffscreenCanvas `drawImage` → `getImageData` **됨** |
| HEVC | 받은 표본(`hev1` 태그)은 재생 실패. `hvc1`은 `canPlayType`이 "probably" |
| `pin_img` 권한 `paths: ["/"]` | **`/`는 루트만 허용.** `/736x/…`는 거부된다. 접두 경로를 나열해야 한다 |
| canvas `on_pointer` | `{ event: { phase, pointer_id, x, y, buttons, shift, alt, ctrl, meta } }`, x·y는 0~1 |

## 1. 모음 문서를 client에서 쓸 수 있는가 — 아니오

- 소스: `ui/src/blocks/sandbox-frame.ts`의 `getStorage(entry)`, `setStorage(entry, content)`는 doc 인자가 없다.
  `ui/src/runtime/client-runtime.ts`는 `storage.get`/`storage.write`를 `{ window_id, entry, content, expected_revision }`로만 부른다. doc을 넘기는 경로가 없다.
- 실행: 모음 항목(`collection: true`, md)을 `storage_entries`에 넣고 불렀다.
  - `setStorage('thumbs_col', '…')`, `getStorage('thumbs_col')`, 세 번째 인자를 준 `setStorage('thumbs_col', '…', 'card1')` 모두 같은 오류로 실패했다.
  - `{ id: "STORAGE_DOCUMENT_NAME_REQUIRED", code: "invalid_request", message: "저장 문서 이름이 필요합니다. …" }`
- 모음 문서는 블록(`markdown`/`html_view`의 `document`, `set_storage` 동작의 `doc`)으로만 다룰 수 있다. client는 쓸 수 없다.

## 2. 고정 JSON 항목 크기 한도

- `setStorage('thumbs_00', { tag, data: 900KiB 문자열 })` 성공. `getStorage`로 다시 읽어 길이 921,600을 확인했다.
  `read_app_storage`로도 서버에 같은 값(921,600자, revision 있음)이 있음을 확인했다.
- 1.1MiB 값은 거부된다. 경계는 `JSON.stringify` 결과 바이트 수 기준이다.
  - `{"d":"S…"}` 전체 1,048,576바이트: 성공
  - 1,048,577바이트: 거부
- 거부 오류(client에서 받은 그대로):
  ```
  Error { message: "저장 항목 spike/thumbs_01의 JSON 값이 허용 크기 1MB보다 큽니다. 값을 줄인 뒤 다시 저장하세요.",
          id: "STORAGE_WRITE_JSON_TOO_LARGE", code: "invalid_request" }
  ```
- 다른 PC에서 `getStorage`로 같은 값이 보이는지는 **확인하지 못했다**(두 번째 기기 없음). 서버에 값이 올라간 것만 확인했다. 실제 여러 PC 동기화 확인은 Task 9로 미룬다.

### 스키마 함정 (Task 4가 꼭 알아야 함)

- `schema: { "type": "object" }`만 두면 **모든 필드가 "선언되지 않은 필드"로 거부된다**(`STORAGE_WRITE_SCHEMA_MISMATCH`).
- `additionalProperties: true`는 앱 올리기에서 거부된다("false 또는 값 스키마여야 합니다").
- 키가 늘어나는 맵은 `additionalProperties`에 값 스키마를 준다. 예: 썸네일 묶음 `{ "type": "object", "additionalProperties": { "type": "string" } }`.
  이 스키마에서는 값이 문자열이 아니면 거부된다(`/at는 글 형식이어야 합니다`).
- 안쪽 객체도 똑같이 엄격하다. `additionalProperties: { "type": ["object", …] }` 아래의 객체에 필드가 있으면 거부됐다.
  중첩 객체를 넣으려면 그 안쪽 모양도 `properties`나 `additionalProperties`로 선언해야 한다.

### 충돌(CAS) 오류 모양

순서: client가 `cas`에 씀 → MCP `write_app_storage`로 바깥에서 고쳐 씀 → client가 다시 씀.

```
Error { message: "저장 항목 spike/cas: 읽은 뒤 값이 바뀌었습니다. 값을 다시 읽고 변경 내용을 적용하세요.",
        id: "STORAGE_ITEM_WRITE_CONFLICT", code: "conflict" }
```

- 서버가 오류 코드를 주지 않으면 `STORAGE_SERVER_WRITE_CONFLICT`가 올 수 있다(`crates/contract/src/errors/storage.rs`). 두 경우 모두 `code`는 `"conflict"`다.
- 권장 판별: `isConflict = err => err?.code === 'conflict' || /WRITE_CONFLICT$/.test(err?.id ?? '')`
- **충돌은 저절로 풀리지 않는다.** 충돌 뒤 다시 `setStorage`해도 같은 충돌이 났다(`cas_c`). client-runtime이 마지막으로 아는 revision을 그대로 쓰기 때문이다.
  `getStorage`로 다시 읽으면 revision이 갱신되고 그다음 쓰기는 성공했다(`cas_d`).
- 바깥 변경을 받으려면 `onStorageChange(entry, listener)`를 건다. 리스너가 `false`를 돌려주지 않으면 쉘이 새 revision을 받아들인다(`ks-sandbox-storage-applied`).
  리스너가 없으면 revision이 낡은 채로 남고 다음 쓰기가 충돌한다.
- 충돌 처리 순서: `getStorage` → 변경 다시 적용 → `setStorage`.

## 3. MP4 장면 잡기

- 표본: `https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4`(991,017바이트, 640×360, 10초).
  리다이렉트 없이 `http.read`로 받았다(리다이렉트는 거부되므로 받은 것 자체가 확인이다). `mime: "video/mp4"`, 응답 키는 `bytes`, `mime`.
- `new Blob([bytes], {type})` → `URL.createObjectURL` → `<video muted playsInline preload=auto>` → `loadedmetadata` → `currentTime = t` → `seeked`
  → `requestVideoFrameCallback`(최대 500ms) → `OffscreenCanvas(640,360).drawImage(video)` → `getImageData`가 됐다.
- 평균 픽셀: t=1s `[99,114,62]`, t=3s `[100,115,61]`, t=5s `[99,114,60]`(readyState 4). 640×360 JPEG(품질 0.8)는 101,645바이트였다.
- **함정:** 2판 시험에서 `seeked` 직후 바로 `drawImage`했을 때는 평균이 `[0,0,0]`(빈 장면)이었다. `seeked` 뒤 `requestVideoFrameCallback`을 기다려야 한다.
- HEVC: 같은 사이트의 h265 표본은 `video error 4`(MEDIA_ERR_SRC_NOT_SUPPORTED)로 실패했다. 이 표본은 `hev1` 태그다.
  이 WebView의 `canPlayType`은 `hev1`에 `""`, `hvc1`에 `"probably"`라 답했다. `hvc1` 표본(아이폰 촬영본과 같은 형식)은 구하지 못해 확인하지 않았다.
  앱은 `video.error`가 나면 "이 영상은 미리보기를 만들 수 없음" 카드로 처리해야 한다.
- `file_drop`으로 받는 경로는 사용자 조작이 필요해 이번에는 확인하지 않았다. 파일을 받은 뒤의 blob→video→canvas 경로는 위와 같다.

## 4. 핀터레스트

- `https://www.pinterest.com` `/oembed.json?url=https://www.pinterest.com/pin/<id>/` 응답에서 `thumbnail_url`을 받았다
  (`https://i.pinimg.com/236x/a7/66/56/….jpg`).
- `paths: ["/originals/","/1200x/","/736x/","/564x/","/474x/","/236x/"]` 권한으로:
  - `/236x/…jpg`: 성공(8,427바이트, 236×176)
  - `/236x/`를 `/736x/`로 바꾼 경로: 성공(57,460바이트, 640×478, 원본이 736보다 작으면 원본 크기로 온다)
- `paths: ["/"]` 권한으로 같은 `/736x/…` 요청: 거부.
  ```
  Error { message: "공개 HTTPS 경로 /736x/…jpg의 내용을 읽지 못했습니다. 주소와 네트워크를 확인하세요.",
          id: "DATA_CLIENT_HTTP_READ_FAILED", code: "server",
          details: ["허용하지 않은 공개 HTTPS 주소 또는 경로입니다", "호스트: i.pinimg.com"] }
  ```
  소스(`crates/contract/src/validate.rs` `allowed_public_http_path`): `allowed.len() > 1 && allowed.ends_with('/')`일 때만 접두 일치라서 `"/"`는 루트 자체만 허용한다.
- **설계 수정:** 설계서 4절의 "`https://i.pinimg.com/`의 `/` 아래 경로"는 위 접두 경로 목록으로 바꾼다. 유튜브 `i.ytimg.com`도 `/vi/`처럼 접두 경로로 선언한다.

## 5. canvas 포인터 이벤트

- client 동작 인자: `{ event: { phase, pointer_id, x, y, buttons, shift, alt, ctrl, meta } }` (`arg.event`로 읽는다, 인자 키는 `event` 하나).
- `phase`: `"down" | "move" | "up" | "cancel"` (`ui/src/blocks/canvas.tsx`).
- `x`, `y`: 그려진 canvas 영역 기준 **0~1로 정규화**하고 0~1로 자른 값. 픽셀로 쓰려면 `x * surface.cssWidth`(또는 canvas 폭)를 곱한다.
- `buttons`: `PointerEvent.buttons`. 누르지 않은 채 움직여도 `move`가 온다(실측 `buttons: 0`). 끌기 판정은 `buttons & 1` 또는 down~up 사이로 한다.
- `down`은 그려진 영역 안에서만 오고 그때 포인터를 잡는다(capture). 그래서 영역 밖으로 끌어도 `move`/`up`이 이어진다.
- `move`는 프레임마다 하나로 합쳐 보낸다(requestAnimationFrame). `down`/`up`은 합치지 않는다.
- 휠, 키보드, 확대 제스처 필드는 없다.
- surface 객체 키: `id, generation, canvas, cssWidth, cssHeight, dpr, visible, resize`.

## 6. 썸네일 저장 결정

**결정: 고정 JSON 항목 `thumbs_00`~`thumbs_31` 묶음 방식.** (모음 문서는 client에서 쓸 수 없음)

- 항목 선언: `kind: json`, `schema: { "type": "object", "additionalProperties": { "type": "string" } }`, 값은 `{ "<cardId>": "<base64 JPEG>" }`.
- 카드 → 묶음: 카드 id의 해시 % 32 등으로 고정 배정하고, 넣을 때 그 묶음이 1MiB를 넘으면 빈 자리가 있는 다른 묶음으로 옮긴다.
- 용량: 항목당 1,048,576바이트 × 32 = 32MiB(base64 기준). base64는 원본의 4/3이므로 JPEG로는 약 24MiB다.
  - 카드당 base64 ~100KB(JPEG ~75KB): 묶음당 ~10장, **보드 전체 약 300장**
  - 640×360 품질 0.8 JPEG가 ~100KB였으므로, 긴 변 800px 대신 **긴 변 480~600px, 품질 0.7 안팎**에서 시작해 base64 100KB 이하를 목표로 한다.
- 이 32개 항목은 앱 하나(계정)에 걸려 있으므로 보드가 여럿이어도 전체 카드 합이 약 300장이다. 보드마다 나누려면 key에 `{workspace_id}` 말고는 치환자가 없어 고정 항목을 더 선언해야 한다.
- 묶음 쓰기는 최대 1MiB 읽기-고치기-쓰기다. 충돌하면 위 2절 순서로 다시 읽고 적용한다.
- 이 용량 제한은 사용자 승인이 필요한 사항이다(컨트롤러가 보고).

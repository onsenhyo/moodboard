// kaleidoscope 앱스토어(eiaserinnys/kaleidoscope-appstore)에 올릴 앱 폴더를 만든다.
// 사용: npm run build && node scripts/gen-app.mjs 뒤에
//   node scripts/store.mjs <출력 폴더> [게시자 GitHub 로그인]
//   예: node scripts/store.mjs ../kaleidoscope-appstore/apps/moodboard
// 만드는 것: app.json(= app/moodboard.json), store.json, assets/<id>.javascript(dist의 .upload.js 원본 바이트),
//   assets/icon.svg. 출력 폴더의 assets/는 비우고 다시 쓴다.
// 스토어 정보나 자산이 바뀌면 RELEASE를 1 올린다(배포한 판은 고칠 수 없다).

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = 2;
const SOURCE = 'https://github.com/onsenhyo/moodboard (npm run build)';
const LICENSE = 'MIT';
const ICON_FILE = 'assets/icon.svg';

const [outArg, publisher = 'PUBLISHER_PLACEHOLDER'] = process.argv.slice(2);
if (!outArg) {
  console.error('사용: node scripts/store.mjs <출력 폴더> [게시자]');
  process.exit(1);
}
const OUT = resolve(outArg);

const app = JSON.parse(readFileSync(join(ROOT, 'app', 'moodboard.json'), 'utf8'));
const built = JSON.parse(readFileSync(join(ROOT, 'dist', 'assets.json'), 'utf8'));
if (!app.icon) throw new Error('app/moodboard.json에 icon이 없습니다');

const summary = '이미지, 영상, 링크, 글을 한 판에 모으고 색으로 정렬합니다';
const description = [
  '사진, 영상, 링크, 글을 한 보드에 모아 두는 무드보드입니다.',
  '',
  '- 사진(PNG, JPEG, WebP, AVIF, BMP, HEIC, GIF)과 MP4 영상을 Finder에서 보드 위로 끌어다 놓거나 파일 추가 단추로 넣습니다. 4MB 이하의 GIF는 보드에서 움직이고, 움직이지 못하면 까닭을 알려 줍니다',
  '- 입력칸에 유튜브나 핀터레스트 링크를 넣으면 제목과 썸네일이 붙은 카드가 되고, 다른 링크는 링크 카드로, 링크가 아닌 글은 글 카드로 들어갑니다. 붙여넣기(⌘V)로도 넣을 수 있습니다',
  '- 보드를 여러 개 만들고 이름을 바꾸거나 지울 수 있습니다',
  '- 카드를 묶음 상자에 모아 함께 옮깁니다. 묶음은 아무 곳이나 잡아 끌면 옮겨집니다',
  '- 「색으로 정렬」은 카드를 대표 색 순서로 늘어놓고, 「내 배치」는 직접 끌어 놓은 자리로 돌아갑니다',
  '- 마우스 휠로 확대하고 축소합니다. 터치패드는 두 손가락으로 이동하고 집어서 확대합니다. 빈 곳이나 스페이스를 누른 채 끌어도 화면이 옮겨집니다. 확대, 축소, 화면에 맞춤 단추도 있습니다',
  '- ⌘Z(Ctrl+Z)로 되돌리고 ⌘⇧Z(Ctrl+Y)로 다시 합니다. 옆 칸에서 고친 것도 함께 되돌립니다',
  '- 사진 카드를 원하는 부분만 보이게 자릅니다',
  '- 카드마다 이름과 메모(500자까지)를 붙입니다. 글 카드의 이름은 본문 위 제목으로 보입니다',
  '- 보드 배경색을 고르고, 글 카드에는 색(색으로 정렬할 때 쓰는 표시)과 종이 색을 고릅니다',
  '- 보드를 HTML 파일 하나로 내보냅니다. 받은 사람은 인터넷 없이 브라우저로 열어 봅니다. 영상은 카드마다 넣을지 고릅니다',
  '',
  '보드와 썸네일은 kaleidoscope 계정 저장소에 남아 같은 계정의 다른 PC에서도 보입니다. 원본 사진과 영상 파일은 넣은 PC에만 남습니다.',
  '',
  '네트워크: 유튜브와 핀터레스트 링크의 제목과 썸네일을 받으려고 youtube.com/oembed, i.ytimg.com, pinterest.com/oembed.json, i.pinimg.com에만 요청합니다. 유튜브 카드를 고르면 옆 칸에 유튜브 재생 화면(youtube.com/embed)을 띄웁니다. 그 밖의 주소에는 요청하지 않습니다.',
].join('\n');

const assets = [];
rmSync(join(OUT, 'assets'), { recursive: true, force: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });
for (const a of built) {
  if (a.format !== 'javascript') throw new Error(`${a.id}: javascript가 아닌 빌드 자산은 다루지 않습니다`);
  const file = `assets/${a.id}.javascript`;
  copyFileSync(join(ROOT, a.file), join(OUT, file));
  assets.push({ id: a.id, version: a.version, file, format: a.format, source: SOURCE, license: LICENSE });
}
copyFileSync(join(ROOT, ICON_FILE), join(OUT, ICON_FILE));
assets.push({
  id: app.icon.asset, version: app.icon.version, file: ICON_FILE, format: 'svg',
  source: '직접 그림(스토어 아이콘 틀)', license: LICENSE,
});

// app.json의 자산 선언과 store.json의 자산이 같은지 여기서도 본다(스토어 검사 tools/check.mjs와 같은 조건).
const key = (a) => `${a.id}@${a.version}`;
const want = app.assets.map(key).sort().join(',');
const have = assets.map(key).sort().join(',');
if (want !== have) throw new Error(`app.json 자산(${want})과 스토어 자산(${have})이 다릅니다`);
if (description.length > 4000) throw new Error(`description이 ${description.length}자입니다(4000자까지)`);

const store = {
  summary, description, category: '디자인', publisher, release: RELEASE, listed: true, icon: ICON_FILE, assets,
};
writeFileSync(join(OUT, 'app.json'), JSON.stringify(app, null, 2) + '\n');
writeFileSync(join(OUT, 'store.json'), JSON.stringify(store, null, 2) + '\n');
console.log(`${OUT}: 자산 ${assets.map(key).join(', ')}, release ${RELEASE}, 게시자 ${publisher}`);

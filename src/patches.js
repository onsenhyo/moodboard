// 보드 편집을 패치로 쌓아 저장한다. client(main.js)와 sandbox 보드(board/board.js)가 함께 쓴다.
//
// 두 프레임이 같은 boards 항목을 쓴다. 한 프레임이 가진 사본은 다른 프레임이 쓴 뒤 잠시 낡으므로
// 사본 전체를 쓰면(레코드 단위 병합) 다른 프레임이 고친 필드를 되돌린다. 그래서 프레임은 자기 사본을 쓰지 않고,
// 고친 필드만 패치로 줄 세웠다가 저장할 때마다 새로 읽은 값 위에 다시 적용한다.
//
// patch = {kind:'card'|'group'|'board', id, boardId(card·group), fields?, deleteKeys?, insert?, t}
// - fields는 덮어쓸 필드, deleteKeys는 지울 키(저장 스키마가 null을 받지 않는 groupId, paper, bg).
// - insert는 없을 때 넣을 새 객체(새 카드, 묶음, 보드). 이미 있으면 fields만 적용한다.
// - 대상이 없고 insert도 없으면(다른 쪽이 걷어낸 묘비 등) 건너뛴다.
// - updatedAt은 max(지금 값, t)로 올린다. 같은 패치를 두 번 적용해도 결과가 같다.
//
// createDocEditor({adapter, entry, tries, now}) -> editor
// - doc: 마지막으로 받은 저장 값 위에 아직 저장하지 않은 패치를 적용한 화면용 문서.
// - edit(patch|patch[]): 화면용 문서에 바로 적용하고 줄에 넣는다. 바로 앞 패치와 대상이 같으면 하나로 합친다.
// - receive(value): 저장 값(시작 읽기, 다른 프레임이나 PC의 변경)을 받는다.
//   저장하는 동안 받은 값은 저장이 끝난 뒤에도 버리지 않는다(쓴 값과 레코드마다 updatedAt으로 합친다).
// - save(): saveWithRetry로 새로 읽은 값에 줄의 패치를 적용해 쓴다. 충돌하면 다시 읽고 같은 패치를 다시 적용한다.
//   쓰기 전에 직렬화 크기(UTF-8 JSON)를 limit(기본 1MiB, 저장 항목 한도)와 잰다. 넘으면 넘게 만든 패치만 빼고
//   나머지를 쓴다. 저장소가 받지 않는 값(invalid_request: 스키마, 크기)이면 패치를 하나씩 나눠 써서 걸린 것만 버린다.
//   버린 패치는 줄에서 빠지고(다음 저장을 막지 않는다), 쓴 뒤 {code:'too_large'|'invalid', dropped, message}를 던진다.
//   그 밖의 실패(server 등 잠깐의 실패)는 패치를 줄에 남기고 그대로 던진다.
// - writeNow(): 읽기 없이 마지막으로 받은 값에 패치를 적용해 바로 setStorage한다(창을 닫을 때 첫 시도). 크기는 같게 잰다.
// - pending: 아직 저장하지 않은 패치 수.
// cardTextPatch(boardId, id, field, value, max) -> 카드 label·memo 패치(빈 값이면 키 지우기).
// clipText(value, max) -> 글자(code point) max개까지. 글 카드 본문처럼 공백을 그대로 두는 글에 쓴다.
// fitPatches(doc, patches, {limit, now}) -> {doc, kept, dropped}: doc에 패치를 차례로 얹되 한도를 넘게 만드는 것은 뺀다.

import { BOARDS_ENTRY, saveWithRetry, pruneTombstones, mergeBoards, jsonBytes } from './store.js';

// 저장 항목 하나의 한도(쉘 STORAGE_JSON_MAX_BYTES). 쉘은 직렬화한 JSON의 바이트 수로 잰다.
export const DOC_MAX_BYTES = 1_048_576;
// 카드 이름(label)과 글 카드 본문(text)의 글자(code point) 수 한도. memo는 MEMO_MAX.
export const LABEL_MAX = 100;
export const TEXT_MAX = 20_000;

// 카드 글 필드 하나(label, memo)를 고치는 패치. 앞뒤 공백을 지운 값이 비면 키를 지운다(스키마는 null을 받지 않는다).
// max가 있으면 글자(code point) 수를 그만큼으로 자른다.
export const MEMO_MAX = 500;
export const clipText = (value, max = Infinity) => [...String(value ?? '')].slice(0, max).join('');
export function cardTextPatch(boardId, id, field, value, max = Infinity) {
  const v = clipText(String(value ?? '').trim(), max).trim();
  return v ? { kind: 'card', boardId, id, fields: { [field]: v } } : { kind: 'card', boardId, id, deleteKeys: [field] };
}

const emptyDoc = () => ({ version: 1, boards: [] });
const normDoc = (d) => (d && typeof d === 'object' && Array.isArray(d.boards) ? d : emptyDoc());

export function applyPatch(doc, p) {
  if (!p || !doc) return doc;
  let target;
  if (p.kind === 'board') {
    target = doc.boards.find((b) => b && b.id === p.id);
    if (!target) {
      if (!p.insert) return doc;
      target = structuredClone(p.insert);
      doc.boards.push(target);
    }
  } else if (p.kind === 'card' || p.kind === 'group') {
    const b = doc.boards.find((x) => x && x.id === p.boardId);
    if (!b) return doc;
    const key = p.kind === 'card' ? 'cards' : 'groups';
    if (!Array.isArray(b[key])) b[key] = [];
    target = b[key].find((x) => x && x.id === p.id);
    if (!target) {
      if (!p.insert) return doc;
      target = structuredClone(p.insert);
      b[key].push(target);
    }
  } else {
    return doc;
  }
  if (p.fields) Object.assign(target, structuredClone(p.fields));
  for (const k of p.deleteKeys ?? []) delete target[k];
  if (Number.isFinite(p.t)) target.updatedAt = Math.max(target.updatedAt ?? 0, p.t);
  return doc;
}

export function applyPatches(doc, patches) {
  const d = normDoc(doc);
  for (const p of patches) applyPatch(d, p);
  return d;
}

// 저장할 때(saveWithRetry가 묘비를 걷은 뒤) 잴 크기. 걷기는 크기를 줄이기만 한다.
const savedBytes = (d, now) => jsonBytes(pruneTombstones(d, now()));

export function fitPatches(doc, patches, { limit = DOC_MAX_BYTES, now = Date.now } = {}) {
  const all = applyPatches(structuredClone(normDoc(doc)), patches);
  if (savedBytes(all, now) <= limit) return { doc: all, kept: patches.slice(), dropped: [] };
  // 넘으면 하나씩 얹어 보고, 얹은 뒤 한도를 넘는 패치만 뺀다.
  let cur = structuredClone(normDoc(doc));
  const kept = [];
  const dropped = [];
  for (const p of patches) {
    const trial = applyPatch(structuredClone(cur), p);
    if (savedBytes(trial, now) <= limit) { cur = trial; kept.push(p); } else dropped.push(p);
  }
  return { doc: cur, kept, dropped };
}

const isPermanent = (err) => err?.code === 'invalid_request';

function droppedError(tooLarge, invalid) {
  const n = tooLarge + invalid;
  const err = new Error(tooLarge
    ? `보드가 저장 한도(1MB)를 넘어 편집 ${n}개를 저장하지 못했어요`
    : `저장할 수 없는 편집 ${n}개를 버렸어요`);
  err.code = tooLarge ? 'too_large' : 'invalid';
  err.dropped = n;
  return err;
}

const sameTarget = (a, b) => a.kind === b.kind && a.id === b.id && a.boardId === b.boardId;

// b를 a 뒤에 적용한 것과 같은 패치 하나.
export function mergePatch(a, b) {
  const fields = { ...(a.fields ?? {}) };
  const del = new Set(a.deleteKeys ?? []);
  for (const [k, v] of Object.entries(b.fields ?? {})) { fields[k] = v; del.delete(k); }
  for (const k of b.deleteKeys ?? []) { delete fields[k]; del.add(k); }
  const out = { kind: a.kind, id: a.id, t: Math.max(a.t ?? 0, b.t ?? 0) };
  if (a.boardId !== undefined) out.boardId = a.boardId;
  if (a.insert) out.insert = a.insert;
  if (Object.keys(fields).length) out.fields = fields;
  if (del.size) out.deleteKeys = [...del];
  return out;
}

export function createDocEditor({
  adapter, entry = BOARDS_ENTRY, tries = 3, now = Date.now, limit = DOC_MAX_BYTES,
} = {}) {
  let remote = emptyDoc();
  let pending = [];
  let doc = emptyDoc();
  let receives = 0; // receive 횟수. 저장하는 동안 받은 값이 있었는지 본다
  const rebuild = () => { doc = applyPatches(structuredClone(normDoc(remote)), pending); };

  function push(patch) {
    const p = { ...patch, t: Number.isFinite(patch.t) ? patch.t : now() };
    const last = pending[pending.length - 1];
    // 줄의 객체는 저장 중인 묶음(batch)에 들어 있을 수 있으므로 고치지 않고 새 객체로 바꾼다.
    if (last && !p.insert && sameTarget(last, p)) pending[pending.length - 1] = mergePatch(last, p);
    else pending.push(p);
    applyPatch(doc, p);
  }

  // batch를 줄에서 빼고 쓴 값(next)을 기준 값으로 삼는다. next가 없으면(버리기만 했으면) 기준 값은 그대로다.
  // 쓰는 동안 receive가 있었으면 받은 값이 쓴 값보다 새로울 수 있으므로 레코드마다 updatedAt으로 합친다
  // (같으면 받은 값). 저장 사이에 쓴 패치는 다음 저장에서 새로 읽은 값 위에 다시 얹힌다.
  const settle = (batch, next, seq) => {
    if (next) remote = seq === receives ? next : mergeBoards(remote, next);
    pending = pending.filter((p) => !batch.includes(p));
    rebuild();
  };

  // 패치 묶음 하나를 쓴다. 한도를 넘게 만드는 패치는 빼고 쓰고, 뺀 것을 돌려준다.
  async function write(batch) {
    const seq = receives;
    let dropped = [];
    const next = await saveWithRetry(adapter, (d) => {
      const r = fitPatches(d, batch, { limit, now });
      dropped = r.dropped;
      return r.doc;
    }, { tries, entry, now });
    settle(batch, next, seq);
    return dropped.length;
  }

  return {
    get doc() { return doc; },
    get pending() { return pending.length; },
    edit(patches) {
      for (const p of Array.isArray(patches) ? patches : [patches]) if (p) push(p);
    },
    receive(value) {
      receives++;
      remote = structuredClone(normDoc(value));
      rebuild();
    },
    async save() {
      const batch = pending.slice();
      if (!batch.length) return;
      let tooLarge = 0;
      let invalid = 0;
      try {
        tooLarge = await write(batch);
      } catch (err) {
        if (!isPermanent(err)) throw err;
        // 저장소가 받지 않는 값이다. 같은 묶음은 몇 번을 다시 써도 실패하므로 하나씩 나눠 걸린 패치만 버린다.
        // 잠깐의 실패가 끼면 거기서 멈추고(남은 패치는 줄에 남는다) 그 에러를 던진다.
        for (const p of batch) {
          if (batch.length > 1) {
            try {
              tooLarge += await write([p]);
              continue;
            } catch (e) {
              if (!isPermanent(e)) throw e;
            }
          }
          invalid++;
          settle([p], null);
        }
      }
      if (tooLarge || invalid) throw droppedError(tooLarge, invalid);
    },
    writeNow() {
      const batch = pending.slice();
      if (!batch.length) return null;
      const seq = receives;
      const next = pruneTombstones(fitPatches(remote, batch, { limit, now }).doc, now());
      return Promise.resolve(adapter.set(entry, next)).then(() => settle(batch, next, seq));
    },
  };
}

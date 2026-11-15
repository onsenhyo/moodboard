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
// - save(): saveWithRetry로 새로 읽은 값에 줄의 패치를 적용해 쓴다. 충돌하면 다시 읽고 같은 패치를 다시 적용한다.
// - writeNow(): 읽기 없이 마지막으로 받은 값에 패치를 적용해 바로 setStorage한다(창을 닫을 때 첫 시도).
// - pending: 아직 저장하지 않은 패치 수.
// cardTextPatch(boardId, id, field, value, max) -> 카드 label·memo 패치(빈 값이면 키 지우기).

import { BOARDS_ENTRY, saveWithRetry, pruneTombstones } from './store.js';

// 카드 글 필드 하나(label, memo)를 고치는 패치. 앞뒤 공백을 지운 값이 비면 키를 지운다(스키마는 null을 받지 않는다).
// max가 있으면 글자(code point) 수를 그만큼으로 자른다.
export const MEMO_MAX = 500;
export function cardTextPatch(boardId, id, field, value, max = Infinity) {
  const v = [...String(value ?? '').trim()].slice(0, max).join('').trim();
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

export function createDocEditor({ adapter, entry = BOARDS_ENTRY, tries = 3, now = Date.now } = {}) {
  let remote = emptyDoc();
  let pending = [];
  let doc = emptyDoc();
  const rebuild = () => { doc = applyPatches(structuredClone(normDoc(remote)), pending); };

  function push(patch) {
    const p = { ...patch, t: Number.isFinite(patch.t) ? patch.t : now() };
    const last = pending[pending.length - 1];
    // 줄의 객체는 저장 중인 묶음(batch)에 들어 있을 수 있으므로 고치지 않고 새 객체로 바꾼다.
    if (last && !p.insert && sameTarget(last, p)) pending[pending.length - 1] = mergePatch(last, p);
    else pending.push(p);
    applyPatch(doc, p);
  }

  const settle = (batch, next) => {
    remote = next;
    pending = pending.filter((p) => !batch.includes(p));
    rebuild();
  };

  return {
    get doc() { return doc; },
    get pending() { return pending.length; },
    edit(patches) {
      for (const p of Array.isArray(patches) ? patches : [patches]) if (p) push(p);
    },
    receive(value) {
      remote = structuredClone(normDoc(value));
      rebuild();
    },
    async save() {
      const batch = pending.slice();
      if (!batch.length) return;
      const next = await saveWithRetry(adapter, (d) => applyPatches(d, batch), { tries, entry, now });
      settle(batch, next);
    },
    writeNow() {
      const batch = pending.slice();
      if (!batch.length) return null;
      const next = pruneTombstones(applyPatches(structuredClone(normDoc(remote)), batch), now());
      return Promise.resolve(adapter.set(entry, next)).then(() => settle(batch, next));
    },
  };
}

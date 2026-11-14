// 보드 저장 형식, 두 PC 병합, 재시도 저장, 썸네일 shard 저장소.
//
// adapter = { get(entry) -> Promise<any>, set(entry, value) -> Promise<void> }
// set은 플랫폼 에러 객체를 던진다. 충돌은 {code:'conflict', id:'STORAGE_ITEM_WRITE_CONFLICT'}.
// 충돌 뒤 같은 쓰기를 다시 보내도 계속 충돌하므로 반드시 get으로 다시 읽은 뒤 쓴다.

export const BOARDS_ENTRY = 'boards';
export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function isConflict(err) {
  return err?.code === 'conflict';
}

const emptyDoc = () => ({ version: 1, boards: [] });

function normDoc(d) {
  return d && typeof d === 'object' && Array.isArray(d.boards) ? d : emptyDoc();
}

// updatedAt이 큰 쪽. 같으면 묘비, 그래도 같으면 로컬.
function pick(l, r) {
  if (!l) return r;
  if (!r) return l;
  const lt = l.updatedAt ?? 0;
  const rt = r.updatedAt ?? 0;
  if (lt > rt) return l;
  if (rt > lt) return r;
  if (r.deleted && !l.deleted) return r;
  return l;
}

// 로컬 순서를 먼저, 원격에만 있는 것은 원격 순서대로 뒤에 붙인다.
function mergeById(local, remote, both) {
  const rById = new Map(remote.map((x) => [x.id, x]));
  const seen = new Set();
  const out = [];
  for (const l of local) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    const r = rById.get(l.id);
    out.push(r ? both(l, r) : l);
  }
  for (const r of remote) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export function mergeBoards(local, remote) {
  const l = normDoc(local);
  const r = normDoc(remote);
  const boards = mergeById(l.boards, r.boards, (lb, rb) => ({
    ...pick(lb, rb),
    cards: mergeById(lb.cards ?? [], rb.cards ?? [], pick),
  }));
  return structuredClone({ ...r, ...l, version: 1, boards });
}

export function pruneTombstones(doc, now, maxAgeMs = TOMBSTONE_MAX_AGE_MS) {
  const d = normDoc(doc);
  const expired = (x) => x.deleted === true && now - (x.updatedAt ?? 0) > maxAgeMs;
  return {
    ...d,
    boards: d.boards
      .filter((b) => !expired(b))
      .map((b) => (Array.isArray(b.cards) ? { ...b, cards: b.cards.filter((c) => !expired(c)) } : b)),
  };
}

export async function saveWithRetry(adapter, mutate, opts = {}) {
  const { tries = 3, entry = BOARDS_ENTRY, local } = opts;
  const now = opts.now ?? Date.now;
  let lastErr;
  for (let i = 0; i < Math.max(1, tries); i++) {
    const remote = await adapter.get(entry);
    const base = local ? mergeBoards(local, remote) : structuredClone(normDoc(remote));
    const next = pruneTombstones(mutate(base) ?? base, now());
    try {
      await adapter.set(entry, next);
      return next;
    } catch (err) {
      if (!isConflict(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// --- 썸네일 shard ---

export const shardIdOf = (i) => 'thumbs_' + String(i).padStart(3, '0');

// JSON.stringify 결과 문자열의 UTF-8 바이트 수. stringify가 외톨이 surrogate를
// 이스케이프하므로 surrogate는 항상 짝으로 온다.
function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const entryBytes = (k, v) => utf8Len(JSON.stringify(k)) + 1 + utf8Len(JSON.stringify(v));

// JSON.stringify(Object.fromEntries(map))의 UTF-8 바이트 수를 문자열을 만들지 않고 센다.
function shardBytes(map, replaceKey, replaceVal) {
  let n = 2;
  let count = 0;
  if (map) {
    for (const [k, v] of map) {
      if (k === replaceKey) continue;
      n += entryBytes(k, v);
      count++;
    }
  }
  if (replaceKey !== undefined) {
    n += entryBytes(replaceKey, replaceVal);
    count++;
  }
  return n + Math.max(0, count - 1);
}

// 넣을 수 있는 가장 낮은 번호의 shard. 이미 들어 있는 카드면 그 shard에 맞는지 먼저 본다.
export function packThumbs(existing, add, { shardLimit = 1_000_000, shards = 128 } = {}) {
  const fits = (id) => shardBytes(existing.get(id), add.cardId, add.b64) <= shardLimit;
  for (let i = 0; i < shards; i++) {
    const id = shardIdOf(i);
    if (existing.get(id)?.has(add.cardId) && fits(id)) return { shardId: id };
  }
  for (let i = 0; i < shards; i++) {
    const id = shardIdOf(i);
    if (fits(id)) return { shardId: id };
  }
  return { error: 'full' };
}

const SHARD_WRITE_TRIES = 3;

// ThumbStore.
// - 모든 shard 쓰기는 읽고-고치고-쓰기다. adapter.get으로 그 shard를 새로 읽고, 추가나 삭제 하나만
//   적용하고, 크기를 shardLimit로 다시 잰 뒤 adapter.set 한다. 메모리 캐시로 덮어쓰지 않으므로
//   onStorageChange 등으로 플랫폼의 기준 판이 앞서가도 다른 PC의 썸네일을 지우지 않는다.
// - 캐시와 색인은 실제로 쓴 값(또는 읽은 값)으로만 갱신한다.
// - reload(shardId, value)는 다른 PC의 변경을 받아 그 shard의 캐시와 색인만 다시 만든다.
// - 색인은 카드가 실제로 들어 있는 shard를 가리킨다. 이 창이 카드를 다른 shard로 옮긴 뒤
//   옛 shard에 남은 사본은 pending에 적어 두고, 그 shard를 다음에 성공적으로 쓸 때 걷어낸다.
export async function createThumbStore(adapter, { shards = 128, shardLimit = 1_000_000 } = {}) {
  const ids = Array.from({ length: shards }, (_, i) => shardIdOf(i));
  const cache = new Map(); // shardId -> Map<cardId, b64>
  const index = new Map(); // cardId -> shardId
  const pending = new Map(); // shardId -> Set<cardId>: 이 창이 옮겨서 옛 shard에 남은 사본

  const holds = (id, cardId) => !!id && cache.get(id)?.has(cardId) === true;
  const toMap = (value) => new Map(value && typeof value === 'object' ? Object.entries(value) : []);

  // 다른 shard에도 있는 카드면 그 shard를 찾는다.
  function findElsewhere(cardId, exceptId) {
    for (const id of ids) if (id !== exceptId && holds(id, cardId)) return id;
    return undefined;
  }

  // shard 하나의 캐시를 바꾸고 그 shard에 걸린 색인만 다시 만든다.
  function load(id, value) {
    const m = toMap(value);
    const old = cache.get(id);
    cache.set(id, m);
    if (old) {
      for (const k of old.keys()) {
        if (index.get(k) !== id || m.has(k)) continue;
        const other = findElsewhere(k, id);
        if (other) index.set(k, other); else index.delete(k);
      }
    }
    for (const k of m.keys()) {
      const cur = index.get(k);
      if (!(cur && cur !== id && holds(cur, k))) index.set(k, id);
    }
    const p = pending.get(id);
    if (p) {
      for (const k of p) if (!m.has(k)) p.delete(k);
      if (p.size === 0) pending.delete(id);
    }
  }

  const values = await Promise.all(ids.map((id) => adapter.get(id)));
  ids.forEach((id, i) => load(id, values[i]));

  // 같은 창 안의 put/remove가 겹치지 않게 한 줄로 세운다.
  let tail = Promise.resolve();
  const serial = (fn) => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };

  // 한 번의 읽고-고치고-쓰기. apply(map)는 바꿨으면 true를 돌려준다.
  // 결과: 'ok' | 'unchanged' | 'nofit' | {conflict: err}. 충돌이 아닌 에러는 던진다.
  async function writeOnce(id, apply) {
    const raw = await adapter.get(id);
    const fresh = toMap(raw);
    let changed = false;
    // 이 창이 옮긴 카드의 옛 사본을 걷어낸다(색인이 실제로 다른 shard를 가리킬 때만).
    for (const k of pending.get(id) ?? []) {
      const home = index.get(k);
      if (fresh.has(k) && home && home !== id && holds(home, k)) { fresh.delete(k); changed = true; }
    }
    if (apply(fresh)) changed = true;
    if (!changed) { load(id, raw); return 'unchanged'; }
    if (shardBytes(fresh) > shardLimit) { load(id, raw); return 'nofit'; }
    const obj = Object.fromEntries(fresh);
    try {
      await adapter.set(id, obj);
    } catch (err) {
      if (!isConflict(err)) throw err;
      load(id, raw);
      return { conflict: err };
    }
    pending.delete(id);
    load(id, obj);
    return 'ok';
  }

  // nofit이 나지 않는 쓰기(삭제, 정리)를 충돌 시 3번까지.
  async function writeWithRetry(id, apply) {
    let lastErr;
    for (let i = 0; i < SHARD_WRITE_TRIES; i++) {
      const r = await writeOnce(id, apply);
      if (!r.conflict) return r;
      lastErr = r.conflict;
    }
    throw lastErr;
  }

  async function put(cardId, b64) {
    let conflicts = 0;
    // nofit은 그 shard의 캐시를 새로 읽은 값으로 바꾸므로 packThumbs가 다음 shard를 고른다.
    for (let guard = 0; guard < shards + SHARD_WRITE_TRIES; guard++) {
      const r = packThumbs(cache, { cardId, b64 }, { shards, shardLimit });
      if (r.error) return r;
      const prev = index.get(cardId);
      const res = await writeOnce(r.shardId, (m) => {
        if (m.get(cardId) === b64) return false;
        m.set(cardId, b64);
        return true;
      });
      if (res.conflict) {
        if (++conflicts >= SHARD_WRITE_TRIES) throw res.conflict;
        continue;
      }
      if (res === 'nofit') continue;
      // 'ok' 또는 'unchanged': 이제 카드는 r.shardId에 있다.
      index.set(cardId, r.shardId);
      if (prev && prev !== r.shardId && holds(prev, cardId)) {
        if (!pending.has(prev)) pending.set(prev, new Set());
        pending.get(prev).add(cardId);
        // 옛 사본 정리는 실패해도 넣기는 이미 끝났다. 남은 사본은 pending이 다음 쓰기에서 걷어낸다.
        try { await writeWithRetry(prev, () => false); } catch { /* 다음 쓰기에서 정리 */ }
        index.set(cardId, r.shardId);
      }
      return;
    }
    return { error: 'full' };
  }

  async function remove(cardId) {
    // 사본이 여러 shard에 있으면 모두 지운다.
    for (let guard = 0; guard < shards; guard++) {
      const id = index.get(cardId);
      if (!id) return;
      await writeWithRetry(id, (m) => m.delete(cardId));
      if (index.get(cardId) === id) index.delete(cardId); // 다시 읽은 shard에 이미 없던 경우
    }
  }

  return {
    async get(cardId) {
      const id = index.get(cardId);
      return (id && cache.get(id)?.get(cardId)) ?? null;
    },
    put: (cardId, b64) => serial(() => put(cardId, b64)),
    remove: (cardId) => serial(() => remove(cardId)),
    reload(shardId, value) {
      if (ids.includes(shardId)) load(shardId, value);
    },
  };
}

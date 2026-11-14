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
  for (let i = 0; i < tries; i++) {
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

export async function createThumbStore(adapter, { shards = 128, shardLimit = 1_000_000 } = {}) {
  const ids = Array.from({ length: shards }, (_, i) => shardIdOf(i));
  const cache = new Map(); // shardId -> Map<cardId, b64>
  const index = new Map(); // cardId -> shardId

  function load(id, value) {
    const old = cache.get(id);
    if (old) for (const k of old.keys()) if (index.get(k) === id) index.delete(k);
    const m = new Map(value && typeof value === 'object' ? Object.entries(value) : []);
    cache.set(id, m);
    for (const k of m.keys()) index.set(k, id);
  }

  const values = await Promise.all(ids.map((id) => adapter.get(id)));
  ids.forEach((id, i) => load(id, values[i]));

  // 같은 창 안의 put/remove가 같은 shard를 겹쳐 쓰지 않게 한 줄로 세운다.
  let tail = Promise.resolve();
  const serial = (fn) => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };

  async function removeFrom(id, cardId) {
    let lastErr;
    for (let i = 0; i < SHARD_WRITE_TRIES; i++) {
      const cur = cache.get(id);
      if (!cur?.has(cardId)) return;
      const next = new Map(cur);
      next.delete(cardId);
      const obj = Object.fromEntries(next);
      try {
        await adapter.set(id, obj);
        load(id, obj);
        return;
      } catch (err) {
        if (!isConflict(err)) throw err;
        lastErr = err;
        load(id, await adapter.get(id));
      }
    }
    throw lastErr;
  }

  async function put(cardId, b64) {
    let lastErr;
    for (let i = 0; i < SHARD_WRITE_TRIES; i++) {
      const r = packThumbs(cache, { cardId, b64 }, { shards, shardLimit });
      if (r.error) return r;
      const prev = index.get(cardId);
      const next = new Map(cache.get(r.shardId));
      next.set(cardId, b64);
      const obj = Object.fromEntries(next);
      try {
        await adapter.set(r.shardId, obj);
      } catch (err) {
        if (!isConflict(err)) throw err;
        lastErr = err;
        // 그 shard만 다시 읽고 packThumbs부터 다시 한다. 다시 읽은 shard가 차 있으면 다음 shard로 간다.
        load(r.shardId, await adapter.get(r.shardId));
        continue;
      }
      load(r.shardId, obj);
      index.set(cardId, r.shardId);
      if (prev && prev !== r.shardId) await removeFrom(prev, cardId);
      return;
    }
    throw lastErr;
  }

  return {
    async get(cardId) {
      const id = index.get(cardId);
      return (id && cache.get(id)?.get(cardId)) ?? null;
    },
    put: (cardId, b64) => serial(() => put(cardId, b64)),
    remove: (cardId) => serial(async () => {
      const id = index.get(cardId);
      if (id) await removeFrom(id, cardId);
    }),
  };
}

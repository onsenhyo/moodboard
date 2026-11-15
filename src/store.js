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
  // 묶음도 카드와 같은 규칙으로 합친다. groups가 없는 옛 보드는 []로 채운다.
  const boards = mergeById(l.boards, r.boards, (lb, rb) => ({
    ...pick(lb, rb),
    cards: mergeById(lb.cards ?? [], rb.cards ?? [], pick),
    groups: mergeById(lb.groups ?? [], rb.groups ?? [], pick),
  })).map((b) => (Array.isArray(b.groups) ? b : { ...b, groups: [] }));
  return structuredClone({ ...r, ...l, version: 1, boards });
}

export function pruneTombstones(doc, now, maxAgeMs = TOMBSTONE_MAX_AGE_MS) {
  const d = normDoc(doc);
  const expired = (x) => x.deleted === true && now - (x.updatedAt ?? 0) > maxAgeMs;
  return {
    ...d,
    boards: d.boards
      .filter((b) => !expired(b))
      .map((b) => {
        let out = b;
        if (Array.isArray(b.cards)) out = { ...out, cards: b.cards.filter((c) => !expired(c)) };
        if (Array.isArray(b.groups)) out = { ...out, groups: b.groups.filter((g) => !expired(g)) };
        return out;
      }),
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

// shard id. 썸네일은 thumbs_000..127, 움직이는 GIF는 gifs_00..31. 모양(cardId → "<writtenAtMs>:<base64>")과
// 1,000,000바이트 한도는 같고 접두와 자릿수, 개수만 다르다.
export const THUMB_STORE = Object.freeze({ prefix: 'thumbs_', pad: 3, shards: 128 });
export const GIF_STORE = Object.freeze({ prefix: 'gifs_', pad: 2, shards: 32 });
export const shardIdFor = (prefix, pad) => (i) => prefix + String(i).padStart(pad, '0');
export const shardIdOf = shardIdFor(THUMB_STORE.prefix, THUMB_STORE.pad);
export const gifShardIdOf = shardIdFor(GIF_STORE.prefix, GIF_STORE.pad);

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

// JSON.stringify(value)의 UTF-8 바이트 수(저장 항목 한도를 잴 때 쓴다).
export const jsonBytes = (value) => utf8Len(JSON.stringify(value) ?? '');

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
// skip에 든 shard(아직 못 읽은 shard)는 고르지 않는다.
export function packThumbs(existing, add, { shardLimit = 1_000_000, shards = 128, skip, idOf = shardIdOf } = {}) {
  const fits = (id) => !skip?.has(id) && shardBytes(existing.get(id), add.cardId, add.b64) <= shardLimit;
  for (let i = 0; i < shards; i++) {
    const id = idOf(i);
    if (existing.get(id)?.has(add.cardId) && fits(id)) return { shardId: id };
  }
  for (let i = 0; i < shards; i++) {
    const id = idOf(i);
    if (fits(id)) return { shardId: id };
  }
  return { error: 'full' };
}

const SHARD_WRITE_TRIES = 3;

// 저장되는 shard 값은 "<writtenAtMs>:<base64>"다. base64에는 ':'가 없으므로 접두가 없는 값은
// writtenAt 0인 base64로 읽는다.
const STAMP_RE = /^(\d+):/;
export function parseThumb(v) {
  if (typeof v !== 'string') return { t: 0, b64: null };
  const m = STAMP_RE.exec(v);
  return m ? { t: Number(m[1]), b64: v.slice(m[0].length) } : { t: 0, b64: v };
}
export const stampThumb = (t, b64) => `${t}:${b64}`;

// ThumbStore. prefix와 pad로 shard id를 정한다(기본 thumbs_000.., GIF_STORE를 펼쳐 주면 gifs_00..).
// - 모든 shard 쓰기는 읽고-고치고-쓰기다. adapter.get으로 그 shard를 새로 읽고, 추가나 삭제 하나만
//   적용하고, 크기(접두 포함 저장 값의 JSON.stringify 바이트)를 shardLimit로 다시 잰 뒤 adapter.set 한다.
//   메모리 캐시로 덮어쓰지 않으므로 onStorageChange 등으로 기준 판이 앞서가도 다른 PC의 썸네일을 지우지 않는다.
// - 캐시와 색인은 실제로 쓴 값(또는 읽은 값)으로만 갱신한다.
// - 한 카드가 여러 shard에 있으면 writtenAt이 가장 큰 사본이 이기고, 같으면 낮은 번호 shard가 이긴다.
//   세션 기억 없이 저장된 값만으로 정해지므로 재시작한 창이나 다른 PC도 같은 사본을 고른다.
// - 진 사본은 그 shard를 다음에 성공적으로 쓸 때 걷어낸다. put과 remove는 그 카드의 모든 사본을 정리한다.
// - reload(shardId, value)는 다른 PC의 변경을 받아 그 shard의 캐시와, 그 shard에 걸린 카드의 색인만 다시 만든다.
// - 시작할 때 읽지 못한 shard는 missing()에 남는다. 그 shard는 reload로 값을 받을 때까지 새 썸네일을 받지 않는다.
//   읽은 shard가 모두 찼는데 못 읽은 shard가 남아 있으면 put은 {error:'full'} 대신 'thumbs loading' 오류를 던진다.
export async function createThumbStore(adapter, {
  shards = THUMB_STORE.shards, shardLimit = 1_000_000, now = Date.now, prefix = THUMB_STORE.prefix, pad = THUMB_STORE.pad,
} = {}) {
  const idOf = shardIdFor(prefix, pad);
  const ids = Array.from({ length: shards }, (_, i) => idOf(i));
  const cache = new Map(); // shardId -> Map<cardId, 저장 값>
  const index = new Map(); // cardId -> 이기는 사본의 shardId
  const unloaded = new Set(); // 아직 읽지 못한 shardId

  const toMap = (value) => new Map(
    value && typeof value === 'object' ? Object.entries(value).filter(([, v]) => typeof v === 'string') : [],
  );
  const stampIn = (id, cardId) => parseThumb(cache.get(id)?.get(cardId)).t;
  const holders = (cardId) => ids.filter((id) => cache.get(id)?.has(cardId));

  // 사본 (ta, 번호 ia)가 (tb, ib)를 이기는가.
  const beats = (ta, ia, tb, ib) => ta > tb || (ta === tb && ia < ib);

  function best(cardId) {
    let win;
    for (let i = 0; i < ids.length; i++) {
      if (!cache.get(ids[i])?.has(cardId)) continue;
      if (win === undefined || beats(stampIn(ids[i], cardId), i, stampIn(ids[win], cardId), win)) win = i;
    }
    return win === undefined ? undefined : ids[win];
  }

  function load(id, value) {
    unloaded.delete(id); // 값을 받았으니 읽은 shard다
    const m = toMap(value);
    const keys = new Set([...(cache.get(id)?.keys() ?? []), ...m.keys()]);
    cache.set(id, m);
    for (const k of keys) {
      const b = best(k);
      if (b) index.set(k, b); else index.delete(k);
    }
  }

  const settled = await Promise.allSettled(ids.map((id) => adapter.get(id)));
  ids.forEach((id, i) => {
    if (settled[i].status === 'fulfilled') load(id, settled[i].value);
    else unloaded.add(id);
  });

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
    const idx = ids.indexOf(id);
    let changed = false;
    // 다른 shard의 사본에 지는 사본을 걷어낸다. 새로 읽은 값의 시각으로 비교하므로
    // 다른 PC가 이 shard에 더 새로 쓴 사본은 지우지 않는다.
    for (const [k, v] of [...fresh]) {
      const w = index.get(k);
      if (!w || w === id || !cache.get(w)?.has(k)) continue;
      if (beats(stampIn(w, k), ids.indexOf(w), parseThumb(v).t, idx)) { fresh.delete(k); changed = true; }
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
    load(id, obj);
    return 'ok';
  }

  async function writeWithRetry(id, apply) {
    let lastErr;
    for (let i = 0; i < SHARD_WRITE_TRIES; i++) {
      const r = await writeOnce(id, apply);
      if (!r.conflict) return r;
      lastErr = r.conflict;
    }
    throw lastErr;
  }

  // 이기는 사본만 남기고 나머지 shard의 사본을 걷어낸다. 실패는 다음 쓰기에서 다시 걷힌다.
  async function sweep(cardId) {
    for (const id of holders(cardId)) {
      if (id === index.get(cardId)) continue;
      try { await writeWithRetry(id, () => false); } catch { /* 다음 쓰기에서 정리 */ }
    }
  }

  async function put(cardId, b64) {
    let conflicts = 0;
    // nofit은 그 shard의 캐시를 새로 읽은 값으로 바꾸므로 packThumbs가 다음 shard를 고른다.
    for (let guard = 0; guard < shards + SHARD_WRITE_TRIES; guard++) {
      // 새 사본이 반드시 이기도록 아는 사본들보다 큰 시각을 쓴다.
      const known = holders(cardId).reduce((t, id) => Math.max(t, stampIn(id, cardId)), -1);
      const value = stampThumb(Math.max(now(), known + 1), b64);
      const r = packThumbs(cache, { cardId, b64: value }, { shards, shardLimit, skip: unloaded, idOf });
      if (r.error) {
        if (unloaded.size) throw new Error('thumbs loading');
        return r;
      }
      const res = await writeOnce(r.shardId, (m) => { m.set(cardId, value); return true; });
      if (res.conflict) {
        if (++conflicts >= SHARD_WRITE_TRIES) throw res.conflict;
        continue;
      }
      if (res === 'nofit') continue;
      await sweep(cardId);
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
      if (index.get(cardId) === id) index.delete(cardId); // 안전장치
    }
  }

  return {
    async get(cardId) {
      const id = index.get(cardId);
      return (id && parseThumb(cache.get(id)?.get(cardId)).b64) ?? null;
    },
    put: (cardId, b64) => serial(() => put(cardId, b64)),
    remove: (cardId) => serial(() => remove(cardId)),
    reload(shardId, value) {
      if (ids.includes(shardId)) load(shardId, value);
    },
    missing: () => [...unloaded],
  };
}

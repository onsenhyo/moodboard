// window.kaleidoscope 위의 얇은 어댑터. 다른 모듈은 이 객체만 쓴다(테스트에서는 가짜로 바꾼다).
// 정본: kaleidoscope ui/src/blocks/sandbox-frame.ts.

export function createPlatform(client) {
  return {
    // store.js의 adapter 모양 {get, set}. set의 실패는 플랫폼 에러 객체({id, code, message})다.
    storage: {
      get: (entry) => client.getStorage(entry),
      set: (entry, value) => client.setStorage(entry, value),
      // 초기 값과 다른 PC의 변경을 알린다. 리스너가 false를 돌려주지 않으면 새 revision을 받아들인다.
      watch: (entry, onValue, onError) => client.onStorageChange(entry, onValue, onError),
    },
    blobs: {
      put: (key, fileId) => client.blobs.put({ key, file_id: fileId }),
      open: (key) => client.blobs.open({ key }),
      remove: (key) => client.blobs.remove({ key }),
      async has(key) {
        if (!key) return false;
        try {
          const keys = await client.blobs.list({ prefix: key });
          return Array.isArray(keys) && keys.includes(key);
        } catch {
          return false;
        }
      },
    },
    files: {
      read: (id) => client.files.read(id),
    },
    http: {
      read: (permission, path, query = {}) => client.http.read({ permission, path, query }),
    },
    publish: (patch) => client.publish(patch),
    getState: (key) => client.getState(key),
    setState: (key, value) => client.setState(key, value),
    handle: (name, fn) => client.handle(name, fn),
    onSurface: (name, fn) => client.surfaces.on(name, fn),
  };
}

// window.kaleidoscope 위의 얇은 어댑터. 다른 모듈은 이 객체만 쓴다(테스트에서는 가짜로 바꾼다).
// 정본: kaleidoscope ui/src/blocks/sandbox-frame.ts.

function exactBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return whole ? bytes.buffer : bytes.slice().buffer;
}

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
      // 바이트로 넣기(보드에 끌어 놓은 파일). bytes는 transfer되므로 넘긴 뒤 쓰지 않는다.
      putBytes: (key, bytes) => client.blobs.put({ key, bytes: exactBuffer(bytes) }),
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
      // client 2. 선언한 client 동작 안에서만 열린다. file_id 또는 취소면 null.
      savePrompt: ({ suggested_name, mime }) => client.files.save_prompt({ suggested_name, mime }),
      // 프레임은 bytes를 ArrayBuffer로 넘기므로(transfer) 딱 맞는 ArrayBuffer를 만든다.
      write: (id, offset, bytes) => client.files.write(id, offset, exactBuffer(bytes)),
      close: (id) => client.files.close(id),
      abort: (id) => client.files.abort(id),
    },
    http: {
      read: (permission, path, query = {}) => client.http.read({ permission, path, query }),
    },
    // 정의의 assets에 선언한 자산의 바이트(ArrayBuffer).
    assetBytes: (id) => client.assets.bytes(id),
    publish: (patch) => client.publish(patch),
    getState: (key) => client.getState(key),
    setState: (key, value) => client.setState(key, value),
    // 창 상태가 바뀌면 선언한 상태 키 전체를 받는다(sandbox가 쓴 selected, view, paste_inbox 등).
    onState: (fn) => client.onStateChange(fn),
    handle: (name, fn) => client.handle(name, fn),
    onSurface: (name, fn) => client.surfaces.on(name, fn),
    // 리스너가 phase 'closing'에서 돌려준 promise는 쉘이 창을 닫기 전에 기다린다.
    onLifecycle: (fn) => client.onLifecycle(fn),
  };
}

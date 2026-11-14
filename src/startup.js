// 시작과 닫기를 돕는 순수 도구. 타이머는 주입받는다.

// 열리기 전에 들어온 일은 줄을 세웠다가 open()에서 순서대로 실행한다.
export function createGate() {
  let open = false;
  const waiting = [];
  return {
    get isOpen() { return open; },
    open() {
      if (open) return;
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
    run(fn) {
      if (open) return Promise.resolve().then(fn);
      return new Promise((resolve) => waiting.push(resolve)).then(fn);
    },
  };
}

// 1초, 2초, 4초, 그다음에는 10초마다.
const RETRY_DELAYS = [1000, 2000, 4000];
const RETRY_EVERY_MS = 10_000;
export const retryDelay = (attempt) => RETRY_DELAYS[attempt] ?? RETRY_EVERY_MS;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 성공할 때까지 읽는다. 결과: {value} | {stopped:true}(stop()이 참이 되면).
export async function retryRead(read, { sleep = realSleep, onFail, stop } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (stop?.()) return { stopped: true };
    try {
      return { value: await read() };
    } catch (err) {
      onFail?.(err, attempt);
    }
    if (stop?.()) return { stopped: true };
    await sleep(retryDelay(attempt));
  }
}

// 저장을 한 줄로 세우고 디바운스한다.
// - schedule(ms): 바뀐 것이 있다고 표시하고 ms 뒤에 저장한다. 다시 부르면 타이머를 새로 건다.
// - flush(): 타이머를 지우고, 진행 중인 저장을 기다린 뒤 바뀐 것이 남았으면 저장한다. 창 닫기에 쓴다.
// - 저장 중에 바뀌면 그 저장이 끝난 뒤 이어서 저장한다(타이머가 걸려 있으면 타이머를 기다린다).
export function createSaver(save, { setTimer = setTimeout, clearTimer = clearTimeout, onError } = {}) {
  let timer = null;
  let running = null;
  let dirty = false;

  function kick() {
    if (running) return running;
    if (!dirty) return Promise.resolve();
    running = (async () => {
      try {
        while (dirty && timer === null) {
          dirty = false;
          try { await save(); } catch (err) { onError?.(err); }
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    schedule(ms = 0) {
      dirty = true;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => { timer = null; kick(); }, ms);
    },
    async flush() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (running) await running;
      await kick();
    },
  };
}

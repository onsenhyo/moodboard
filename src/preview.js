// 옆 칸의 썸네일 미리보기 canvas(브라우저 전용). image 블록은 data: 주소를 받지 않으므로
// 원본이 없는 그림 카드의 썸네일을 이 표면에 contain으로 그린다.

export function createPreview() {
  let surface = null;
  let onResize = null;
  let bitmap = null;
  let wanted = null; // 그릴 data URL
  let seq = 0;

  function draw() {
    if (!surface || !surface.visible) return;
    const { canvas, cssWidth, cssHeight, dpr } = surface;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!bitmap) return;
    const s = Math.min(w / bitmap.width, h / bitmap.height);
    const dw = bitmap.width * s;
    const dh = bitmap.height * s;
    ctx.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  async function show(dataUrl) {
    if (dataUrl === wanted) return;
    wanted = dataUrl ?? null;
    const my = ++seq;
    let next = null;
    if (wanted) {
      try {
        // 프레임의 fetch는 막혀 있으므로 data: 주소를 직접 푼다.
        const m = /^data:([^;,]+);base64,(.*)$/.exec(wanted);
        if (m) {
          const bin = atob(m[2]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          next = await createImageBitmap(new Blob([bytes], { type: m[1] }));
        }
      } catch {
        next = null;
      }
    }
    if (my !== seq) { next?.close?.(); return; }
    bitmap?.close?.();
    bitmap = next;
    draw();
  }

  function attach(next) {
    if (surface && onResize) surface.resize.removeEventListener('resize', onResize);
    surface = next ?? null;
    onResize = null;
    if (surface) {
      onResize = () => draw();
      surface.resize.addEventListener('resize', onResize);
      draw();
    }
  }

  return { attach, show };
}

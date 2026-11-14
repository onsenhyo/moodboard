const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(url) {
  const host = url.hostname.replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
      if (m) id = m[1];
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

function isPinterestHost(host) {
  return /^([a-z0-9-]+\.)?pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
}

export function classifyInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return { kind: 'text', text: s };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'text', text: s };
  const videoId = youtubeId(url);
  if (videoId) return { kind: 'youtube', videoId };
  const host = url.hostname;
  if (host === 'pin.it') return { kind: 'pin_short', url: s };
  if (isPinterestHost(host)) {
    const m = url.pathname.match(/^\/pin\/(\d+)/);
    if (m) return { kind: 'pinterest', pinId: m[1] };
  }
  return { kind: 'link', url: s };
}

// FRP Live - Cloudflare Worker in front of frplive.ro.
//
// The site is served by the score server on the production laptop through the
// Cloudflare Tunnel. When the app is closed (or the laptop is off) Cloudflare has
// nowhere to send visitors and shows a bare error page. This Worker passes every
// request through untouched while the app is up, and otherwise answers with a
// small FRP Live "no match live right now" page that reloads itself as soon as
// the score server is back.
//
// It also sends www.frplive.ro to frplive.ro, so that works while the app is off.
//
// Deploy: see README.md next to this file.

import logo from '../../Scoreboard/public/frp-mark.png';

const LOGO_PATH = '/__offline/frp-mark.png';

// Cloudflare's answers when the origin cannot be reached: 502/504 (tunnel up,
// app closed), 520-527 (origin errors), 530 (tunnel down - error 1033).
const ORIGIN_DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === LOGO_PATH) {
      return new Response(logo, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    let res = null;
    try {
      res = await fetch(request);
    } catch (_) {
      res = null; // network error reaching the origin
    }
    if (res && !ORIGIN_DOWN.has(res.status)) return res;

    return offline(request);
  },
};

function offline(request) {
  const headers = { 'Cache-Control': 'no-store', 'Retry-After': '30' };
  const wantsPage = request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html');
  if (!wantsPage) {
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0B1B2E">
<meta name="robots" content="noindex">
<title>FRP Live</title>
<link rel="icon" href="${LOGO_PATH}">
<style>
  :root { --navy: #0B1B2E; --deep: #00163f; --gold: #FCD116; --red: #CE1126; --blue: #002B7F; --text: #fff; --muted: rgba(255,255,255,.68); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    min-height: 100%;
    display: flex; flex-direction: column;
    background: radial-gradient(900px 420px at 85% 10%, rgba(0,43,127,.65), transparent 65%), linear-gradient(180deg, var(--deep) 0%, #050608 100%);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .flag { height: 4px; display: grid; grid-template-columns: 1fr 1fr 1fr; }
  .flag i:nth-child(1) { background: var(--blue); } .flag i:nth-child(2) { background: var(--gold); } .flag i:nth-child(3) { background: var(--red); }
  main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px 16px; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand img { width: 64px; height: 64px; object-fit: contain; }
  .brand b { font-size: clamp(34px, 9vw, 54px); letter-spacing: .04em; font-weight: 800; }
  .brand b span { color: var(--gold); }
  h1 { font-size: clamp(20px, 5vw, 28px); font-weight: 700; margin-top: 8px; }
  p { color: var(--muted); font-size: 16px; line-height: 1.5; max-width: 34em; }
  .ro { font-style: italic; }
  .check { margin-top: 10px; font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  footer { text-align: center; padding: 18px 16px 24px; font-size: 12px; color: rgba(255,255,255,.45); }
</style>
</head>
<body>
  <div class="flag"><i></i><i></i><i></i></div>
  <main>
    <div class="brand"><img src="${LOGO_PATH}" alt=""><b>FRP <span>LIVE</span></b></div>
    <h1>No match live right now</h1>
    <p>Live scores appear here automatically when the next match starts.</p>
    <p class="ro">Niciun meci live acum. Scorul apare aici automat la începutul următorului meci.</p>
    <div class="check"><span class="dot"></span><span>Checking again every 30 seconds…</span></div>
  </main>
  <footer>Federația Română de Padel · FRP Live</footer>
<script>
  setInterval(function () {
    fetch('/api/state', { cache: 'no-store' }).then(function (r) { if (r.ok) location.reload(); }).catch(function () {});
  }, 30000);
</script>
</body>
</html>`;

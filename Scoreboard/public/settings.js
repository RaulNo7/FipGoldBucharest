/* Admin page (app-only): OBS overlay/intro URLs, court TV URL, tunnel hostname,
   access key and the public links. No live state needed here. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let publicPort = 0;

  // ---- OBS overlay URL (LAN, for the Browser Source) ----
  function updateOverlayUrl() {
    const pos = $('#ovPos').value;
    const scale = $('#ovScale').value;
    const url = new URL('/overlay', location.origin);
    url.searchParams.set('pos', pos);
    if (scale && scale !== '1') url.searchParams.set('scale', scale);
    $('#overlayUrl').value = url.toString();
  }
  $('#ovPos').addEventListener('change', updateOverlayUrl);
  $('#ovScale').addEventListener('input', updateOverlayUrl);
  $('#copyUrlBtn').addEventListener('click', () => copyField($('#overlayUrl'), $('#copyUrlBtn')));
  $('#openOverlayBtn').addEventListener('click', () => window.open($('#overlayUrl').value, '_blank'));
  updateOverlayUrl();

  // ---- players intro URL (second Browser Source) ----
  $('#introUrl').value = new URL('/intro', location.origin).toString();
  $('#copyIntroUrlBtn').addEventListener('click', () => copyField($('#introUrl'), $('#copyIntroUrlBtn')));
  $('#openIntroBtn').addEventListener('click', () => window.open($('#introUrl').value, '_blank'));

  // ---- court TV URL (LAN) + public port info ----
  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      const host = info.lanHost || location.hostname;
      $('#tvUrl').value = `http://${host}:${info.port}/tv`;
      publicPort = info.publicPort || 0;
      $('#publicPort').textContent = publicPort || 'disabled';
      $('#publicLocal').textContent = publicPort ? `http://localhost:${publicPort}` : '(set PUBLIC_PORT)';
      updatePublicUrls();
    })
    .catch(() => {
      $('#tvUrl').value = new URL('/tv', location.origin).toString();
    });
  $('#copyTvUrlBtn').addEventListener('click', () => copyField($('#tvUrl'), $('#copyTvUrlBtn')));
  $('#openTvBtn').addEventListener('click', () => window.open($('#tvUrl').value, '_blank'));

  // ---- internet access (tunnel hostname + access key) ----
  function publicBase() {
    const host = ($('#publicHostname').value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host) return `https://${host}`;
    return publicPort ? `http://${location.hostname}:${publicPort}` : '';
  }

  function updatePublicUrls() {
    const base = publicBase();
    const key = ($('#refereeKey').value || '').trim();
    const keyed = (p) => (!base ? '' : key ? `${base}${p}?key=${encodeURIComponent(key)}` : '(set an access key first)');
    $('#pubHomeUrl').value = base ? (key ? `${base}/?key=${encodeURIComponent(key)}` : `${base}/`) : '';
    $('#pubOverlayUrl').value = base ? `${base}/overlay?pos=top-left` : '';
    $('#pubTvUrl').value = base ? `${base}/tv` : '';
    $('#pubRefereeUrl').value = keyed('/mobile');
    $('#pubAdminUrl').value = keyed('/admin');
    $('#pubTeamsUrl').value = keyed('/teams');
    $('#pubMediaUrl').value = keyed('/media');
  }

  $('#publicHostname').addEventListener('input', updatePublicUrls);
  $('#refereeKey').addEventListener('input', updatePublicUrls);
  $('#genKeyBtn').addEventListener('click', () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters
    const rnd = new Uint32Array(12);
    crypto.getRandomValues(rnd);
    $('#refereeKey').value = Array.from(rnd, (n) => alphabet[n % alphabet.length]).join('');
    updatePublicUrls();
  });
  $('#saveInternetBtn').addEventListener('click', () => {
    fetch('/api/obs-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicHostname: $('#publicHostname').value.trim(),
        refereeKey: $('#refereeKey').value.trim(),
      }),
    })
      .then((r) => flash($('#saveInternetBtn'), r.ok ? 'Saved!' : 'Failed'))
      .catch(() => flash($('#saveInternetBtn'), 'Failed'));
  });
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copyField($('#' + b.dataset.copy), b)));

  // ---- YouTube live stream link (website menu entry) ----
  $('#saveYoutubeBtn').addEventListener('click', () => {
    fetch('/api/obs-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: $('#youtubeUrl').value.trim() }),
    })
      .then((r) => (r.ok ? fetch('/api/obs-settings').then((x) => x.json()) : Promise.reject()))
      .then((cfg) => {
        $('#youtubeUrl').value = cfg.youtubeUrl || ''; // show the normalized link (https:// added, etc.)
        flash($('#saveYoutubeBtn'), 'Saved!');
      })
      .catch(() => flash($('#saveYoutubeBtn'), 'Failed'));
  });
  $('#openYoutubeBtn').addEventListener('click', () => {
    const url = $('#youtubeUrl').value.trim();
    if (url) window.open(/^https?:\/\//i.test(url) ? url : 'https://' + url, '_blank');
  });

  fetch('/api/obs-settings')
    .then((r) => r.json())
    .then((cfg) => {
      $('#publicHostname').value = cfg.publicHostname || '';
      $('#refereeKey').value = cfg.refereeKey || '';
      $('#youtubeUrl').value = cfg.youtubeUrl || '';
      updatePublicUrls();
    })
    .catch(() => {});

  // ---- score server (desktop app only, via the WebView2 message bridge) ----
  const host = window.chrome && window.chrome.webview;
  if (host) {
    const card = $('#hostCard');
    card.hidden = false;
    const send = (msg) => host.postMessage(msg);

    host.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || m.type !== 'host') return;
      $('#hostStatus').textContent = m.status || '';
      $('#hostDot').className = 'conn-dot' + (m.kind === 'ok' ? ' connected' : '');
      $('#hostStartStop').textContent = m.running ? 'Stop' : 'Start';
      if (document.activeElement !== $('#hostPort')) $('#hostPort').value = m.port;
      $('#hostAutoStart').checked = !!m.autoStart;
      $('#hostTray').checked = !!m.minimizeToTray;
      $('#hostOverlayUrl').value = m.overlayUrl || '';
      $('#hostMobileUrl').value = m.mobileUrl || '';
    });

    $('#hostStartStop').addEventListener('click', () => send({ type: 'startStop' }));
    $('#hostPort').addEventListener('change', () => {
      const port = parseInt($('#hostPort').value, 10);
      if (port > 0 && port < 65536) send({ type: 'setPort', port });
    });
    $('#hostAutoStart').addEventListener('change', () => send({ type: 'setAutoStart', value: $('#hostAutoStart').checked }));
    $('#hostTray').addEventListener('change', () => send({ type: 'setMinimizeToTray', value: $('#hostTray').checked }));
    $('#hostOpenBtn').addEventListener('click', () => send({ type: 'openInBrowser' }));
    $('#hostReloadBtn').addEventListener('click', () => send({ type: 'reload' }));
    send({ type: 'ready' });
  }

  // ---- helpers ----
  function copyField(input, btn) {
    input.select();
    navigator.clipboard?.writeText(input.value);
    flash(btn, 'Copied!');
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }
})();

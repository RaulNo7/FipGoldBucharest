/* Control Center: menu to every page. Through the internet the control pages
   need the access key - taken from ?key=... in this page's URL, or from the
   cookie the server sets once a page was opened with the key. */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const cookieEntry = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('key='));
  let key = params.get('key') || '';
  if (!key && cookieEntry) {
    try {
      key = decodeURIComponent(cookieEntry.slice(4));
    } catch (_) {
      key = '';
    }
  }

  document.querySelectorAll('[data-keyed]').forEach((a) => {
    if (!key) return;
    const url = new URL(a.getAttribute('href'), location.origin);
    url.searchParams.set('key', key);
    a.setAttribute('href', url.pathname + url.search);
  });

  const note = document.getElementById('keyNote');
  if (note) {
    note.textContent = key
      ? 'Access key active on this device — the links below carry it.'
      : 'On the internet these pages need the access key: open this page once with ?key=… (from the Admin tab of the app). On the venue network they open directly.';
  }

  fetch('/api/state')
    .then((r) => r.json())
    .then((s) => {
      const el = document.getElementById('liveStatus');
      if (!el) return;
      el.textContent = s.status === 'live' ? 'MATCH LIVE' : s.status === 'finished' ? 'MATCH OVER' : 'STANDBY';
    })
    .catch(() => {
      const el = document.getElementById('liveStatus');
      if (el) el.textContent = 'OFFLINE';
    });
})();

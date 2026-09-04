/* Home page: live score, and a menu to every page. The control pages
   need the access key on the internet: they stay hidden until a valid key is
   known - from ?key=... in this page's URL, from the cookie of an earlier
   visit, or from the server itself (which answers only on the venue network
   or with a valid key, so the public page never reveals it). */
(function () {
  'use strict';

  const S = window.PadelScoring;
  const C = window.PadelCountries;
  const enc = encodeURIComponent;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---- mobile menu (☰) ------------------------------------------------------
  const top = $('.top');
  const menuBtn = $('#menuBtn');
  menuBtn.addEventListener('click', () => {
    const open = top.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.textContent = open ? '✕' : '☰';
  });
  document.addEventListener('click', (e) => {
    if (top.classList.contains('open') && !top.contains(e.target)) menuBtn.click();
  });

  // ---- access key -----------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const cookieEntry = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('key='));
  let cookieKey = '';
  if (cookieEntry) {
    try {
      cookieKey = decodeURIComponent(cookieEntry.slice(4));
    } catch (_) {
      cookieKey = '';
    }
  }

  const note = $('#keyNote');
  const form = $('#keyForm');
  const input = $('#keyInput');

  function applyKey(k) {
    $$('[data-keyed]').forEach((a) => {
      const url = new URL(a.getAttribute('href'), location.origin);
      if (k) url.searchParams.set('key', k);
      else url.searchParams.delete('key');
      a.setAttribute('href', url.pathname + url.search);
    });
    $$('.needs-key').forEach((el) => {
      el.hidden = !k;
    });
    $('#unlockSection').hidden = !!k;
  }

  /** Ask the server for the real key: 200 only on the venue network or with a valid key. */
  function verify(candidate) {
    return fetch('/api/obs-settings' + (candidate ? '?key=' + enc(candidate) : ''))
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => (cfg && cfg.refereeKey ? cfg.refereeKey : cfg ? '' : null))
      .catch(() => null);
  }

  const initial = params.get('key') || cookieKey;
  applyKey(initial);
  verify(initial).then((serverKey) => {
    if (serverKey === null) {
      if (initial) document.cookie = 'key=; Path=/; Max-Age=0'; // wrong or stale key: forget it
      applyKey('');
    } else if (serverKey) {
      applyKey(serverKey);
    }
  });

  $('#unlockLink').addEventListener('click', (e) => {
    e.preventDefault();
    form.hidden = false;
    input.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const candidate = (input.value || '').trim();
    if (!candidate) return;
    verify(candidate).then((serverKey) => {
      if (serverKey) {
        applyKey(serverKey); // the keyed request above also set the key cookie
      } else {
        note.hidden = false;
        note.textContent = 'That key is not accepted — check it on the Admin tab of the app.';
        input.select();
      }
    });
  });

  // ---- live score + links ---------------------------------------------------
  PadelClient.connect({
    onState: (s, msg) => {
      renderScore(s);
      applyLinks(msg && msg.obs);
    },
  });

  /** "YouTube Live" menu entry + hero tile: shown only while a stream link is set on the Admin tab. */
  function applyLinks(obs) {
    const url = (obs && obs.youtubeUrl) || '';
    [$('#youtubeLink'), $('#youtubeFact')].forEach((a) => {
      a.hidden = !url;
      a.href = url || '#';
    });
  }

  function renderScore(s) {
    const box = $('#score');
    box.innerHTML = '';
    const hasTeams = (s.teams || []).some((t) => t && t.teamId);
    if (!hasTeams && s.status !== 'live') {
      box.innerHTML = '<div class="score-empty">No match in progress</div>';
      return;
    }

    const finished = s.status === 'finished';
    for (let t = 0; t < 2; t++) {
      const team = s.teams[t] || {};
      const block = document.createElement('div');
      block.className = 'score-block';

      const rows = document.createElement('div');
      rows.className = 'score-rows';
      for (let p = 0; p < 2; p++) {
        const player = (team.players || [])[p];
        const row = document.createElement('div');
        row.className = 'score-row';
        const flag = document.createElement('span');
        flag.className = 'score-flag';
        const url = C.flagUrl(C.playerCountry(player));
        if (url) flag.style.backgroundImage = `url('${url}')`;
        const name = document.createElement('span');
        name.className = 'score-name';
        name.textContent = C.shortName(C.playerName(player));
        const dot = document.createElement('span');
        dot.className = 'score-dot' + (!finished && s.server === t && (s.servingPlayer || 0) === p ? ' active' : '');
        row.append(flag, name, dot);
        rows.appendChild(row);
      }

      const cols = document.createElement('div');
      cols.className = 'score-cols';
      (s.sets || []).forEach((set) => {
        const cell = document.createElement('span');
        cell.className = 'score-set';
        cell.textContent = t === 0 ? set.a : set.b;
        cols.appendChild(cell);
      });
      if (!finished) {
        const games = document.createElement('span');
        games.className = 'score-games';
        games.textContent = s.games[t];
        const points = document.createElement('span');
        points.className = 'score-points';
        points.textContent = s.inTiebreak ? s.points[t] : S.pointLabel(s.points, t, s.config);
        cols.append(games, points);
      }

      block.append(rows, cols);
      box.appendChild(block);
    }

    if (finished && s.winner != null) {
      const w = s.teams[s.winner] || {};
      const names = (w.players || []).map((p) => C.shortName(C.playerName(p))).filter(Boolean).join(' / ');
      const line = document.createElement('div');
      line.className = 'score-winner';
      line.textContent = (names || 'Winner') + ' win';
      box.appendChild(line);
    }
  }
})();

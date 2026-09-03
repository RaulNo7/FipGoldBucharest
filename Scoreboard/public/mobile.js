/* Referee remote: live score, scoring, manual adjust and serve control. */
(function () {
  'use strict';

  const S = window.PadelScoring;
  const C = window.PadelCountries;
  let state = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const teamLabel = (t) =>
    (t && t.name) ||
    ((t && t.players) || []).map((p) => C.shortName(C.playerName(p))).filter(Boolean).join(' / ') ||
    '';

  // ---- connection ----
  const client = PadelClient.connect({
    onState: (s) => {
      state = s;
      render(s);
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });

  function send(obj) {
    client.send(obj);
  }

  // ---- scoring ----
  $$('[data-point]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'point', team: +b.dataset.point }))
  );
  $$('[data-unpoint]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'adjustPoints', team: +b.dataset.unpoint, delta: -1 }))
  );
  $('#undoBtn').addEventListener('click', () => send({ type: 'undo' }));
  $('#redoBtn').addEventListener('click', () => send({ type: 'redo' }));
  $('#swapServeBtn').addEventListener('click', () => send({ type: 'swapServer' }));
  $('#startBtn').addEventListener('click', () => send({ type: 'startMatch' }));

  // ---- manual adjust ----
  $$('[data-games-inc]').forEach((b) => b.addEventListener('click', () => send({ type: 'adjustGames', team: +b.dataset.gamesInc, delta: 1 })));
  $$('[data-games-dec]').forEach((b) => b.addEventListener('click', () => send({ type: 'adjustGames', team: +b.dataset.gamesDec, delta: -1 })));
  $$('[data-sets-inc]').forEach((b) => b.addEventListener('click', () => send({ type: 'adjustSets', team: +b.dataset.setsInc, delta: 1 })));
  $$('[data-sets-dec]').forEach((b) => b.addEventListener('click', () => send({ type: 'adjustSets', team: +b.dataset.setsDec, delta: -1 })));
  $$('[data-serve-pick]').forEach((b) => b.addEventListener('click', () => send({ type: 'setServer', team: +b.dataset.servePick })));
  $('#saveSetBtn').addEventListener('click', () => send({ type: 'saveSet' }));
  $('#undoSetBtn').addEventListener('click', () => send({ type: 'removeLastSet' }));

  // ---- serving player (which partner of which team) ----
  $$('[data-serve-player]').forEach((b) =>
    b.addEventListener('click', () => {
      const [team, player] = b.dataset.servePlayer.split('-').map(Number);
      if (!state || state.server !== team) send({ type: 'setServer', team });
      send({ type: 'setServingPlayer', player });
    })
  );

  // ---- render ----
  function render(s) {
    const badge = $('#statusBadge');
    badge.textContent = s.status;
    badge.className = 'badge ' + (s.status === 'live' ? 'live' : s.status === 'finished' ? 'finished' : '');

    for (let i = 0; i < 2; i++) {
      $(`[data-sname="${i}"]`).textContent = teamLabel(s.teams[i]);
      $(`[data-cdot="${i}"]`).style.background = s.teams[i].color || '#2E6CA4';
      $(`[data-acol="${i}"]`).textContent = teamLabel(s.teams[i]);
      $(`[data-games-val="${i}"]`).textContent = s.games[i];
      $(`[data-sets-val="${i}"]`).textContent = s.setsWon[i];
      $(`[data-serve-pick="${i}"]`).classList.toggle('active', s.server === i);

      for (let p = 0; p < 2; p++) {
        const btn = $(`[data-serve-player="${i}-${p}"]`);
        const player = (s.teams[i].players || [])[p];
        const name = C.shortName(C.playerName(player));
        btn.textContent = name || 'P' + (p + 1);
        btn.classList.toggle('active', s.server === i && (s.servingPlayer || 0) === p);
      }
    }

    renderPreview(s);
  }

  function renderPreview(s) {
    const pv = $('#preview');
    pv.innerHTML = '';
    for (let t = 0; t < 2; t++) {
      const block = document.createElement('div');
      block.className = 'pv-block';

      const rows = document.createElement('div');
      rows.className = 'pv-rows';
      for (let p = 0; p < 2; p++) {
        const player = (s.teams[t].players || [])[p];
        const row = document.createElement('div');
        row.className = 'pv-prow';

        const flag = document.createElement('span');
        flag.className = 'pv-flag';
        const url = C.flagUrl(C.playerCountry(player));
        if (url) flag.style.backgroundImage = `url('${url}')`;

        const nm = document.createElement('span');
        nm.className = 'pv-pname';
        nm.textContent = C.shortName(C.playerName(player));

        const dot = document.createElement('span');
        dot.className =
          'pv-dot' +
          (s.server === t && (s.servingPlayer || 0) === p && s.status !== 'finished' ? ' active' : '');

        row.append(flag, nm, dot);
        rows.appendChild(row);
      }

      const cols = document.createElement('div');
      cols.className = 'pv-cols';

      const sets = document.createElement('span');
      sets.className = 'pv-sets';
      s.sets.forEach((set) => {
        const sb = document.createElement('span');
        sb.className = 'pv-set';
        sb.textContent = t === 0 ? set.a : set.b;
        sets.appendChild(sb);
      });

      const games = document.createElement('span');
      games.className = 'pv-games';
      games.textContent = s.games[t];

      const points = document.createElement('span');
      points.className = 'pv-points';
      points.textContent = s.inTiebreak ? s.points[t] : S.pointLabel(s.points, t, s.config);

      cols.append(sets);
      if (s.status !== 'finished') cols.append(games, points);
      block.append(rows, cols);
      pv.appendChild(block);
    }
  }
})();

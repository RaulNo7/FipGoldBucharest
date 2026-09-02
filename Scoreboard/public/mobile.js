/* Referee remote: live score, scoring, manual adjust and serve control. */
(function () {
  'use strict';

  const S = window.PadelScoring;
  const C = window.PadelCountries;
  let state = null;
  let latestObs = null; // transient OBS/break status from the state broadcasts

  // The desktop app's Home tab embeds this page with ?operator=1 to unlock
  // the Broadcast card; the referee's phone uses the plain /mobile URL.
  const operatorMode = new URLSearchParams(location.search).has('operator');

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const teamLabel = (t) =>
    (t && t.name) ||
    ((t && t.players) || []).map((p) => C.shortName(C.playerName(p))).filter(Boolean).join(' / ') ||
    '';

  // ---- connection ----
  const client = PadelClient.connect({
    onState: (s, msg) => {
      state = s;
      if (msg && msg.obs) latestObs = msg.obs;
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

  // ---- broadcast controls (operator mode only) ----
  if (operatorMode) {
    $('#broadcastCard').hidden = false;

    $('#introBtn').addEventListener('click', () => {
      const visible = !!(state && state.display && state.display.introVisible);
      send({ type: 'setDisplay', display: { introVisible: !visible } });
    });
    $('#toggleScoreBtn').addEventListener('click', () => {
      const visible = !state || !state.display || state.display.scoreVisible !== false;
      send({ type: 'setDisplay', display: { scoreVisible: !visible } });
    });
    $('#playAdsBtn').addEventListener('click', () => {
      if (confirm('Switch the stream to the commercials now?')) send({ type: 'playCommercials' });
    });
    $('#cancelAdsBtn').addEventListener('click', () => send({ type: 'cancelCommercials' }));

    // Live countdown tick between state broadcasts.
    setInterval(() => {
      if (state) renderBroadcast(state);
    }, 500);
  }

  function renderBroadcast(s) {
    const introOn = !!(s.display && s.display.introVisible);
    const introBtn = $('#introBtn');
    introBtn.textContent = introOn ? '👥 Hide players' : '👥 Show players';
    introBtn.classList.toggle('active', introOn);

    $('#toggleScoreBtn').textContent =
      s.display && s.display.scoreVisible === false ? 'Show score' : 'Hide score';

    const o = latestObs;
    if (!o) return;
    const badge = $('#obsBadge');
    badge.textContent = o.connected ? 'OBS: connected' : 'OBS: offline';
    badge.className = 'badge ' + (o.connected ? 'live' : '');
    $('#cancelAdsBtn').disabled = o.phase === 'idle';

    let text = '';
    if (o.phase === 'countdown') {
      text = `Commercials start in ${Math.max(0, Math.ceil((o.countdownEndsAt - Date.now()) / 1000))}s — Cancel to abort.`;
    } else if (o.phase === 'running') {
      text = 'Commercials are playing on the stream…';
    }
    if (o.lastError) text += (text ? ' — ' : '') + 'error: ' + o.lastError;
    const status = $('#breakStatus');
    status.textContent = text;
    status.hidden = !text;
  }

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

    if (operatorMode) renderBroadcast(s);
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

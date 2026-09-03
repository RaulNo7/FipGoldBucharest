/* Overlay renderer. Reads state pushed over WebSocket and paints the board:
   4 player rows (flag + name + serve dot) and per-team-block score columns
   (blue = completed sets, gold = current-set games, white = points). */
(function () {
  'use strict';

  const S = window.PadelScoring;
  const C = window.PadelCountries;
  // The /tv court page reuses this renderer (via <body data-tv="1">); unlike the
  // broadcast overlay it never hides during commercial breaks.
  const tvMode = document.body.dataset.tv === '1';
  const root = document.getElementById('scoreboard');
  const titleBar = document.getElementById('titleBar');
  const titleEl = document.getElementById('title');
  const subtitleEl = document.getElementById('subtitle');
  const winnerBanner = document.getElementById('winnerBanner');

  const el = {
    flag: [
      [q('[data-flag="0-0"]'), q('[data-flag="0-1"]')],
      [q('[data-flag="1-0"]'), q('[data-flag="1-1"]')],
    ],
    pname: [
      [q('[data-pname="0-0"]'), q('[data-pname="0-1"]')],
      [q('[data-pname="1-0"]'), q('[data-pname="1-1"]')],
    ],
    serve: [
      [q('[data-serve="0-0"]'), q('[data-serve="0-1"]')],
      [q('[data-serve="1-0"]'), q('[data-serve="1-1"]')],
    ],
    sets: [q('[data-sets="0"]'), q('[data-sets="1"]')],
    games: [q('[data-games="0"]'), q('[data-games="1"]')],
    points: [q('[data-points="0"]'), q('[data-points="1"]')],
  };

  function q(sel) {
    return document.querySelector(sel);
  }

  // Optional position/scale override via query string, e.g. ?pos=bottom-right&scale=1.2
  // (the /tv page has its own full-screen layout and ignores it).
  if (!tvMode) applyPositionFromQuery();

  let lastSeq = -1;

  PadelClient.connect({
    onState: render,
  });

  function render(state) {
    const d = state.display || {};
    const finished = state.status === 'finished';

    // A finished match shows only the completed sets — no next-set/points cells.
    root.classList.toggle('finished', finished);

    // Title bar
    const hasTitle = d.showTitle !== false && (d.title || d.subtitle);
    titleBar.classList.toggle('empty', !hasTitle);
    titleEl.textContent = d.title || '';
    subtitleEl.textContent = d.subtitle || '';

    for (let t = 0; t < 2; t++) {
      const team = state.teams[t] || {};
      const players = team.players || [];

      for (let p = 0; p < 2; p++) {
        const player = players[p];
        el.pname[t][p].textContent = C.shortName(C.playerName(player));

        const url = C.flagUrl(C.playerCountry(player));
        el.flag[t][p].style.backgroundImage = url ? `url('${url}')` : 'none';

        const serving =
          d.showServe !== false &&
          state.status !== 'finished' &&
          state.server === t &&
          (state.servingPlayer || 0) === p;
        el.serve[t][p].classList.toggle('active', serving);
      }

      // Completed sets (blue columns)
      el.sets[t].classList.toggle('hidden', d.showSets === false);
      renderSets(el.sets[t], state, t);

      // Current-set games (gold column)
      el.games[t].textContent = state.games[t];

      // Current points / tiebreak points (white column)
      const label = pointDisplay(state, t);
      el.points[t].textContent = label;
      el.points[t].classList.toggle('ad', /^Ad/.test(label));
      el.points[t].classList.toggle('deuce', /^D\d/.test(label));
      el.points[t].classList.toggle('gp', label === 'SP');
    }

    // Winner banner
    if (state.status === 'finished' && state.winner != null) {
      const w = state.teams[state.winner] || {};
      const names = (w.players || [])
        .map((p) => C.shortName(C.playerName(p)))
        .filter(Boolean);
      winnerBanner.textContent = (names.join(' / ') || 'Winner') + ' win!';
      winnerBanner.classList.remove('hidden');
    } else {
      winnerBanner.classList.add('hidden');
    }

    // Bump animation on the scoring side when a point changes.
    if (state.seq !== lastSeq) {
      if (state.lastScorer != null && lastSeq !== -1) {
        const cell = el.points[state.lastScorer];
        cell.classList.remove('bump');
        void cell.offsetWidth; // reflow to restart animation
        cell.classList.add('bump');
      }
      lastSeq = state.seq;
    }

    // During a commercial break the broadcast overlay hides itself; /tv keeps showing.
    root.classList.toggle('hidden', !tvMode && d.scoreVisible === false);
  }

  function renderSets(container, state, teamIdx) {
    container.innerHTML = '';
    state.sets.forEach((set) => {
      const cell = document.createElement('span');
      cell.className = 'set-cell';
      cell.textContent = teamIdx === 0 ? set.a : set.b;
      if (set.tb && !set.superTb) {
        const tb = document.createElement('span');
        tb.className = 'tb';
        tb.textContent = teamIdx === 0 ? set.tb.a : set.tb.b;
        cell.appendChild(tb);
      }
      container.appendChild(cell);
    });
  }

  function pointDisplay(state, idx) {
    if (state.inTiebreak) {
      return String(state.points[idx]);
    }
    return S.pointLabel(state.points, idx, state.config);
  }

  function applyPositionFromQuery() {
    const params = new URLSearchParams(location.search);
    const pos = params.get('pos') || 'top-left'; // default position
    const map = {
      'bottom-left': { left: '40px', bottom: '40px', right: 'auto', top: 'auto' },
      'bottom-right': { right: '40px', bottom: '40px', left: 'auto', top: 'auto' },
      'top-left': { left: '40px', top: '40px', right: 'auto', bottom: 'auto' },
      'top-right': { right: '40px', top: '40px', left: 'auto', bottom: 'auto' },
      'bottom-center': { left: '50%', bottom: '40px', transform: 'translateX(-50%)', right: 'auto', top: 'auto' },
      'top-center': { left: '50%', top: '40px', transform: 'translateX(-50%)', right: 'auto', bottom: 'auto' },
    };
    const style = map[pos];
    if (style) Object.assign(root.style, style);

    const scale = params.get('scale');
    if (scale) {
      const vertical = pos.includes('top') ? 'top' : 'bottom';
      const horizontal = pos.includes('right') ? 'right' : pos.includes('center') ? 'center' : 'left';
      root.style.transformOrigin = `${vertical} ${horizontal}`;
      root.style.transform = `${style && style.transform ? style.transform + ' ' : ''}scale(${scale})`;
    }
  }
})();

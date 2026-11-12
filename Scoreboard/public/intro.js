/* Players-intro renderer: shows the current match's four players (with flags)
   under the tournament header whenever display.introVisible is true. */
(function () {
  'use strict';

  const C = window.PadelCountries;
  const root = document.getElementById('intro');
  const titleEl = document.getElementById('introTitle');
  const subtitleEl = document.getElementById('introSubtitle');
  const startEl = document.getElementById('introStart');

  const q = (sel) => document.querySelector(sel);
  const el = {
    flag: [
      [q('[data-flag="0-0"]'), q('[data-flag="0-1"]')],
      [q('[data-flag="1-0"]'), q('[data-flag="1-1"]')],
    ],
    pname: [
      [q('[data-pname="0-0"]'), q('[data-pname="0-1"]')],
      [q('[data-pname="1-0"]'), q('[data-pname="1-1"]')],
    ],
  };

  // Optional fine-tuning from the OBS URL, e.g. /intro?scale=0.8
  const scale = parseFloat(new URLSearchParams(location.search).get('scale'));
  if (scale > 0) root.style.transform = `translate(-50%, -50%) scale(${scale})`;

  PadelClient.connect({ onState: render });

  function render(state, msg) {
    const d = state.display || {};

    // No title set on Score settings: the imported tournament's name, else the channel name.
    const roster = (msg && msg.roster) || {};
    titleEl.textContent = d.title || (roster.shortName || roster.tournament || 'FRP broadcasting').toUpperCase();
    subtitleEl.textContent = d.subtitle || '';
    subtitleEl.hidden = !d.subtitle;

    // Scheduled start (set on the Score settings tab), e.g. "START 14:30"
    const start = String(d.startTime || '').trim();
    startEl.textContent = start ? `Start ${start}` : '';
    startEl.hidden = !start;

    for (let t = 0; t < 2; t++) {
      const players = (state.teams[t] || {}).players || [];
      for (let p = 0; p < 2; p++) {
        const player = players[p];
        el.pname[t][p].textContent = C.shortName(C.playerName(player));
        const url = C.flagUrl(C.playerCountry(player));
        el.flag[t][p].style.backgroundImage = url ? `url('${url}')` : 'none';
      }
    }

    root.classList.toggle('hidden', d.introVisible !== true);
  }
})();

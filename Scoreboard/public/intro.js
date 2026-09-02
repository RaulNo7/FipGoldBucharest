/* Players-intro renderer: shows the current match's four players (with flags)
   under the tournament header whenever display.introVisible is true. */
(function () {
  'use strict';

  const C = window.PadelCountries;
  const root = document.getElementById('intro');
  const titleEl = document.getElementById('introTitle');
  const subtitleEl = document.getElementById('introSubtitle');

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

  function render(state) {
    const d = state.display || {};

    titleEl.textContent = d.title || 'FIP GOLD BUCHAREST 2026';
    subtitleEl.textContent = d.subtitle || '';
    subtitleEl.hidden = !d.subtitle;

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

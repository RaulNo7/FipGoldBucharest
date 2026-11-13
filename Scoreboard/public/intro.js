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

  PadelClient.connect({ onState: render, reloadOnUpdate: true });

  function render(state, msg) {
    const d = state.display || {};

    // No title set on Score settings: the imported tournament's name, else the channel name.
    const roster = (msg && msg.roster) || {};
    titleEl.textContent = d.title || (roster.shortName || roster.tournament || 'FRP Live').toUpperCase();
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

    renderCard(d.playerCard, d.playerCardSide, (msg && msg.cards) || {}, roster);
  }

  // ---- one player's card ----
  const pc = document.getElementById('pcard');
  const $id = (id) => document.getElementById(id);
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const fmt = (n, decimals) =>
    n == null || !isFinite(n) ? '–' : Number(n).toLocaleString('ro-RO', { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 });
  const SIDE = { stânga: '◀ Stânga', dreapta: 'Dreapta ▶', ambele: '◀ Ambele ▶' };

  function fitCard() {
    const k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) * (scale > 0 ? scale : 1);
    pc.style.setProperty('--pc-scale', String(k || 1));
  }
  window.addEventListener('resize', fitCard);
  fitCard();

  function renderCard(key, side, cards, roster) {
    const card = key ? cards[key] : null;
    if (!card) {
      pc.classList.add('hidden'); // keeps the last content while it fades out
      return;
    }
    // left or right edge of the frame (the player stays visible on the other half)
    pc.classList.toggle("side-right", side === "right");
    const p = card.profile || null;
    pc.classList.toggle('no-data', !p);

    $id('pcTournament').textContent = (roster.shortName || roster.tournament || '').toUpperCase();
    $id('pcDivision').textContent = card.division || '';
    $id('pcDivSep').hidden = !card.division;

    // name: last word in gold ("NEDELCU HORIA")
    const full = String((p && p.name) || card.name || '').trim();
    const words = full.split(/\s+/);
    const nameEl = $id('pcName');
    nameEl.replaceChildren(document.createTextNode(words.slice(0, -1).join(' ') + (words.length > 1 ? ' ' : '')), make('span', null, words[words.length - 1] || ''));
    nameEl.classList.toggle('long', full.length > 15 && full.length <= 24);
    nameEl.classList.toggle('xlong', full.length > 24);

    // photo or initials, flag
    const photo = $id('pcPhoto');
    const initials = $id('pcInitials');
    if (p && p.photo) {
      if (photo.getAttribute('src') !== p.photo) photo.src = p.photo;
      photo.hidden = false;
      initials.hidden = true;
    } else {
      photo.hidden = true;
      photo.removeAttribute('src');
      initials.hidden = false;
      initials.textContent = words.filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    }
    const country = (card.country || (p && p.country) || '').toLowerCase();
    const flagUrl = C.flagUrl(country);
    const dot = $id('pcFlagDot');
    dot.style.backgroundImage = flagUrl ? `url('${flagUrl}')` : 'none';
    dot.classList.toggle('none', !flagUrl);

    // facts line
    const facts = $id('pcFacts');
    facts.replaceChildren();
    if (p) {
      if (p.nationality) {
        const nat = make('span', 'nat');
        const fl = make('i');
        const nf = C.flagUrl(String(p.country || country).toLowerCase());
        if (nf) fl.style.backgroundImage = `url('${nf}')`;
        nat.append(fl, make('b', null, p.nationality));
        facts.appendChild(nat);
      }
      if (p.county) {
        const ct = make('span');
        ct.append('Județ ', make('b', null, p.county));
        facts.appendChild(ct);
      }
      if (p.age) {
        const a = make('span');
        a.append(make('b', null, String(p.age)), ' ani');
        facts.appendChild(a);
      }
      if (p.side) {
        const sd = make('span');
        sd.append('Joacă pe ', make('b', null, SIDE[p.side.toLowerCase()] || p.side));
        facts.appendChild(sd);
      }
      if (p.club) {
        const cl = make('span');
        cl.append('Club ', make('b', null, p.club));
        facts.appendChild(cl);
      }
    }

    // category ranks: this match's division first, at most 3
    const ranks = $id('pcRanks');
    ranks.replaceChildren();
    const list = ((p && p.rankings) || []).slice();
    list.sort((x, y) => (y.category === card.division) - (x.category === card.division));
    list.slice(0, 3).forEach((r) => {
      const chip = make('div', 'pc-rank');
      chip.append(make('b', null, '#' + r.rank), ' ' + r.category + ' ', make('small', null, r.points != null ? fmt(r.points) + ' pts' : ''));
      ranks.appendChild(chip);
    });

    if (!p) {
      pc.classList.remove('hidden');
      return;
    }

    // big numbers
    $id('pcPoints').textContent = fmt(p.points);
    $id('pcLevel').textContent = p.level != null ? fmt(p.level, 2) : '–';
    $id('pcTier').textContent = p.tier || '';
    $id('pcWinRate').textContent = p.winRate != null ? p.winRate + '%' : '–';

    // strip
    $id('pcTournaments').textContent = fmt(p.tournaments);
    const wl = $id('pcWL');
    wl.replaceChildren(document.createTextNode(`${fmt(p.wins)} – ${fmt(p.losses)}`));
    const wo = [p.winsWo ? `+${p.winsWo} V prin WO` : '', p.lossesWo ? `+${p.lossesWo} Î prin WO` : ''].filter(Boolean).join(' · ');
    if (wo) wl.appendChild(make('small', null, wo));
    const medals = $id('pcTitles');
    medals.replaceChildren();
    const t = p.titles || {};
    [['#f5c542', t.gold], ['#c9d1db', t.silver], ['#cd7f45', t.bronze]].forEach(([color, n]) => {
      const m = make('span');
      const dotEl = make('i');
      dotEl.style.background = color;
      m.append(dotEl, String(n || 0));
      medals.appendChild(m);
    });
    $id('pcSets').textContent = p.setWinRate != null ? p.setWinRate + '%' : '–';
    $id('pcSetsLabel').textContent = p.setsWon != null ? `Seturi câștigate · ${p.setsWon}–${p.setsLost}` : 'Seturi câștigate';
    const form = $id('pcForm');
    form.replaceChildren(...(p.form || []).slice(0, 10).map((r) => make('i', r === 'L' ? 'l' : '', r === 'L' ? 'Î' : 'V')));
    $id('pcFormLabel').textContent = `Formă · ultimele ${Math.min(10, (p.form || []).length) || 10}`;

    pc.classList.remove('hidden');
  }
})();

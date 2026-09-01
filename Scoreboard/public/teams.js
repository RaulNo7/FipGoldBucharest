/* Teams management: the full entry list with live Active/Eliminated toggles. */
(function () {
  'use strict';

  const C = window.PadelCountries;
  let state = null;
  let roster = null; // { tournament, teams } from /api/teams

  const $ = (sel) => document.querySelector(sel);

  const client = PadelClient.connect({
    onState: (s) => {
      state = s;
      renderAll();
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });

  fetch('/api/teams')
    .then((r) => r.json())
    .then((data) => {
      roster = data;
      renderAll();
    })
    .catch(() => {
      $('#menList').textContent = 'Could not load the entry list (data/teams.json).';
    });

  function isActive(t) {
    const reg = state && state.teams_registry;
    if (reg && reg[t.id]) return reg[t.id].active !== false;
    return t.active !== false;
  }

  function renderAll() {
    if (!roster) return;
    renderCategory('men', $('#menList'), $('#menCount'));
    renderCategory('women', $('#womenList'), $('#womenCount'));
  }

  function renderCategory(category, container, countEl) {
    const teams = roster.teams.filter((t) => t.category === category);
    const activeCount = teams.filter(isActive).length;
    countEl.textContent = activeCount + ' / ' + teams.length + ' active';

    container.innerHTML = '';
    for (const section of ['main_draw', 'qualifying']) {
      const group = teams
        .filter((t) => t.section === section)
        .sort((a, b) => a.position - b.position);
      if (!group.length) continue;

      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = section === 'main_draw' ? 'Main draw' : 'Qualifying';
      container.appendChild(h);

      group.forEach((t) => container.appendChild(teamRow(t)));
    }
  }

  function teamRow(t) {
    const active = isActive(t);

    const row = document.createElement('div');
    row.className = 'roster-row' + (active ? '' : ' eliminated');

    const pos = document.createElement('span');
    pos.className = 'roster-pos';
    pos.textContent = t.position;

    const playersBox = document.createElement('div');
    playersBox.className = 'roster-players';
    (t.players || []).forEach((p) => {
      const pr = document.createElement('div');
      pr.className = 'rp-row';

      const flag = document.createElement('span');
      flag.className = 'rp-flag';
      const url = C.flagUrl(p.country);
      if (url) flag.style.backgroundImage = `url('${url}')`;

      const nm = document.createElement('span');
      nm.className = 'rp-name';
      nm.textContent = p.name;

      const cc = document.createElement('span');
      cc.className = 'rp-cc';
      cc.textContent = p.country;

      pr.append(flag, nm, cc);
      playersBox.appendChild(pr);
    });

    const badges = document.createElement('span');
    badges.className = 'roster-badges';
    if (t.wildcard) {
      const wc = document.createElement('span');
      wc.className = 'wc-badge';
      wc.textContent = 'WC';
      badges.appendChild(wc);
    }

    const btn = document.createElement('button');
    btn.className = 'btn toggle ' + (active ? 'is-active' : 'is-out');
    btn.textContent = active ? 'Active' : 'Eliminated';
    btn.title = active ? 'Click to mark as eliminated' : 'Click to reactivate';
    btn.addEventListener('click', () =>
      client.send({ type: 'setTeamActive', teamId: t.id, active: !isActive(t) })
    );

    row.append(pos, playersBox, badges, btn);
    return row;
  }
})();

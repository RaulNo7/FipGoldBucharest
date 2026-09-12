/* Teams management: the full entry list with live Active/Eliminated toggles. */
(function () {
  'use strict';

  const C = window.PadelCountries;
  let state = null;
  let roster = null; // { tournament, teams } from /api/teams

  const $ = (sel) => document.querySelector(sel);

  let editing = null; // { teamId, player } while a name input is open
  let renderPending = false;

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

  /** Live name (registry correction) or the entry-list name. */
  function playerName(t, i) {
    const reg = state && state.teams_registry;
    const names = reg && reg[t.id] && reg[t.id].names;
    const p = (t.players || [])[i] || {};
    return (names && names[i]) || p.originalName || p.name || '';
  }

  /** Live country code (registry correction) or the entry-list code. */
  function playerCountry(t, i) {
    const reg = state && state.teams_registry;
    const codes = reg && reg[t.id] && reg[t.id].countries;
    const p = (t.players || [])[i] || {};
    return (codes && codes[i]) || p.originalCountry || p.country || '';
  }

  function isEdited(t, i) {
    const p = (t.players || [])[i] || {};
    return playerName(t, i) !== (p.originalName || p.name || '') || playerCountry(t, i) !== (p.originalCountry || p.country || '');
  }

  // Known country codes for the code editor's suggestions.
  const ccList = document.createElement('datalist');
  ccList.id = 'ccList';
  Object.keys(C.ISO3_TO_ISO2 || {}).sort().forEach((code) => {
    const o = document.createElement('option');
    o.value = code;
    ccList.appendChild(o);
  });
  document.body.appendChild(ccList);

  function startCountryEdit(t, i, ccEl) {
    if (editing) return;
    editing = { teamId: t.id, player: i, field: 'country' };
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rp-cc-input';
    input.maxLength = 3;
    input.setAttribute('list', 'ccList');
    input.setAttribute('aria-label', 'Country code (3 letters)');
    input.value = playerCountry(t, i);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim().toUpperCase();
      if (save && /^[A-Z]{3}$/.test(value) && value !== playerCountry(t, i)) {
        client.send({ type: 'setPlayerCountry', teamId: t.id, player: i, country: value });
        ccEl.textContent = value;
      }
      input.replaceWith(ccEl);
      endEdit();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    ccEl.replaceWith(input);
    input.focus();
    input.select();
  }

  function renderAll() {
    if (!roster) return;
    if (editing) {
      renderPending = true; // keep the open input; redraw when the edit ends
      return;
    }
    renderPending = false;
    renderCategory('men', $('#menList'), $('#menCount'));
    renderCategory('women', $('#womenList'), $('#womenCount'));
  }

  function endEdit() {
    editing = null;
    if (renderPending) renderAll();
  }

  function startEdit(t, i, nameEl) {
    if (editing) return;
    editing = { teamId: t.id, player: i };
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rp-input';
    input.maxLength = 60;
    input.value = playerName(t, i);
    input.setAttribute('aria-label', 'Player name');
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.replace(/\s+/g, ' ').trim();
      if (save && value && value !== playerName(t, i)) {
        client.send({ type: 'setPlayerName', teamId: t.id, player: i, name: value });
        nameEl.textContent = value; // instant feedback; the state broadcast confirms it
      }
      input.replaceWith(nameEl);
      endEdit();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    nameEl.replaceWith(input);
    input.focus();
    input.select();
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
    (t.players || []).forEach((p, i) => {
      const pr = document.createElement('div');
      pr.className = 'rp-row';

      const country = playerCountry(t, i);
      const flag = document.createElement('span');
      flag.className = 'rp-flag';
      const url = C.flagUrl(country);
      if (url) flag.style.backgroundImage = `url('${url}')`;

      const edited = isEdited(t, i);
      const origName = p.originalName || p.name || '';
      const origCountry = p.originalCountry || p.country || '';
      const nm = document.createElement('span');
      nm.className = 'rp-name' + (playerName(t, i) !== origName ? ' edited' : '');
      nm.textContent = playerName(t, i);
      nm.title = edited ? `Entry list: ${origName} (${origCountry})` : 'Click to edit the name';
      nm.addEventListener('click', () => startEdit(t, i, nm));

      const cc = document.createElement('span');
      cc.className = 'rp-cc' + (country !== origCountry ? ' edited' : '');
      cc.textContent = country;
      cc.title = 'Click to change the country (3-letter code, e.g. POL)';
      cc.addEventListener('click', () => startCountryEdit(t, i, cc));

      const edit = document.createElement('button');
      edit.className = 'rp-edit';
      edit.type = 'button';
      edit.textContent = '✎';
      edit.title = 'Edit the name';
      edit.addEventListener('click', () => startEdit(t, i, nm));

      pr.append(flag, nm, cc, edit);

      if (edited) {
        const reset = document.createElement('button');
        reset.className = 'rp-edit rp-reset';
        reset.type = 'button';
        reset.textContent = '↺';
        reset.title = `Restore the entry-list data: ${origName} (${origCountry})`;
        reset.addEventListener('click', () => {
          client.send({ type: 'setPlayerName', teamId: t.id, player: i, name: '' });
          client.send({ type: 'setPlayerCountry', teamId: t.id, player: i, country: '' });
        });
        pr.appendChild(reset);
      }
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

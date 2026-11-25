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
    onState: (s, msg) => {
      state = s;
      // An import changed the roster: reload it.
      if (msg && msg.roster && rosterRev !== null && msg.roster.rev !== rosterRev) loadRoster();
      if (msg && msg.roster) rosterRev = msg.roster.rev;
      renderAll();
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });

  let rosterRev = null;
  function loadRoster() {
    fetch('/api/teams')
      .then((r) => r.json())
      .then((data) => {
        roster = data;
        renderAll();
      })
      .catch(() => {
        $('#rosterCards').textContent = 'Could not load the teams list.';
      });
  }
  loadRoster();

  // ---- padeltour.ro profiles (player cards) ----
  const profStatus = (text, warn) => {
    const el = $('#profilesStatus');
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  };
  const shortDate = (iso) =>
    new Date(iso).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function refreshProfiles(teamIds, btn) {
    const ids = teamIds.filter(Boolean);
    if (!ids.length) {
      profStatus('No pairs are picked for the current match yet (Score settings tab).', true);
      return;
    }
    const buttons = document.querySelectorAll('#refreshMatchBtn, .prof-refresh');
    buttons.forEach((b) => (b.disabled = true));
    if (btn) btn.classList.add('is-playing');
    profStatus(`Reading ${ids.length * 2} profiles from padeltour.ro…`);
    fetch('/api/profiles/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamIds: ids }) })
      .then((r) => (r.status === 404 ? Promise.reject(new Error('only inside the app / on the venue network')) : r.json()))
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'failed');
        const bad = r.results.filter((x) => !x.ok);
        const good = r.results.length - bad.length;
        profStatus(
          `✓ ${good} of ${r.results.length} profiles read.` + (bad.length ? ' Not read: ' + bad.map((x) => `${x.name} (${x.error})`).join(', ') : ''),
          bad.length > 0
        );
        loadRoster();
      })
      .catch((err) => profStatus('✗ ' + err.message, true))
      .finally(() => {
        buttons.forEach((b) => (b.disabled = false));
        if (btn) btn.classList.remove('is-playing');
      });
  }
  $('#refreshMatchBtn').addEventListener('click', (e) =>
    refreshProfiles(state ? [0, 1].map((t) => (state.teams[t] || {}).teamId) : [], e.currentTarget)
  );

  function editProfileLink(t, i) {
    const p = (t.players || [])[i] || {};
    const current = p.profile ? 'https://www.padeltour.ro' + p.profile : '';
    const url = window.prompt(`padeltour.ro profile of ${p.name} (empty = none):`, current);
    if (url === null) return;
    fetch('/api/profiles/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId: t.id, player: i, url }) })
      .then((r) => (r.status === 404 ? Promise.reject(new Error('only inside the app / on the venue network')) : r.json()))
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'failed');
        profStatus(r.profile ? `Link saved for ${p.name} - press ⟳ on the pair to read it.` : `Link removed for ${p.name}.`);
        loadRoster();
      })
      .catch((err) => profStatus('✗ ' + err.message, true));
  }

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
  // 2-letter ISO codes first (what padeltour.ro uses), then the old 3-letter FIP codes.
  const ISO2_COMMON = ['RO', 'MD', 'ES', 'IT', 'FR', 'DE', 'BG', 'HU', 'UA', 'PT', 'GB', 'NL', 'BE', 'AT', 'CH', 'PL', 'GR', 'RS', 'TR', 'AR', 'BR', 'MA', 'US', 'SE', 'DK'];
  ISO2_COMMON.concat(Object.keys(C.ISO3_TO_ISO2 || {}).sort()).forEach((code) => {
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
    input.setAttribute('aria-label', 'Country code (2 or 3 letters)');
    input.value = playerCountry(t, i);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim().toUpperCase();
      if (save && /^[A-Z]{2,3}$/.test(value) && value !== playerCountry(t, i)) {
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
    renderCards();
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

  /** One card per division (imported) or per men/women (entry list), each with its groups. */
  function renderCards() {
    const box = $('#rosterCards');
    box.innerHTML = '';
    const regional = roster.format === 'regions';
    document.querySelector('.layout').classList.toggle('regional', regional);
    $('#introHint').hidden = regional;
    $('#regionalHint').hidden = !regional;
    if (regional) return renderRegions(box);
    const groups = C.rosterGroups(roster.teams);
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.textContent = 'No teams yet — import them on the Admin tab (Import players).';
      box.appendChild(empty);
      return;
    }
    const cards = new Map();
    for (const g of groups) {
      if (!cards.has(g.card)) {
        const card = document.createElement('div');
        card.className = 'card';
        const head = document.createElement('div');
        head.className = 'card-head';
        const h2 = document.createElement('h2');
        h2.textContent = g.card;
        const badge = document.createElement('span');
        badge.className = 'badge';
        head.append(h2, badge);
        const list = document.createElement('div');
        list.className = 'roster';
        card.append(head, list);
        box.appendChild(card);
        cards.set(g.card, { list, badge, teams: [], sections: 0 });
      }
      const c = cards.get(g.card);
      c.teams.push(...g.teams);
      c.sections++;
      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = g.sectionLabel + ' (' + g.teams.length + ')';
      c.list.appendChild(title);
      g.teams.forEach((t) => c.list.appendChild(teamRow(t)));
    }
    for (const c of cards.values()) {
      c.badge.textContent = c.teams.filter(isActive).length + ' / ' + c.teams.length + ' active';
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
      cc.title = 'Click to change the country (2-letter code, e.g. RO, or 3-letter, e.g. ROU)';
      cc.addEventListener('click', () => startCountryEdit(t, i, cc));

      const edit = document.createElement('button');
      edit.className = 'rp-edit';
      edit.type = 'button';
      edit.textContent = '✎';
      edit.title = 'Edit the name';
      edit.addEventListener('click', () => startEdit(t, i, nm));

      const prof = document.createElement('button');
      prof.type = 'button';
      prof.className = 'rp-prof' + (p.profileAt ? ' read' : p.profile ? ' linked' : '');
      prof.textContent = p.profileAt ? '🪪 ' + shortDate(p.profileAt) : p.profile ? '🪪 not read' : '🪪 no link';
      prof.title = p.profile
        ? `padeltour.ro${p.profile}${p.profileAt ? ' - read ' + shortDate(p.profileAt) : ''}. Click to change the link.`
        : 'No padeltour.ro profile link yet - ⟳ looks it up on the tournament page, or click to paste it.';
      prof.addEventListener('click', () => editProfileLink(t, i));

      pr.append(flag, nm, cc, edit, prof);

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

    const refresh = document.createElement('button');
    refresh.className = 'btn btn-ghost prof-refresh';
    refresh.type = 'button';
    refresh.textContent = '⟳';
    refresh.title = "Read both players' padeltour.ro profiles (player cards)";
    refresh.addEventListener('click', () => refreshProfiles([t.id], refresh));

    const actions = document.createElement('div');
    actions.className = 'roster-actions';
    actions.append(refresh, btn);

    row.append(pos, playersBox, badges, actions);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Regional event: one card per region, each with its men and women — the
  // player pool (tick two players -> "Make pair") and the pairs built so far.
  // ---------------------------------------------------------------------------

  const ticked = new Map(); // "region|gender" -> Set of player ids (ticked to make a pair)

  function regionalPost(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => (r.status === 404 || r.status === 403 ? Promise.reject(new Error('only inside the app / on the venue network')) : r.json()))
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'failed');
        return r;
      })
      .catch((err) => {
        profStatus('✗ ' + err.message, true);
        throw err;
      });
  }

  function renderRegions(box) {
    const players = roster.players || [];
    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.textContent = 'No players yet — add the players of each region on the Admin tab (Regional event).';
      box.appendChild(empty);
    }
    for (const region of roster.regions || []) {
      const mine = players.filter((p) => p.region === region.id);
      const pairs = (roster.teams || []).filter((t) => t.region === region.id);
      if (!mine.length && !pairs.length) continue;

      const card = document.createElement('div');
      card.className = 'card region-card';
      card.style.setProperty('--region', region.color || '#888');
      const head = document.createElement('div');
      head.className = 'card-head';
      const h2 = document.createElement('h2');
      const sw = document.createElement('span');
      sw.className = 'region-swatch';
      sw.textContent = region.short || '';
      h2.append(sw, document.createTextNode(' ' + region.name));
      const right = document.createElement('div');
      right.className = 'row gap';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${mine.length} players · ${pairs.length} pairs`;
      const readAll = document.createElement('button');
      readAll.type = 'button';
      readAll.className = 'btn btn-ghost prof-refresh';
      readAll.textContent = '⟳ Profiles';
      readAll.title = `Read the padeltour.ro profiles of all ${region.name} players (a few seconds each)`;
      readAll.addEventListener('click', () => refreshPlayers(mine.map((p) => p.id), readAll));
      right.append(badge, readAll);
      head.append(h2, right);

      const cols = document.createElement('div');
      cols.className = 'reg-cols';
      for (const gender of ['M', 'F']) cols.appendChild(genderColumn(region, gender, mine, pairs));
      card.append(head, cols);
      box.appendChild(card);
    }
  }

  function refreshPlayers(playerIds, btn) {
    if (!playerIds.length) return;
    const buttons = document.querySelectorAll('#refreshMatchBtn, .prof-refresh');
    buttons.forEach((b) => (b.disabled = true));
    if (btn) btn.classList.add('is-playing');
    profStatus(`Reading ${playerIds.length} profile${playerIds.length === 1 ? '' : 's'} from padeltour.ro…`);
    fetch('/api/profiles/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamIds: [], playerIds }) })
      .then((r) => (r.status === 404 ? Promise.reject(new Error('only inside the app / on the venue network')) : r.json()))
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'failed');
        const bad = r.results.filter((x) => !x.ok);
        const good = r.results.length - bad.length;
        profStatus(`✓ ${good} of ${r.results.length} profiles read.` + (bad.length ? ' Not read: ' + bad.map((x) => `${x.name} (${x.error})`).join(', ') : ''), bad.length > 0);
        loadRoster();
      })
      .catch((err) => profStatus('✗ ' + err.message, true))
      .finally(() => {
        buttons.forEach((b) => (b.disabled = false));
        if (btn) btn.classList.remove('is-playing');
      });
  }

  function genderColumn(region, gender, mine, pairs) {
    const key = region.id + '|' + gender;
    const pool = mine.filter((p) => p.gender === gender);
    const gPairs = pairs.filter((t) => t.gender === gender);
    const sel = ticked.get(key) || new Set();
    for (const id of [...sel]) if (!pool.some((p) => p.id === id && p.available !== false)) sel.delete(id);
    ticked.set(key, sel);

    const col = document.createElement('div');
    col.className = 'reg-col';
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = `${gender === 'M' ? 'Masculin' : 'Feminin'} — players (${pool.length})`;
    col.appendChild(title);
    if (!pool.length) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = 'No players yet.';
      col.appendChild(none);
    }
    pool.forEach((p) => col.appendChild(poolRow(p, sel, key)));

    const make = document.createElement('button');
    make.type = 'button';
    make.className = 'btn make-pair ' + (sel.size === 2 ? 'btn-accent' : 'btn-ghost');
    make.disabled = sel.size !== 2;
    make.textContent = sel.size === 2 ? 'Make pair of the 2 ticked' : 'Tick 2 players to make a pair';
    make.addEventListener('click', () => {
      const ids = [...sel];
      regionalPost('/api/regional/pair', { playerIds: ids }).then(() => {
        sel.clear();
        profStatus(`✓ Pair ready — pick it on Score settings (${region.name}).`);
      });
    });
    if (pool.length >= 2) col.appendChild(make);

    const pt = document.createElement('div');
    pt.className = 'group-title';
    pt.textContent = `${gender === 'M' ? 'Masculin' : 'Feminin'} — pairs (${gPairs.length})`;
    col.appendChild(pt);
    gPairs.forEach((t) => col.appendChild(pairRow(t)));
    return col;
  }

  function poolRow(p, sel, key) {
    const available = p.available !== false;
    const row = document.createElement('div');
    row.className = 'pool-row' + (available ? '' : ' eliminated');

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = sel.has(p.id);
    tick.disabled = !available;
    tick.title = available ? 'Tick two players, then "Make pair"' : 'Not available';
    tick.addEventListener('change', () => {
      if (tick.checked) sel.add(p.id);
      else sel.delete(p.id);
      if (sel.size > 2) sel.delete(sel.values().next().value); // keep the last two ticked
      ticked.set(key, sel);
      renderAll();
    });

    const flag = document.createElement('span');
    flag.className = 'rp-flag';
    const url = C.flagUrl(p.country);
    if (url) flag.style.backgroundImage = `url('${url}')`;

    const nm = document.createElement('span');
    nm.className = 'rp-name';
    nm.textContent = p.name;
    nm.title = 'Click to correct the name';
    nm.addEventListener('click', () => {
      const name = window.prompt('Player name:', p.name);
      if (name && name.trim() && name.trim() !== p.name) regionalPost('/api/regional/player', { id: p.id, name: name.trim() }).catch(() => {});
    });

    const cc = document.createElement('span');
    cc.className = 'rp-cc';
    cc.textContent = p.country || '';
    cc.title = 'Click to change the country (e.g. RO, MD)';
    cc.addEventListener('click', () => {
      const code = window.prompt(`Country code of ${p.name} (2 or 3 letters):`, p.country || 'RO');
      if (code && /^[A-Za-z]{2,3}$/.test(code.trim())) regionalPost('/api/regional/player', { id: p.id, country: code.trim() }).catch(() => {});
    });

    const prof = document.createElement('button');
    prof.type = 'button';
    prof.className = 'rp-prof' + (p.profileAt ? ' read' : p.profile ? ' linked' : '');
    prof.textContent = p.profileAt ? '🪪 ' + shortDate(p.profileAt) : p.profile ? '🪪 not read' : '🪪 no link';
    prof.title = p.profile ? `padeltour.ro${p.profile}. Click to change the link.` : 'No padeltour.ro profile link yet — click to paste it.';
    prof.addEventListener('click', () => {
      const current = p.profile ? 'https://www.padeltour.ro' + p.profile : '';
      const link = window.prompt(`padeltour.ro profile of ${p.name} (empty = none):`, current);
      if (link === null) return;
      regionalPost('/api/profiles/link', { playerId: p.id, url: link }).then(() => profStatus(link.trim() ? `Link saved for ${p.name} — press ⟳ to read it.` : `Link removed for ${p.name}.`));
    });

    // eligibility hint: the profile's county is not in this region
    const info = document.createElement('span');
    info.className = 'pool-info';
    if (p.county) {
      info.textContent = p.county;
      info.classList.toggle('warn', p.countyOk === false);
      info.title = p.countyOk === false ? `Profile county ${p.county} is not in this region — check the eligibility` : `County on the profile: ${p.county}`;
    }

    const read = document.createElement('button');
    read.type = 'button';
    read.className = 'rp-edit prof-refresh';
    read.textContent = '⟳';
    read.title = 'Read the padeltour.ro profile';
    read.disabled = !p.profile;
    read.addEventListener('click', () => refreshPlayers([p.id], read));

    const avail = document.createElement('button');
    avail.type = 'button';
    avail.className = 'btn toggle small ' + (available ? 'is-active' : 'is-out');
    avail.textContent = available ? 'Available' : 'Out';
    avail.title = available ? 'Click if the player cannot play (injury…)' : 'Click to make the player available again';
    avail.addEventListener('click', () => regionalPost('/api/regional/player', { id: p.id, available: !available }).catch(() => {}));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rp-edit';
    del.textContent = '✕';
    del.title = 'Remove the player from the event (and their pairs)';
    del.addEventListener('click', () => {
      if (confirm(`Remove ${p.name} from the event? Their pairs are removed too.`)) regionalPost('/api/regional/player', { id: p.id, remove: true }).catch(() => {});
    });

    row.append(tick, flag, nm, cc, info, prof, read, avail, del);
    return row;
  }

  function pairRow(t) {
    const onCourt = state && [0, 1].some((s) => state.teams[s] && state.teams[s].teamId === t.id);
    const row = document.createElement('div');
    row.className = 'pair-row' + (onCourt ? ' on-court' : '');
    const pos = document.createElement('span');
    pos.className = 'roster-pos';
    pos.textContent = t.position;
    const names = document.createElement('span');
    names.className = 'rp-name';
    names.textContent = (t.players || []).map((p) => p.name).join(' / ');
    const tag = document.createElement('span');
    tag.className = 'pool-info';
    tag.textContent = onCourt ? 'on court' : '';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rp-edit';
    del.textContent = '✕';
    del.title = 'Remove this pair (the players stay in the pool)';
    del.addEventListener('click', () => {
      if (confirm(`Remove the pair ${names.textContent}? The players stay.`)) regionalPost('/api/regional/pair/remove', { teamId: t.id }).catch(() => {});
    });
    row.append(pos, names, tag, del);
    return row;
  }
})();

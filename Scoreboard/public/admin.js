/* Score-settings panel: entry-list team pickers, overlay display, reset. */
(function () {
  'use strict';

  const C = window.PadelCountries;
  let state = null;
  let roster = null; // { tournament, teams } from /api/teams
  let client = null;
  let lastRegistryJson = '';

  // Track which inputs the user is editing so live state updates don't clobber typing.
  const editing = new Set();

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---- connection ----
  client = PadelClient.connect({
    onState: (s, msg) => {
      state = s;
      if (msg && msg.roster && rosterRev !== null && msg.roster.rev !== rosterRev) loadRoster(); // an import changed it
      if (msg && msg.roster) rosterRev = msg.roster.rev;
      render(s, msg);
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });

  function send(obj) {
    client.send(obj);
  }

  // ---- roster (imported on the Admin tab, or the bundled entry list) ----
  let rosterRev = null;
  function loadRoster() {
    fetch('/api/teams')
      .then((r) => r.json())
      .then((data) => {
        roster = data;
        buildPickers();
        buildRegionalPick();
        if (state) renderSidePreviews(state);
      })
      .catch(() => {
        $$('.side-pick label').forEach((l) => l.classList.add('error'));
      });
  }
  loadRoster();


  function isActive(t) {
    const reg = state && state.teams_registry;
    if (reg && reg[t.id]) return reg[t.id].active !== false;
    return t.active !== false;
  }

  /** Live name correction from the registry (Teams page), else the roster name. */
  function liveName(t, i) {
    const reg = state && state.teams_registry;
    const names = reg && reg[t.id] && reg[t.id].names;
    return (names && names[i]) || (t.players[i] && t.players[i].originalName) || t.players[i].name;
  }

  function liveCountry(t, i) {
    const reg = state && state.teams_registry;
    const codes = reg && reg[t.id] && reg[t.id].countries;
    return (codes && codes[i]) || (t.players[i] && t.players[i].originalCountry) || t.players[i].country;
  }

  function teamOptionLabel(t) {
    const p1 = C.shortName(liveName(t, 0));
    const p2 = C.shortName(liveName(t, 1));
    const c1 = liveCountry(t, 0);
    const c2 = liveCountry(t, 1);
    const cc = c1 === c2 ? c1 : c1 + '/' + c2;
    return `${t.position}. ${p1} / ${p2} — ${cc}${t.wildcard ? ' (WC)' : ''}`;
  }

  function buildPickers() {
    if (!roster) return;
    for (const side of [0, 1]) {
      const sel = $(`[data-team-select="${side}"]`);
      const current = sel.value;
      sel.innerHTML = '<option value="">— pick a team —</option>';
      for (const g of C.rosterGroups(roster.teams)) {
        const teams = g.teams;
        if (!teams.length) continue;
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const t of teams) {
          const opt = document.createElement('option');
          opt.value = t.id;
          const active = isActive(t);
          opt.textContent = (active ? '' : '✕ ') + teamOptionLabel(t);
          opt.disabled = !active;
          og.appendChild(opt);
        }
        sel.appendChild(og);
      }
      sel.value = current;
    }
    syncPickersFromState();
  }

  $$('[data-team-select]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const side = +sel.dataset.teamSelect;
      if (sel.value) send({ type: 'selectTeam', team: side, teamId: sel.value });
    })
  );

  function syncPickersFromState() {
    if (!state || !roster) return;
    for (const side of [0, 1]) {
      const sel = $(`[data-team-select="${side}"]`);
      if (document.activeElement === sel) continue;
      const id = state.teams[side] && state.teams[side].teamId;
      sel.value = id || '';
    }
  }

  // ---- reset ----
  $('#resetMatchBtn').addEventListener('click', () => {
    if (confirm('Reset the score? Teams and settings are kept.')) send({ type: 'resetMatch' });
  });
  $('#resetAllBtn').addEventListener('click', () => {
    if (confirm('Reset EVERYTHING to defaults? Teams, settings, score and eliminations will be cleared.')) send({ type: 'resetAll' });
  });

  // ---- match format ----
  $('#cfgDeuce').addEventListener('change', () => {
    const deuceMode = $('#cfgDeuce').value;
    if (deuceMode === 'star' || deuceMode === 'golden' || deuceMode === 'silver') {
      send({ type: 'setConfig', config: { deuceMode, starDeuceLimit: 3 } });
    }
  });
  $('#cfgFinalSet').addEventListener('change', () => {
    const maxi = $('#cfgFinalSet').value === 'superTiebreak';
    send({
      type: 'setConfig',
      config: maxi
        ? { finalSetMode: 'superTiebreak', superTiebreakPoints: 10, tiebreakWinByTwo: true }
        : { finalSetMode: 'normal' },
    });
  });

  // ---- display form ----
  function sendDisplay() {
    send({
      type: 'setDisplay',
      display: {
        title: $('#dspTitle').value,
        subtitle: $('#dspSubtitle').value,
        startTime: $('#dspStartTime').value,
        showTitle: $('#dspShowTitle').checked,
        showServe: $('#dspShowServe').checked,
        showScore: $('#dspShowScore').checked,
      },
    });
  }
  ['#dspShowTitle', '#dspShowServe', '#dspShowScore', '#dspStartTime'].forEach((sel) =>
    $(sel).addEventListener('change', sendDisplay)
  );
  bindEditable('#dspTitle, #dspSubtitle', sendDisplay);

  // ---- render ----
  function render(s, msg) {
    if (msg && typeof msg.clients === 'number') {
      $('#clientCount').textContent = msg.clients + ' connected';
    }

    // Rebuild the pickers whenever an elimination flag changes anywhere.
    const rj = JSON.stringify(s.teams_registry || {});
    if (rj !== lastRegistryJson) {
      lastRegistryJson = rj;
      buildPickers();
    }

    syncPickersFromState();
    syncRegionalFromState(s);
    renderSidePreviews(s);
    syncForms(s);
  }

  // ---- regional event: Region vs Region game ----
  // Per side: region -> an existing pair, or two players -> "Put on court"
  // (the server makes the pair if it is new, then puts it on that side).
  const isRegional = () => !!roster && roster.format === 'regions';
  const regSynced = [undefined, undefined]; // teamId last copied from the live state into each side's pickers

  function regionOf(id) {
    return ((roster && roster.regions) || []).find((r) => r.id === id) || null;
  }

  function buildRegionalPick() {
    const regional = isRegional();
    $('#regGameHead').hidden = !regional;
    $('#regGameHint').hidden = !regional;
    $('#pairsHint').hidden = regional;
    $('#matchCardTitle').textContent = regional ? 'Game — Region vs Region' : 'Match — select teams';
    $$('.pair-pick').forEach((l) => (l.hidden = regional));
    $$('[data-reg-pick]').forEach((box) => (box.hidden = !regional));
    if (!regional) return;
    for (const side of [0, 1]) {
      const box = $(`[data-reg-pick="${side}"]`);
      if (!box.firstChild) {
        box.innerHTML =
          `<label>Side ${side + 1} — region<select class="rg-region"></select></label>` +
          '<label>Pair<select class="rg-pair"></select></label>' +
          '<div class="rg-players"><label>Player 1<select class="rg-p" data-i="0"></select></label><label>Player 2<select class="rg-p" data-i="1"></select></label></div>' +
          `<div class="row gap wrap"><button class="btn btn-accent rg-go" type="button">Put on court (side ${side + 1})</button><span class="hint rg-note"></span></div>`;
        box.querySelector('.rg-region').addEventListener('change', () => fillSide(side));
        box.querySelector('.rg-pair').addEventListener('change', (e) => {
          const t = (roster.teams || []).find((x) => x.id === e.target.value);
          if (t) box.querySelectorAll('.rg-p').forEach((s, i) => (s.value = t.playerIds[i] || ''));
          markPair(side);
        });
        box.querySelectorAll('.rg-p').forEach((s) => s.addEventListener('change', () => markPair(side)));
        box.querySelector('.rg-go').addEventListener('click', () => putOnCourt(side));
      }
      const regionSel = box.querySelector('.rg-region');
      const cur = regionSel.value;
      regionSel.innerHTML = '<option value="">— pick a region —</option>';
      for (const r of roster.regions || []) {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.name;
        regionSel.appendChild(o);
      }
      regionSel.value = cur;
      fillSide(side);
    }
    regSynced[0] = regSynced[1] = undefined; // copy the live pairs into the fresh pickers
    if (state) syncRegionalFromState(state);
  }

  /** Pair and player options of one side, for its region and the chosen competition. */
  function fillSide(side) {
    const box = $(`[data-reg-pick="${side}"]`);
    const region = box.querySelector('.rg-region').value;
    const gender = $('#regGameGender').value;
    const pool = (roster.players || []).filter((p) => p.region === region && p.gender === gender);
    const pairs = (roster.teams || []).filter((t) => t.region === region && t.gender === gender);
    const pairSel = box.querySelector('.rg-pair');
    const keepPair = pairSel.value;
    pairSel.innerHTML = `<option value="">${pairs.length ? '— new pair (pick the players) —' : '— no pairs yet: pick the players —'}</option>`;
    for (const t of pairs) {
      const o = document.createElement('option');
      o.value = t.id;
      const out = t.playerIds.some((id) => (pool.find((p) => p.id === id) || {}).available === false);
      o.textContent = `${t.position}. ${(t.players || []).map((p) => C.shortName(p.name)).join(' / ')}${out ? ' (a player is out)' : ''}`;
      pairSel.appendChild(o);
    }
    box.querySelectorAll('.rg-p').forEach((s) => {
      const keep = s.value;
      s.innerHTML = '<option value="">— player —</option>';
      for (const p of pool) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name + (p.available === false ? ' (out)' : '');
        o.disabled = p.available === false;
        s.appendChild(o);
      }
      s.value = pool.some((p) => p.id === keep) ? keep : '';
    });
    pairSel.value = pairs.some((t) => t.id === keepPair) ? keepPair : '';
    markPair(side);
    if (!region) note(side, '');
    else if (pool.length < 2) note(side, `${regionOf(region).name} has ${pool.length} ${gender === 'M' ? 'men' : 'women'} — add players on the Admin tab.`, true);
    else note(side, '');
  }

  /** Shows the existing pair when the two picked players already are one. */
  function markPair(side) {
    const box = $(`[data-reg-pick="${side}"]`);
    const ids = Array.from(box.querySelectorAll('.rg-p')).map((s) => s.value);
    const key = [...ids].sort().join('+');
    const t = (roster.teams || []).find((x) => [...x.playerIds].sort().join('+') === key);
    box.querySelector('.rg-pair').value = t ? t.id : '';
    const go = box.querySelector('.rg-go');
    go.disabled = !(ids[0] && ids[1] && ids[0] !== ids[1]);
    const onCourt = t && state && state.teams[side] && state.teams[side].teamId === t.id;
    go.textContent = onCourt ? `On court (side ${side + 1}) ✓` : `Put on court (side ${side + 1})`;
  }

  function note(side, text, warn) {
    const el = $(`[data-reg-pick="${side}"] .rg-note`);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }

  function putOnCourt(side) {
    const box = $(`[data-reg-pick="${side}"]`);
    const ids = Array.from(box.querySelectorAll('.rg-p')).map((s) => s.value);
    if (!ids[0] || !ids[1] || ids[0] === ids[1]) return note(side, 'Pick two different players.', true);
    const other = state && state.teams[1 - side];
    const otherRec = other && other.teamId && (roster.teams || []).find((t) => t.id === other.teamId);
    if (otherRec && otherRec.playerIds.some((id) => ids.includes(id))) return note(side, 'That player is already on the other side.', true);
    note(side, 'Putting the pair on court…');
    fetch('/api/regional/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerIds: ids, team: side }) })
      .then((r) => (r.status === 404 || r.status === 403 ? Promise.reject(new Error('only inside the app / on the venue network')) : r.json()))
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'failed');
        regSynced[side] = undefined; // take the new pair from the next state
        note(side, '✓ On court.');
      })
      .catch((err) => note(side, '✗ ' + err.message, true));
  }

  $('#regGameGender').addEventListener('change', () => {
    fillSide(0);
    fillSide(1);
  });

  /** The live pairs (picked here, by the referee, or after a restart) shown in the pickers. */
  function syncRegionalFromState(s) {
    if (!isRegional()) return;
    for (const side of [0, 1]) {
      const id = s.teams[side] && s.teams[side].teamId;
      if (regSynced[side] === id) {
        markPair(side);
        continue;
      }
      const box = $(`[data-reg-pick="${side}"]`);
      if (box.contains(document.activeElement)) continue;
      const t = (roster.teams || []).find((x) => x.id === id);
      regSynced[side] = id;
      if (!t) continue;
      $('#regGameGender').value = t.gender;
      box.querySelector('.rg-region').value = t.region;
      fillSide(side);
      box.querySelectorAll('.rg-p').forEach((sel, i) => (sel.value = t.playerIds[i] || ''));
      markPair(side);
      // the other side follows the competition
      const o = 1 - side;
      const ob = $(`[data-reg-pick="${o}"]`);
      if (!ob.contains(document.activeElement)) fillSide(o);
    }
  }

  function renderSidePreviews(s) {
    for (let side = 0; side < 2; side++) {
      const box = $(`[data-side-preview="${side}"]`);
      box.innerHTML = '';
      const region = s.teams[side].region;
      if (region && isRegional()) {
        const chip = document.createElement('div');
        chip.className = 'sp-region';
        chip.style.setProperty('--region', region.color || '#888');
        chip.innerHTML = '<span class="sp-region-code"></span><span class="sp-region-name"></span>';
        chip.firstChild.textContent = region.short || '';
        chip.lastChild.textContent = region.name || '';
        box.appendChild(chip);
      }
      (s.teams[side].players || []).slice(0, 2).forEach((p) => {
        const row = document.createElement('div');
        row.className = 'sp-row';

        const flag = document.createElement('span');
        flag.className = 'sp-flag';
        const url = C.flagUrl(C.playerCountry(p));
        if (url) flag.style.backgroundImage = `url('${url}')`;

        const nm = document.createElement('span');
        nm.className = 'sp-name';
        nm.textContent = C.playerName(p);

        const cc = document.createElement('span');
        cc.className = 'sp-cc';
        cc.textContent = C.playerCountry(p);

        row.append(flag, nm, cc);
        box.appendChild(row);
      });
    }
  }

  // Push server state into form fields, but never overwrite a field being edited.
  function syncForms(s) {
    const c = s.config || {};
    setVal('#cfgDeuce', ['star', 'golden', 'silver'].includes(c.deuceMode) ? c.deuceMode : 'star');
    setVal('#cfgFinalSet', c.finalSetMode === 'superTiebreak' ? 'superTiebreak' : 'normal');

    const d = s.display;
    setVal('#dspTitle', d.title || '');
    setVal('#dspSubtitle', d.subtitle || '');
    setVal('#dspStartTime', d.startTime || '');
    setChk('#dspShowTitle', d.showTitle !== false);
    setChk('#dspShowServe', d.showServe !== false);
    setChk('#dspShowScore', d.showScore !== false);
  }

  // ---- helpers ----
  function bindEditable(selector, handler) {
    $$(selector).forEach((el) => {
      el.addEventListener('focus', () => editing.add(el));
      el.addEventListener('blur', () => editing.delete(el));
      el.addEventListener('input', handler);
    });
  }

  function setVal(sel, val) {
    const el = $(sel);
    if (!el || editing.has(el)) return;
    if (document.activeElement === el) return;
    if (el.value !== String(val)) el.value = val;
  }

  function setChk(sel, val) {
    const el = $(sel);
    if (!el || document.activeElement === el) return;
    el.checked = !!val;
  }
})();

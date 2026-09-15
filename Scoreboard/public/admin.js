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

  // ---- entry-list roster ----
  fetch('/api/teams')
    .then((r) => r.json())
    .then((data) => {
      roster = data;
      buildPickers();
      if (state) renderSidePreviews(state);
    })
    .catch(() => {
      $$('.side-pick label').forEach((l) => l.classList.add('error'));
    });

  const GROUPS = [
    { category: 'men', section: 'main_draw', label: 'Men — Main draw' },
    { category: 'men', section: 'qualifying', label: 'Men — Qualifying' },
    { category: 'women', section: 'main_draw', label: 'Women — Main draw' },
    { category: 'women', section: 'qualifying', label: 'Women — Qualifying' },
  ];

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
      for (const g of GROUPS) {
        const teams = roster.teams
          .filter((t) => t.category === g.category && t.section === g.section)
          .sort((a, b) => a.position - b.position);
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
        showSets: $('#dspShowSets').checked,
        showServe: $('#dspShowServe').checked,
      },
    });
  }
  ['#dspShowTitle', '#dspShowSets', '#dspShowServe', '#dspStartTime'].forEach((sel) =>
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
    renderSidePreviews(s);
    syncForms(s);
  }

  function renderSidePreviews(s) {
    for (let side = 0; side < 2; side++) {
      const box = $(`[data-side-preview="${side}"]`);
      box.innerHTML = '';
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
    setChk('#dspShowSets', d.showSets !== false);
    setChk('#dspShowServe', d.showServe !== false);
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

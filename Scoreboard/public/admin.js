/* Score-settings panel: entry-list team pickers, overlay display, URL builder, reset. */
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

  function teamOptionLabel(t) {
    const p1 = C.shortName(t.players[0].name);
    const p2 = C.shortName(t.players[1].name);
    const c1 = t.players[0].country;
    const c2 = t.players[1].country;
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

  // ---- display form ----
  function sendDisplay() {
    send({
      type: 'setDisplay',
      display: {
        title: $('#dspTitle').value,
        subtitle: $('#dspSubtitle').value,
        showTitle: $('#dspShowTitle').checked,
        showSets: $('#dspShowSets').checked,
        showServe: $('#dspShowServe').checked,
      },
    });
  }
  ['#dspShowTitle', '#dspShowSets', '#dspShowServe'].forEach((sel) =>
    $(sel).addEventListener('change', sendDisplay)
  );
  bindEditable('#dspTitle, #dspSubtitle', sendDisplay);

  // ---- overlay URL ----
  function updateOverlayUrl() {
    const pos = $('#ovPos').value;
    const scale = $('#ovScale').value;
    const url = new URL('/overlay', location.origin);
    url.searchParams.set('pos', pos);
    if (scale && scale !== '1') url.searchParams.set('scale', scale);
    $('#overlayUrl').value = url.toString();
  }
  $('#ovPos').addEventListener('change', updateOverlayUrl);
  $('#ovScale').addEventListener('input', updateOverlayUrl);
  $('#copyUrlBtn').addEventListener('click', () => {
    $('#overlayUrl').select();
    navigator.clipboard?.writeText($('#overlayUrl').value);
    flash($('#copyUrlBtn'), 'Copied!');
  });
  $('#openOverlayBtn').addEventListener('click', () => window.open($('#overlayUrl').value, '_blank'));
  updateOverlayUrl();

  // ---- players intro URL (second Browser Source) ----
  $('#introUrl').value = new URL('/intro', location.origin).toString();
  $('#copyIntroUrlBtn').addEventListener('click', () => {
    $('#introUrl').select();
    navigator.clipboard?.writeText($('#introUrl').value);
    flash($('#copyIntroUrlBtn'), 'Copied!');
  });
  $('#openIntroBtn').addEventListener('click', () => window.open($('#introUrl').value, '_blank'));

  // ---- court TV URL ----
  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      const host = info.lanHost || location.hostname;
      $('#tvUrl').value = `http://${host}:${info.port}/tv`;
      if (info.publicPort) {
        $('#publicPort').textContent = info.publicPort;
        $('#publicLocal').textContent = `http://localhost:${info.publicPort}`;
      } else {
        $('#publicPort').textContent = 'disabled';
        $('#publicLocal').textContent = '(set PUBLIC_PORT)';
      }
    })
    .catch(() => {
      $('#tvUrl').value = new URL('/tv', location.origin).toString();
    });
  $('#copyTvUrlBtn').addEventListener('click', () => {
    $('#tvUrl').select();
    navigator.clipboard?.writeText($('#tvUrl').value);
    flash($('#copyTvUrlBtn'), 'Copied!');
  });
  $('#openTvBtn').addEventListener('click', () => window.open($('#tvUrl').value, '_blank'));

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
    const d = s.display;
    setVal('#dspTitle', d.title || '');
    setVal('#dspSubtitle', d.subtitle || '');
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

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }
})();

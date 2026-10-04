/* Announcements tab: add / edit / switch on and off / reorder the texts of the
   bottom bar (/ticker). The full list (drafts included) comes from
   /api/announcements and is reloaded whenever the broadcast's `rev` moves. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  let items = [];
  let clockOffset = 0; // server time - local time
  let lastRev = -1;
  let editingId = null; // the row open in the inline editor
  let draft = null; // { text, mode, durationSec } of that editor - survives list reloads

  const client = PadelClient.connect({
    onState: (_state, msg) => {
      const ann = msg && msg.announcements;
      if (ann && ann.rev !== lastRev) load();
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });
  const send = (obj) => client.send(obj);

  function load() {
    fetch('/api/announcements')
      .then((r) => r.json())
      .then((data) => {
        lastRev = data.rev;
        items = data.items || [];
        clockOffset = (data.serverNow || Date.now()) - Date.now();
        renderList();
      })
      .catch(() => {
        $('#list').textContent = 'Could not load the announcements.';
      });
  }
  load();

  // ---- timing picker (always / timer N minutes|hours) ----
  let pickerSeq = 0;
  function timingPicker(container, mode, durationSec) {
    const node = $('#timingTpl').content.firstElementChild.cloneNode(true);
    const name = 'timing' + ++pickerSeq;
    node.querySelectorAll('input[type=radio]').forEach((r) => (r.name = name));
    const unit = durationSec && durationSec % 3600 === 0 ? 3600 : 60;
    node.querySelector('.dur-unit').value = String(unit);
    node.querySelector('.dur-value').value = durationSec ? Math.max(1, Math.round(durationSec / unit)) : 10;
    node.querySelector(`input[value=${mode === 'timer' ? 'timer' : 'always'}]`).checked = true;
    // Typing a duration picks "Timer".
    node.querySelectorAll('.dur-value, .dur-unit').forEach((el) =>
      el.addEventListener('input', () => (node.querySelector('input[value=timer]').checked = true)));
    container.innerHTML = '';
    container.appendChild(node);
    return () => ({
      mode: node.querySelector('input[value=timer]').checked ? 'timer' : 'always',
      durationSec: Math.max(1, Number(node.querySelector('.dur-value').value) || 10) * Number(node.querySelector('.dur-unit').value),
    });
  }

  // ---- new announcement ----
  let readNewTiming = timingPicker($('#newTiming'), 'always', 600);
  function add(enabled) {
    const text = $('#newText').value.trim();
    if (!text) {
      $('#newText').focus();
      return;
    }
    send({ type: 'annAdd', text, enabled, ...readNewTiming() });
    $('#newText').value = '';
    readNewTiming = timingPicker($('#newTiming'), 'always', 600);
  }
  $('#addBtn').addEventListener('click', () => add(true));
  $('#addOffBtn').addEventListener('click', () => add(false));
  $('#newText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add(true);
  });

  // ---- list ----
  function isOnAir(a) {
    return a.enabled && (a.mode !== 'timer' || (a.expiresAt && a.expiresAt > Date.now() + clockOffset));
  }

  function fmtDuration(sec) {
    if (sec % 3600 === 0) return `${sec / 3600} h`;
    if (sec >= 3600) return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
    return `${Math.round(sec / 60)} min`;
  }

  function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function metaHtml(a) {
    const timing = a.mode === 'timer' ? `timer ${fmtDuration(a.durationSec)}` : 'always on';
    if (!isOnAir(a)) return `off · ${timing}`;
    if (a.mode === 'timer') {
      return `<span class="live">● ON AIR</span> · <span data-left="${a.id}">${fmtLeft(a.expiresAt - Date.now() - clockOffset)}</span> left of ${fmtDuration(a.durationSec)}`;
    }
    return '<span class="live">● ON AIR</span> · always on, until you switch it off';
  }

  function renderList() {
    const box = $('#list');
    box.innerHTML = '';
    const onAir = items.filter(isOnAir).length;
    $('#onAirBadge').textContent = `${onAir} on air · ${items.length} total`;
    $('#onAirBadge').className = 'badge' + (onAir ? ' live' : '');
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'ann-empty';
      empty.textContent = 'No announcements yet — add one above.';
      box.appendChild(empty);
      return;
    }
    items.forEach((a, i) => {
      const live = isOnAir(a);
      const row = document.createElement('div');
      row.className = 'ann-row ' + (live ? 'on-air' : 'off');

      const sw = document.createElement('button');
      sw.className = 'switch' + (live ? ' on' : '');
      sw.title = live ? 'On air — click to switch off' : 'Off — click to put on air';
      sw.addEventListener('click', () => send({ type: 'annSetEnabled', id: a.id, enabled: !live }));

      const body = document.createElement('div');
      body.className = 'ann-body';
      const text = document.createElement('div');
      text.className = 'ann-text';
      text.textContent = a.text;
      const meta = document.createElement('div');
      meta.className = 'ann-meta';
      meta.innerHTML = metaHtml(a);
      body.append(text, meta);

      const tools = document.createElement('div');
      tools.className = 'ann-tools';
      tools.append(
        iconBtn('↑', 'Earlier in the rotation', i === 0, () => send({ type: 'annMove', id: a.id, delta: -1 })),
        iconBtn('↓', 'Later in the rotation', i === items.length - 1, () => send({ type: 'annMove', id: a.id, delta: 1 })),
        iconBtn('✎', 'Edit', false, () => {
          editingId = editingId === a.id ? null : a.id;
          draft = null;
          renderList();
        }),
        iconBtn('🗑', 'Delete', false, () => {
          if (confirm('Delete this announcement?\n\n' + a.text)) send({ type: 'annDelete', id: a.id });
        }, 'danger')
      );

      row.append(sw, body, tools);
      if (editingId === a.id) row.appendChild(editor(a));
      box.appendChild(row);
    });
  }

  function iconBtn(label, title, disabled, onClick, extra) {
    const b = document.createElement('button');
    b.className = 'icon-btn' + (extra ? ' ' + extra : '');
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function editor(a) {
    const wrap = document.createElement('div');
    wrap.className = 'ann-edit';
    const start = draft || { text: a.text, mode: a.mode, durationSec: a.durationSec };
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.maxLength = 300;
    ta.value = start.text;
    const timing = document.createElement('div');
    timing.className = 'timing';
    const readTiming = timingPicker(timing, start.mode, start.durationSec);
    const keepDraft = () => (draft = { text: ta.value, ...readTiming() });
    ta.addEventListener('input', keepDraft);
    timing.addEventListener('input', keepDraft);
    timing.addEventListener('change', keepDraft);
    const row = document.createElement('div');
    row.className = 'row gap wrap';
    const save = document.createElement('button');
    save.className = 'btn btn-add';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      const t = ta.value.trim();
      if (!t) return ta.focus();
      editingId = null;
      draft = null;
      send({ type: 'annUpdate', id: a.id, text: t, ...readTiming() });
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      editingId = null;
      draft = null;
      renderList();
    });
    row.append(save, cancel);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = a.enabled ? 'Changing the timing of an announcement that is on air restarts its countdown.' : '';
    wrap.append(ta, timing, row, note);
    if (!draft) setTimeout(() => ta.focus(), 0); // only when opened, not on a background reload
    return wrap;
  }

  // Countdown tick; a timer that runs out is switched off by the server (rev bump -> reload).
  setInterval(() => {
    document.querySelectorAll('[data-left]').forEach((el) => {
      const a = items.find((x) => x.id === el.dataset.left);
      if (a && a.expiresAt) el.textContent = fmtLeft(a.expiresAt - Date.now() - clockOffset);
    });
  }, 1000);

})();

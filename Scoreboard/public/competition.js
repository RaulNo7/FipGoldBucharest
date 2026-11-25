/* Competition page: every game (tie) of the regional competition, its three
   matches (pairs + set scores), the group standings and the final ranking.
   Works on a phone through the public link with the access key. */
(function () {
  'use strict';

  const V = window.CompView;
  const { el } = V;
  const $ = (s) => document.querySelector(s);

  let view = null;
  let cat = 'M';
  let mode = 'schedule';
  let openTie = null;
  const dirty = new Set(); // "tieId:index" being edited (not overwritten by the refresh)
  const msgs = new Map(); // "tieId:index" -> { text, cls }

  // The Teams link only makes sense where the Teams page is (the app, or with the key).
  if (!document.documentElement.classList.contains('in-app')) $('#teamsLink').hidden = true;

  function load() {
    return fetch('/api/competition', { cache: 'no-store' })
      .then((r) => r.json())
      .then((v) => {
        view = v;
        render();
      })
      .catch(() => {});
  }

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      r.json().then((j) => {
        if (!r.ok || j.ok === false) throw new Error(j.error || 'not saved');
        if (j.view) view = j.view;
        return j;
      })
    );
  }

  // ---- setup ----
  $('#createBtn').addEventListener('click', () => {
    $('#setupStatus').textContent = 'Creating…';
    post('/api/competition/create', {})
      .then(() => render())
      .catch((e) => ($('#setupStatus').textContent = e.message));
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Delete every result of the competition and start the Etapa I schedule again?')) return;
    if (!confirm('Really delete all results? This cannot be undone.')) return;
    dirty.clear();
    post('/api/competition/create', { replace: true }).then(render).catch((e) => alert(e.message));
  });

  document.querySelectorAll('#catSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      cat = b.dataset.cat;
      openTie = null;
      render();
    })
  );
  document.querySelectorAll('#viewSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.view;
      render();
    })
  );

  // ---- render ----
  function render() {
    if (!view) return;
    const regional = (view.regions || []).length > 0;
    $('#setupCard').hidden = !!view.exists;
    $('#compMain').hidden = !view.exists;
    if (!view.exists) {
      $('#createBtn').hidden = !regional;
      $('#setupText').textContent = regional
        ? "Creates every game of Etapa I (Brașov): the groups and the schedule of the federation's Schedule Proposal, men and women, with Monday's classification games."
        : 'There is no regional event yet: start it and add the players on the Admin tab first.';
      return;
    }
    document.querySelectorAll('#catSeg button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
    $('#scheduleHint').hidden = mode !== 'schedule';
    const box = $('#view');
    const c = view.categories[cat];
    if (mode === 'standings') return box.replaceChildren(V.standings(view, c));
    if (mode === 'ranking') return box.replaceChildren(V.ranking(view, c));
    renderSchedule(box, c);
  }

  function renderSchedule(box, c) {
    // keep a game being edited as it is (the refresh must not wipe what is typed)
    const keep = openTie && [...dirty].some((k) => k.startsWith(openTie + ':')) ? box.querySelector(`[data-tie="${openTie}"]`) : null;
    const frag = document.createDocumentFragment();
    let day = '';
    for (const t of c.ties) {
      if (t.day !== day) {
        day = t.day;
        frag.appendChild(el('div', 'day-title', V.dayText(day)));
      }
      if (keep && t.id === openTie) {
        updateHead(keep, t);
        frag.appendChild(keep);
        continue;
      }
      frag.appendChild(tieCard(t));
    }
    box.replaceChildren(frag);
  }

  function scoreText(t) {
    const r = t.result;
    if (r.finished) return { text: `${r.home}–${r.away}`, cls: 'done' };
    if (r.started) return { text: `${r.home}–${r.away}`, cls: 'live' };
    return { text: '—', cls: 'none' };
  }

  function sideChip(t, side) {
    return V.chip(view, t[side], t.slots ? V.slotText(t.slots[side]).replace(' Group ', ' ') : '?');
  }

  function headContent(t) {
    const when = el('div', 'tie-when');
    when.append(el('b', '', t.time), el('span', '', t.court));
    const sides = el('div', 'tie-sides');
    sides.appendChild(el('div', 'tie-phase', V.phaseText(t)));
    const vs = el('div', 'tie-vs');
    vs.append(sideChip(t, 'home'), el('span', 'vs', 'vs'), sideChip(t, 'away'));
    sides.appendChild(vs);
    const s = scoreText(t);
    return [when, sides, el('div', 'tie-score ' + s.cls, s.text)];
  }

  function updateHead(card, t) {
    card.querySelector('.tie-head').replaceChildren(...headContent(t));
  }

  function tieCard(t) {
    const card = el('div', 'tie' + (openTie === t.id ? ' open' : ''));
    card.dataset.tie = t.id;
    const head = el('button', 'tie-head');
    head.type = 'button';
    head.append(...headContent(t));
    head.addEventListener('click', () => {
      openTie = openTie === t.id ? null : t.id;
      render();
      if (openTie) setTimeout(() => document.querySelector(`[data-tie="${t.id}"]`).scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
    });
    card.appendChild(head);
    if (openTie === t.id) card.appendChild(tieBody(t));
    return card;
  }

  function tieBody(t) {
    const body = el('div', 'tie-body');
    if (!t.home || !t.away) {
      body.appendChild(
        el('p', 'waiting', `The regions of this game are known when the groups are finished (${V.slotText(t.slots.home)} vs ${V.slotText(t.slots.away)}).`)
      );
    } else {
      t.matches.forEach((m, i) => body.appendChild(matchBox(t, m, i)));
    }
    body.appendChild(metaBox(t));
    return body;
  }

  function playersOf(region) {
    return (view.players || []).filter((p) => p.region === region && p.gender === cat).sort((a, b) => a.name.localeCompare(b.name));
  }

  function playerSelect(region, value) {
    const s = el('select');
    s.appendChild(new Option('— player —', ''));
    for (const p of playersOf(region)) s.appendChild(new Option(p.name + (p.available ? '' : ' (out)'), p.id));
    s.value = value || '';
    return s;
  }

  function numInput(value) {
    const i = el('input');
    i.type = 'text';
    i.inputMode = 'numeric';
    i.maxLength = 2;
    i.value = value === undefined || value === null ? '' : String(value);
    i.addEventListener('focus', () => i.select());
    return i;
  }

  function matchBox(t, m, i) {
    const key = `${t.id}:${i}`;
    const box = el('div', 'match');
    const head = el('div', 'match-head');
    const res = el('span', 'match-res' + (m.result.winner ? ' done' : ''));
    res.textContent = m.result.winner
      ? `${V.regionName(view, m.result.winner === 'home' ? t.home : t.away)} wins · ${V.setsText(m.sets)}`
      : m.sets.length
        ? V.setsText(m.sets)
        : 'not played yet';
    head.append(el('b', '', `Match ${i + 1} · Pair ${i + 1}`), res);
    box.appendChild(head);

    // pairs
    const pairs = el('div', 'pairs');
    const sel = {};
    for (const side of ['home', 'away']) {
      const col = el('div', 'pair-side');
      const lab = el('div', 'side-label');
      lab.append(V.chip(view, t[side]), el('span', '', V.regionName(view, t[side])));
      col.appendChild(lab);
      sel[side] = [playerSelect(t[side], m[side][0]), playerSelect(t[side], m[side][1])];
      col.append(...sel[side]);
      pairs.appendChild(col);
    }
    box.appendChild(pairs);
    if (m.mismatch) box.appendChild(el('div', 'mismatch', 'The regions of this game changed after this match was entered: pick the pairs again.'));

    // sets (from the home side)
    const sets = el('div', 'sets');
    const s1 = m.sets[0] || {};
    const s2 = m.sets[1] || {};
    const s3 = m.sets[2] || {};
    const inputs = [
      [numInput(s1.h), numInput(s1.a)],
      [numInput(s2.h), numInput(s2.a)],
      [numInput(s3.tbh), numInput(s3.tba)],
    ];
    const labels = ['Set 1', 'Set 2', 'Super tie-break'];
    const boxes = inputs.map((pair, k) => {
      const b = el('div', 'set-box' + (k === 2 ? ' tb' : ''));
      b.appendChild(el('span', '', labels[k]));
      const row = el('div', 'pair-in');
      row.append(pair[0], el('span', '', '–'), pair[1]);
      b.appendChild(row);
      sets.appendChild(b);
      return b;
    });
    box.appendChild(sets);

    // the super tie-break only at one set all
    const refreshTb = () => {
      const won = (h, a) => (h.value !== '' && a.value !== '' ? (Number(h.value) > Number(a.value) ? 1 : -1) : 0);
      const a = won(inputs[0][0], inputs[0][1]);
      const b = won(inputs[1][0], inputs[1][1]);
      boxes[2].classList.toggle('off', !(a && b && a !== b));
    };
    refreshTb();

    const actions = el('div', 'match-actions');
    const msg = el('span', 'match-msg');
    const prev = msgs.get(key);
    if (prev) {
      msg.textContent = prev.text;
      msg.className = 'match-msg ' + prev.cls;
    }
    const save = el('button', 'btn btn-primary-c', 'Save');
    save.type = 'button';
    actions.append(msg, save);
    box.appendChild(actions);

    const touch = () => {
      dirty.add(key);
      msgs.delete(key);
      msg.textContent = 'not saved';
      msg.className = 'match-msg';
      refreshTb();
    };
    box.addEventListener('input', touch);
    box.addEventListener('change', touch);

    save.addEventListener('click', () => {
      save.disabled = true;
      msg.textContent = 'Saving…';
      msg.className = 'match-msg';
      post('/api/competition/match', {
        tieId: t.id,
        index: i,
        home: sel.home.map((s) => s.value).filter(Boolean),
        away: sel.away.map((s) => s.value).filter(Boolean),
        sets: [inputs[0].map((x) => x.value.trim()), inputs[1].map((x) => x.value.trim())],
        tiebreak: inputs[2].map((x) => x.value.trim()),
      })
        .then(() => {
          dirty.delete(key);
          msgs.set(key, { text: 'Saved', cls: 'ok' });
          render();
        })
        .catch((e) => {
          save.disabled = false;
          msg.textContent = e.message;
          msg.className = 'match-msg err';
        });
    });
    return box;
  }

  function metaBox(t) {
    const box = el('div', 'tie-meta');
    const field = (label, type, value) => {
      const l = el('label', '', label);
      const i = el('input');
      i.type = type;
      i.value = value || '';
      l.appendChild(i);
      box.appendChild(l);
      return i;
    };
    const day = field('Day', 'date', t.day);
    const time = field('Time', 'time', t.time);
    const court = field('Court', 'text', t.court);
    const btn = el('button', 'btn btn-ghost', 'Save time');
    btn.type = 'button';
    btn.addEventListener('click', () =>
      post('/api/competition/tie', { id: t.id, day: day.value, time: time.value, court: court.value })
        .then(render)
        .catch((e) => alert(e.message))
    );
    box.appendChild(btn);
    return box;
  }

  load();
  // other phones enter results too: refresh, but never over a match being typed
  setInterval(() => {
    if (!dirty.size) load();
  }, 10000);
})();

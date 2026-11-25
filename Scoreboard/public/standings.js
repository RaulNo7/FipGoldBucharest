/* Public Standings page: final ranking, group tables and every game with its
   matches, for men and women. Read-only; refreshes itself. */
(function () {
  'use strict';

  const V = window.CompView;
  const { el } = V;
  const $ = (s) => document.querySelector(s);
  let view = null;
  const params = new URLSearchParams(location.search);
  let cat = params.get('cat') === 'F' ? 'F' : 'M';
  let mode = ['games', 'standings', 'ranking'].includes(params.get('view')) ? params.get('view') : 'games';
  document.querySelectorAll('#viewSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.view;
      render();
    })
  );

  document.querySelectorAll('#catSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      cat = b.dataset.cat;
      render();
    })
  );

  function load() {
    fetch('/api/competition', { cache: 'no-store' })
      .then((r) => r.json())
      .then((v) => {
        view = v;
        const now = new Date();
        $('#updated').textContent = `updated ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        render();
      })
      .catch(() => {});
  }

  function render() {
    if (!view) return;
    $('#empty').hidden = !!view.exists;
    $('#main').hidden = !view.exists;
    if (!view.exists) return;
    $('#compTitle').textContent = view.name || 'Standings';
    document.querySelectorAll('#catSeg button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
    for (const id of ['games', 'standings', 'ranking']) $('#' + id).hidden = id !== mode;
    const c = view.categories[cat];
    $('#ranking').replaceChildren(V.ranking(view, c));
    $('#standings').replaceChildren(V.standings(view, c));
    $('#games').replaceChildren(games(c));
  }

  const expanded = new Set(); // past days opened by the viewer

  function games(c) {
    return V.dayGroups(c.ties, tieBox, { expanded, onToggle: render });
  }

  function tieBox(t) {
      const box = el('div', 'st-tie');
      const head = el('div', 'st-tie-head');
      const left = el('div');
      left.appendChild(el('div', 'st-tie-meta', `${t.time} · ${t.court} · ${V.phaseText(t)}`));
      const vs = el('div', 'st-vs');
      const ph = (side) => V.chip(view, t[side], t.slots ? V.slotText(t.slots[side]).replace(' Group ', ' ') : '?');
      vs.append(ph('home'), el('span', '', V.regionName(view, t.home)), el('span', 'vs', 'vs'), ph('away'), el('span', '', V.regionName(view, t.away)));
      left.appendChild(vs);
      const r = t.result;
      const score = el('div', 'st-score ' + (r.finished ? 'done' : r.started ? 'live' : 'none'), r.started ? `${r.home}–${r.away}` : '—');
      head.append(left, score);
      box.appendChild(head);
      const played = t.matches.filter((m) => m.sets.length);
      if (played.length) {
        const list = el('div', 'st-matches');
        t.matches.forEach((m, i) => {
          if (!m.sets.length) return;
          const row = el('div', 'st-match');
          const names = el('span', 'pairs-txt');
          const home = V.pairText(view, m.home) || V.regionName(view, t.home);
          const away = V.pairText(view, m.away) || V.regionName(view, t.away);
          const h = el(m.result.winner === 'home' ? 'b' : 'span', '', home);
          const a = el(m.result.winner === 'away' ? 'b' : 'span', '', away);
          names.append(el('span', 'cv-muted', `${i + 1}. `), h, document.createTextNode(' vs '), a);
          row.append(names, el('span', 'sets-txt', V.setsText(m.sets)));
          list.appendChild(row);
        });
        box.appendChild(list);
      }
      return box;
  }

  load();
  setInterval(load, 30000);
})();

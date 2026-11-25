/* Shared rendering for the regional competition (Competition and Standings pages):
   region chips, group tables, the final ranking and score texts. */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /** Dark or light text for a region colour. */
  function inkFor(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#061433' : '#ffffff';
  }

  function regionMap(view) {
    return new Map((view.regions || []).map((r) => [r.id, r]));
  }

  /** The region's code on its colour (or a grey placeholder text). */
  function chip(view, id, placeholder) {
    const r = id && regionMap(view).get(id);
    if (!r) return el('span', 'rchip rchip-empty', placeholder || '?');
    const c = el('span', 'rchip', r.short || r.id);
    c.style.background = r.color || '#334';
    c.style.color = inkFor(r.color);
    c.title = r.name;
    return c;
  }

  function regionName(view, id) {
    const r = id && regionMap(view).get(id);
    return r ? r.name : '';
  }

  function ordinal(n) {
    return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
  }

  /** "1st A" for a classification slot. */
  function slotText(slot) {
    return slot ? `${ordinal(slot.pos)} Group ${slot.group}` : '';
  }

  function phaseText(t) {
    if (t.phase === 'place') return `Places ${t.place}–${t.place + 1}`;
    return `Group ${t.group} · Round ${t.round}`;
  }

  /** "6-3 4-6 7-6 (10-6)" from the home side. */
  function setsText(sets) {
    return (sets || []).map((s) => (s.tbh !== undefined ? `${s.h}-${s.a} (${s.tbh}-${s.tba})` : `${s.h}-${s.a}`)).join('  ');
  }

  function shortName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || '';
    return parts[0][0] + '. ' + parts.slice(1).join(' ');
  }

  function pairText(view, ids) {
    const byId = new Map((view.players || []).map((p) => [p.id, p]));
    return (ids || []).map((id) => shortName((byId.get(id) || {}).name || '?')).join(' / ');
  }

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayText(iso) {
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d)) return iso || '';
    return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  function signed(n) {
    return n > 0 ? '+' + n : String(n);
  }

  /** One group's table. */
  function standingsTable(view, group, name) {
    const box = el('div', 'cv-group');
    const head = el('div', 'cv-group-head');
    head.append(el('h3', '', `Group ${name}`), el('span', 'cv-muted', `${group.tiesFinished} of ${group.ties} ties played`));
    box.appendChild(head);
    const table = el('table', 'cv-table');
    const tr = el('tr');
    for (const [t, cls, title] of [
      ['#', 'c-pos'], ['Region', 'c-region'], ['P', 'c-num', 'Ties played'], ['W', 'c-num', 'Ties won'], ['L', 'c-num', 'Ties lost'],
      ['Matches', 'c-num', 'Matches won–lost'], ['Sets', 'c-num c-wide', 'Sets won–lost (difference)'], ['Games', 'c-num c-wide', 'Games won–lost (difference)'],
    ]) {
      const th = el('th', cls, t);
      if (title) th.title = title;
      tr.appendChild(th);
    }
    table.appendChild(tr);
    for (const r of group.rows) {
      const row = el('tr');
      row.appendChild(el('td', 'c-pos', String(r.pos)));
      const rc = el('td', 'c-region');
      rc.append(chip(view, r.region), el('span', 'cv-rname', regionName(view, r.region)));
      row.appendChild(rc);
      row.appendChild(el('td', 'c-num', String(r.played)));
      row.appendChild(el('td', 'c-num c-strong', String(r.won)));
      row.appendChild(el('td', 'c-num', String(r.lost)));
      row.appendChild(el('td', 'c-num', `${r.matchesW}–${r.matchesL}`));
      const sets = el('td', 'c-num c-wide', `${r.setsW}–${r.setsL} `);
      sets.appendChild(el('small', '', `(${signed(r.setsW - r.setsL)})`));
      row.appendChild(sets);
      const games = el('td', 'c-num c-wide', `${r.gamesW}–${r.gamesL} `);
      games.appendChild(el('small', '', `(${signed(r.gamesW - r.gamesL)})`));
      row.appendChild(games);
      table.appendChild(row);
    }
    box.appendChild(table);
    return box;
  }

  function standings(view, cat) {
    const box = el('div', 'cv-standings');
    for (const name of Object.keys(cat.groups)) box.appendChild(standingsTable(view, cat.groups[name], name));
    box.appendChild(el('p', 'cv-muted cv-note', 'Ranking: ties won, then match difference, then set difference, then game difference. A super tie-break counts as a 7-6 set.'));
    return box;
  }

  function ranking(view, cat) {
    const box = el('div', 'cv-ranking');
    const ties = new Map(cat.ties.map((t) => [t.id, t]));
    for (const r of cat.ranking) {
      const row = el('div', 'cv-rank-row' + (r.region ? '' : ' pending'));
      row.appendChild(el('span', 'cv-place', ordinal(r.place)));
      if (r.region) {
        row.append(chip(view, r.region), el('span', 'cv-rname', regionName(view, r.region)));
        if (r.bye) row.appendChild(el('span', 'cv-muted', '(no tie: Group B has 3 regions)'));
      } else if (r.bye) {
        row.appendChild(el('span', 'cv-muted', `${slotText(r.slot)} — no tie, Group B has 3 regions`));
      } else {
        const t = ties.get(r.tieId);
        row.appendChild(el('span', 'cv-muted', t ? `${t.home ? regionName(view, t.home) : slotText(t.slots.home)} vs ${t.away ? regionName(view, t.away) : slotText(t.slots.away)} · ${dayText(t.day)} ${t.time} ${t.court}` : ''));
      }
      box.appendChild(row);
    }
    return box;
  }

  global.CompView = { el, chip, regionName, ordinal, slotText, phaseText, setsText, pairText, shortName, dayText, standings, ranking, inkFor };
})(window);

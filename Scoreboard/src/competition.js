'use strict';

/*
 * Regional competition (Echipa Națională 2027 — Etapa I, Brașov): groups, ties,
 * standings and the final ranking, for men and women separately.
 *
 * A tie is one region against another: three doubles matches (Pair 1, 2, 3),
 * always all three played. A match is best of 3 sets; the third set is a
 * super tie-break to 10 (win by 2), recorded as 7-6 with its points (10-6).
 *
 * Stored in the regional roster as `competition`:
 *   { name, createdAt, ties: [{ id, category: 'M'|'F', phase: 'group'|'place',
 *       group?, round?, home?, away?,            (group ties: region ids)
 *       place?, slots?: { home: {group,pos}, away: {group,pos} },   (classification)
 *       day, time, court,
 *       matches: [{ home: [playerId, playerId], away: [...], sets: [{h,a,tbh?,tba?}], updatedAt }] x3 }],
 *     byes: [{ category, place, slot: {group,pos} }] }
 *
 * Group ranking: ties won, then match difference, then set difference, then
 * game difference (then the tie between the two, then the region number).
 *
 * Everything here is pure (no I/O): server.js saves the roster.
 */

/** "Region n" of the federation's documents → region id in the regional roster. */
const REGION_NUMBER = { 1: 'BI', 2: 'NE', 3: 'SE', 4: 'SM', 5: 'SV', 6: 'V', 7: 'NV', 8: 'C' };
const NUMBER_OF = Object.fromEntries(Object.entries(REGION_NUMBER).map(([n, id]) => [id, Number(n)]));

const CATEGORY_LABEL = { M: 'Men', F: 'Women' };

/**
 * The Brașov schedule (Schedule Proposal, revised: Monday finishes by 17:00).
 * Group ties: [category, group, round, day, time, court, homeRegionNo, awayRegionNo].
 */
const GROUP_TIES = [
  ['F', 'A', 1, '2026-11-28', '16:00', 'T1', 1, 7],
  ['F', 'A', 1, '2026-11-28', '16:00', 'T2', 3, 5],
  ['F', 'B', 1, '2026-11-28', '16:00', 'T5', 4, 6],
  ['M', 'A', 1, '2026-11-28', '19:00', 'T1', 1, 7],
  ['M', 'A', 1, '2026-11-28', '19:00', 'T2', 3, 5],
  ['M', 'B', 1, '2026-11-28', '19:00', 'T4', 4, 6],
  ['M', 'B', 1, '2026-11-28', '19:00', 'T5', 2, 8],
  ['F', 'A', 2, '2026-11-29', '08:00', 'T1', 1, 5],
  ['F', 'A', 2, '2026-11-29', '08:00', 'T2', 7, 3],
  ['F', 'B', 2, '2026-11-29', '08:00', 'T3', 4, 8],
  ['M', 'A', 2, '2026-11-29', '17:00', 'T1', 1, 5],
  ['M', 'A', 2, '2026-11-29', '17:00', 'T2', 7, 3],
  ['M', 'B', 2, '2026-11-29', '17:00', 'T3', 2, 6],
  ['M', 'B', 2, '2026-11-29', '17:00', 'T4', 8, 4],
  ['F', 'A', 3, '2026-11-29', '20:00', 'T1', 1, 3],
  ['F', 'A', 3, '2026-11-29', '20:00', 'T2', 5, 7],
  ['F', 'B', 3, '2026-11-29', '20:00', 'T3', 6, 8],
  ['M', 'A', 3, '2026-11-30', '08:00', 'T1', 1, 3],
  ['M', 'A', 3, '2026-11-30', '08:00', 'T2', 5, 7],
  ['M', 'B', 3, '2026-11-30', '08:00', 'T3', 2, 4],
  ['M', 'B', 3, '2026-11-30', '08:00', 'T4', 6, 8],
];
/** Classification ties: [category, place, day, time, court] — nth of Group A vs nth of Group B for places place..place+1. */
const PLACE_TIES = [
  ['F', 1, '2026-11-30', '11:00', 'T1'],
  ['F', 3, '2026-11-30', '11:00', 'T2'],
  ['F', 5, '2026-11-30', '11:00', 'T3'],
  ['M', 1, '2026-11-30', '14:00', 'T1'],
  ['M', 3, '2026-11-30', '14:00', 'T2'],
  ['M', 5, '2026-11-30', '14:00', 'T3'],
  ['M', 7, '2026-11-30', '14:00', 'T4'],
];
/** Women's Group B has 3 regions: the 4th of Group A finishes 7th without a tie. */
const BYES = [{ category: 'F', place: 7, slot: { group: 'A', pos: 4 } }];

const MATCHES_PER_TIE = 3;

function emptyMatch() {
  return { home: [], away: [], sets: [] };
}

/** The Etapa I competition with every tie of the schedule and no results. */
function createCompetition(name) {
  const ties = [];
  for (const [category, group, round, day, time, court, h, a] of GROUP_TIES) {
    ties.push({
      id: `${category}-${group}${round}-${h}${a}`,
      category,
      phase: 'group',
      group,
      round,
      home: REGION_NUMBER[h],
      away: REGION_NUMBER[a],
      day,
      time,
      court,
      matches: Array.from({ length: MATCHES_PER_TIE }, emptyMatch),
    });
  }
  for (const [category, place, day, time, court] of PLACE_TIES) {
    const pos = (place + 1) / 2;
    ties.push({
      id: `${category}-P${place}`,
      category,
      phase: 'place',
      place,
      slots: { home: { group: 'A', pos }, away: { group: 'B', pos } },
      day,
      time,
      court,
      matches: Array.from({ length: MATCHES_PER_TIE }, emptyMatch),
    });
  }
  return {
    name: String(name || '').trim() || 'Etapa I — Brașov',
    createdAt: new Date().toISOString(),
    ties,
    byes: BYES.map((b) => ({ ...b, slot: { ...b.slot } })),
  };
}

// ---- scores -----------------------------------------------------------------

function int(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : NaN;
}

/** A finished normal set: 6-0..6-4, 7-5, 7-6 (either way). */
function validSet(h, a) {
  const [w, l] = h > a ? [h, a] : [a, h];
  return (w === 6 && l <= 4) || (w === 7 && (l === 5 || l === 6));
}

/** A finished super tie-break to 10, win by 2. */
function validSuperTiebreak(h, a) {
  const [w, l] = h > a ? [h, a] : [a, h];
  return w >= 10 && w - l >= 2 && (w === 10 || w - l === 2);
}

/**
 * Checks and normalises the entered score of one match.
 * input: { sets: [[h, a], [h, a]], tiebreak: [h, a] } — blank sets at the end
 * are allowed (a match in progress). The tie-break (third set) is only allowed
 * at one set all and is stored as 7-6 with its points.
 * Returns the stored sets [{h, a, tbh?, tba?}]; throws a readable error.
 */
function normaliseScore(input) {
  const out = [];
  const rows = Array.isArray(input && input.sets) ? input.sets.slice(0, 2) : [];
  let blank = false;
  rows.forEach((s, i) => {
    const h = int(s && s[0]);
    const a = int(s && s[1]);
    if (h === null && a === null) {
      blank = true;
      return;
    }
    if (blank) throw new Error(`set ${i + 1} is filled in but set ${i} is empty`);
    if (h === null || a === null || Number.isNaN(h) || Number.isNaN(a)) throw new Error(`set ${i + 1}: enter both scores`);
    if (!validSet(h, a)) throw new Error(`set ${i + 1}: ${h}-${a} is not a finished set (6-0 … 6-4, 7-5, 7-6)`);
    out.push({ h, a });
  });
  const tb = input && input.tiebreak;
  const th = int(tb && tb[0]);
  const ta = int(tb && tb[1]);
  if (th !== null || ta !== null) {
    const setsH = out.filter((s) => s.h > s.a).length;
    if (out.length !== 2 || setsH !== 1) throw new Error('the super tie-break is played only at one set all');
    if (th === null || ta === null || Number.isNaN(th) || Number.isNaN(ta)) throw new Error('super tie-break: enter both scores');
    if (!validSuperTiebreak(th, ta)) throw new Error(`super tie-break: ${th}-${ta} is not finished (to 10, win by 2)`);
    out.push(th > ta ? { h: 7, a: 6, tbh: th, tba: ta } : { h: 6, a: 7, tbh: th, tba: ta });
  }
  return out;
}

/** Result of a stored match: { setsH, setsA, gamesH, gamesA, winner: 'home'|'away'|null }. */
function matchResult(m) {
  const r = { setsH: 0, setsA: 0, gamesH: 0, gamesA: 0, winner: null };
  for (const s of (m && m.sets) || []) {
    r.gamesH += s.h;
    r.gamesA += s.a;
    if (s.h > s.a) r.setsH++;
    else r.setsA++;
  }
  if (r.setsH === 2) r.winner = 'home';
  else if (r.setsA === 2) r.winner = 'away';
  return r;
}

/** Result of a tie: matches won by each side, finished when all three matches are. */
function tieResult(tie) {
  const r = { home: 0, away: 0, played: 0, started: false, finished: false, winner: null };
  for (const m of tie.matches || []) {
    const mr = matchResult(m);
    if ((m.sets || []).length) r.started = true;
    if (!mr.winner) continue;
    r.played++;
    r[mr.winner]++;
  }
  r.finished = r.played === (tie.matches || []).length && r.played > 0;
  if (r.finished) r.winner = r.home > r.away ? 'home' : 'away';
  return r;
}

// ---- standings ---------------------------------------------------------------

/** The regions of each group of a category, from its group ties (in region-number order). */
function groupsOf(comp, category) {
  const groups = {};
  for (const t of comp.ties) {
    if (t.category !== category || t.phase !== 'group') continue;
    const g = (groups[t.group] = groups[t.group] || new Set());
    g.add(t.home);
    g.add(t.away);
  }
  const out = {};
  for (const name of Object.keys(groups).sort()) out[name] = [...groups[name]].sort((x, y) => (NUMBER_OF[x] || 99) - (NUMBER_OF[y] || 99));
  return out;
}

/**
 * The table of one group: only finished ties count. Each row:
 * { region, played, won, lost, matchesW, matchesL, setsW, setsL, gamesW, gamesL }.
 */
function groupStandings(comp, category, group) {
  const regionsIn = groupsOf(comp, category)[group] || [];
  const rows = new Map(regionsIn.map((id) => [id, { region: id, played: 0, won: 0, lost: 0, matchesW: 0, matchesL: 0, setsW: 0, setsL: 0, gamesW: 0, gamesL: 0 }]));
  const ties = comp.ties.filter((t) => t.category === category && t.phase === 'group' && t.group === group);
  const beat = new Set(); // "winner>loser"
  for (const t of ties) {
    const tr = tieResult(t);
    if (!tr.finished) continue;
    const h = rows.get(t.home);
    const a = rows.get(t.away);
    h.played++;
    a.played++;
    if (tr.winner === 'home') {
      h.won++;
      a.lost++;
      beat.add(`${t.home}>${t.away}`);
    } else {
      a.won++;
      h.lost++;
      beat.add(`${t.away}>${t.home}`);
    }
    for (const m of t.matches) {
      const mr = matchResult(m);
      h.matchesW += mr.winner === 'home' ? 1 : 0;
      h.matchesL += mr.winner === 'away' ? 1 : 0;
      a.matchesW += mr.winner === 'away' ? 1 : 0;
      a.matchesL += mr.winner === 'home' ? 1 : 0;
      h.setsW += mr.setsH;
      h.setsL += mr.setsA;
      a.setsW += mr.setsA;
      a.setsL += mr.setsH;
      h.gamesW += mr.gamesH;
      h.gamesL += mr.gamesA;
      a.gamesW += mr.gamesA;
      a.gamesL += mr.gamesH;
    }
  }
  const key = (r) => [r.won, r.matchesW - r.matchesL, r.setsW - r.setsL, r.gamesW - r.gamesL];
  const list = [...rows.values()];
  list.sort((x, y) => {
    const kx = key(x);
    const ky = key(y);
    for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return ky[i] - kx[i];
    if (beat.has(`${x.region}>${y.region}`)) return -1;
    if (beat.has(`${y.region}>${x.region}`)) return 1;
    return (NUMBER_OF[x.region] || 99) - (NUMBER_OF[y.region] || 99);
  });
  list.forEach((r, i) => (r.pos = i + 1));
  return { rows: list, finished: ties.length > 0 && ties.every((t) => tieResult(t).finished), tiesFinished: ties.filter((t) => tieResult(t).finished).length, ties: ties.length };
}

/** The region in a classification slot, once that group is finished (else null). */
function slotRegion(comp, category, slot, cache) {
  const k = category + slot.group;
  const st = cache[k] || (cache[k] = groupStandings(comp, category, slot.group));
  if (!st.finished) return null;
  const row = st.rows[slot.pos - 1];
  return row ? row.region : null;
}

/** The regions of a tie (classification ties resolved from the standings). */
function tieSides(comp, tie, cache = {}) {
  if (tie.phase !== 'place') return { home: tie.home, away: tie.away };
  return { home: slotRegion(comp, tie.category, tie.slots.home, cache), away: slotRegion(comp, tie.category, tie.slots.away, cache) };
}

/** Final ranking of a category: [{ place, region|null, from }]. */
function finalRanking(comp, category) {
  const cache = {};
  const out = [];
  for (const t of comp.ties.filter((x) => x.category === category && x.phase === 'place').sort((x, y) => x.place - y.place)) {
    const sides = tieSides(comp, t, cache);
    const tr = tieResult(t);
    const w = tr.finished ? sides[tr.winner] : null;
    const l = tr.finished ? sides[tr.winner === 'home' ? 'away' : 'home'] : null;
    out.push({ place: t.place, region: w, tieId: t.id });
    out.push({ place: t.place + 1, region: l, tieId: t.id });
  }
  for (const b of (comp.byes || []).filter((x) => x.category === category)) {
    out.push({ place: b.place, region: slotRegion(comp, category, b.slot, cache), bye: true, slot: b.slot });
  }
  return out.sort((x, y) => x.place - y.place);
}

// ---- changes -----------------------------------------------------------------

function findTie(comp, id) {
  const t = comp && (comp.ties || []).find((x) => x.id === id);
  if (!t) throw new Error('unknown tie');
  return t;
}

/** Day / time / court of a tie. */
function updateTie(comp, id, patch) {
  const t = findTie(comp, id);
  if (typeof patch.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.day)) t.day = patch.day;
  if (typeof patch.time === 'string' && /^\d{2}:\d{2}$/.test(patch.time)) t.time = patch.time;
  if (typeof patch.court === 'string') t.court = patch.court.replace(/\s+/g, ' ').trim().slice(0, 12);
  return t;
}

/**
 * Saves one match of a tie: the two pairs (player ids of each side's region,
 * blank allowed until known) and the score. roster: the regional roster (players, gender, region).
 */
function updateMatch(comp, roster, body) {
  const t = findTie(comp, body.tieId);
  const idx = Number(body.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= t.matches.length) throw new Error('unknown match');
  const sides = tieSides(comp, t);
  const byId = new Map(((roster && roster.players) || []).map((p) => [p.id, p]));
  const pair = (ids, side) => {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 2);
    if (list.length === 2 && list[0] === list[1]) throw new Error('pick two different players');
    for (const pid of list) {
      const p = byId.get(pid);
      if (!p) throw new Error('unknown player');
      if (p.gender !== t.category) throw new Error(`${p.name} is not in the ${CATEGORY_LABEL[t.category].toLowerCase()}'s competition`);
      if (sides[side] && p.region !== sides[side]) throw new Error(`${p.name} does not play for this region`);
    }
    return list;
  };
  const m = t.matches[idx];
  const home = pair(body.home, 'home');
  const away = pair(body.away, 'away');
  const used = new Set();
  t.matches.forEach((other, j) => {
    if (j === idx) return;
    for (const pid of [...(other.home || []), ...(other.away || [])]) used.add(pid);
  });
  const twice = [...home, ...away].find((pid) => used.has(pid));
  if (twice) throw new Error(`${byId.get(twice).name} already plays another match of this tie`);
  m.home = home;
  m.away = away;
  m.sets = normaliseScore(body);
  m.updatedAt = new Date().toISOString();
  return t;
}

// ---- the view for the pages ---------------------------------------------------

/** Everything the Competition and Standings pages show, computed from the stored data. */
function view(comp, roster) {
  const regionsList = ((roster && roster.regions) || []).map((r) => ({ id: r.id, name: r.name, short: r.short, color: r.color, number: NUMBER_OF[r.id] || null }));
  const players = ((roster && roster.players) || []).map((p) => ({ id: p.id, name: p.name, region: p.region, gender: p.gender, available: p.available !== false }));
  if (!comp) return { exists: false, regions: regionsList, players };
  const categories = {};
  for (const category of ['M', 'F']) {
    const cache = {};
    const groups = {};
    for (const g of Object.keys(groupsOf(comp, category))) groups[g] = (cache[category + g] = groupStandings(comp, category, g));
    const ties = comp.ties
      .filter((t) => t.category === category)
      .map((t) => {
        const sides = tieSides(comp, t, cache);
        const result = tieResult(t);
        return {
          id: t.id,
          phase: t.phase,
          group: t.group || null,
          round: t.round || null,
          place: t.place || null,
          slots: t.slots || null,
          home: sides.home,
          away: sides.away,
          day: t.day,
          time: t.time,
          court: t.court,
          result,
          matches: t.matches.map((m) => ({
            home: m.home || [],
            away: m.away || [],
            sets: m.sets || [],
            result: matchResult(m),
            updatedAt: m.updatedAt || null,
            // a classification tie whose regions changed after a result was entered
            mismatch:
              [...(m.home || [])].some((pid) => sides.home && (players.find((p) => p.id === pid) || {}).region !== sides.home) ||
              [...(m.away || [])].some((pid) => sides.away && (players.find((p) => p.id === pid) || {}).region !== sides.away),
          })),
        };
      })
      .sort((x, y) => (x.day + x.time + x.court).localeCompare(y.day + y.time + y.court));
    categories[category] = { label: CATEGORY_LABEL[category], groups, ties, ranking: finalRanking(comp, category) };
  }
  return { exists: true, name: comp.name, regions: regionsList, players, categories };
}

module.exports = {
  REGION_NUMBER,
  MATCHES_PER_TIE,
  createCompetition,
  normaliseScore,
  validSet,
  validSuperTiebreak,
  matchResult,
  tieResult,
  groupsOf,
  groupStandings,
  tieSides,
  finalRanking,
  updateTie,
  updateMatch,
  view,
};

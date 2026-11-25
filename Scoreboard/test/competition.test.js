'use strict';

/* Tests for the regional competition (src/competition.js): the Brașov schedule,
   score checks, group standings, classification ties and the final ranking. */

const C = require('../src/competition');
const R = require('../src/regions');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ FAIL: ' + msg);
  }
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
function throws(fn, re, msg) {
  try {
    fn();
    assert(false, msg + ' (no error)');
  } catch (e) {
    assert(re.test(e.message), `${msg} (error: ${e.message})`);
  }
}

console.log('\nRunning competition tests…\n');

// ---- a roster with 4 men and 4 women in every region (no women in NE) ----
function roster() {
  const r = R.newRegionalRoster('Etapa I');
  for (const reg of r.regions) {
    const lines = [1, 2, 3, 4, 5, 6].map((n) => `${reg.id} man ${n}`).join('\n');
    R.addPlayers(r, reg.id, R.parsePlayerLines(lines, 'M').players);
    if (reg.id !== 'NE') R.addPlayers(r, reg.id, R.parsePlayerLines([1, 2, 3, 4, 5, 6].map((n) => `${reg.id} woman ${n}`).join('\n'), 'F').players);
  }
  return r;
}
const ros = roster();
const pool = (region, gender) => ros.players.filter((p) => p.region === region && p.gender === gender).map((p) => p.id);

// ---- the schedule ----
let comp = C.createCompetition();
const men = comp.ties.filter((t) => t.category === 'M');
const women = comp.ties.filter((t) => t.category === 'F');
eq([men.filter((t) => t.phase === 'group').length, men.filter((t) => t.phase === 'place').length], [12, 4], 'men: 12 group ties, 4 classification ties');
eq([women.filter((t) => t.phase === 'group').length, women.filter((t) => t.phase === 'place').length], [9, 3], 'women: 9 group ties, 3 classification ties');
eq(C.groupsOf(comp, 'M'), { A: ['BI', 'SE', 'SV', 'NV'], B: ['NE', 'SM', 'V', 'C'] }, 'men groups: A = Regions 1 3 5 7, B = 2 4 6 8');
eq(C.groupsOf(comp, 'F'), { A: ['BI', 'SE', 'SV', 'NV'], B: ['SM', 'V', 'C'] }, 'women groups: A = Regions 1 3 5 7, B = 4 6 8');
const sat = comp.ties.find((t) => t.id === 'M-B1-28');
eq([sat.day, sat.time, sat.court, sat.home, sat.away], ['2026-11-28', '19:00', 'T5', 'NE', 'C'], 'Saturday 19:00 T5: men Region 2 vs Region 8');
for (const cat of ['M', 'F']) {
  const pairs = new Set();
  for (const t of comp.ties.filter((x) => x.category === cat && x.phase === 'group')) pairs.add([t.home, t.away].sort().join('-'));
  const g = C.groupsOf(comp, cat);
  const expected = Object.values(g).reduce((n, list) => n + (list.length * (list.length - 1)) / 2, 0);
  assert(pairs.size === expected, `${cat}: every region meets every other region of its group once`);
}
assert(comp.ties.every((t) => t.matches.length === 3), 'every tie has 3 matches');
eq(new Set(comp.ties.map((t) => t.id)).size, comp.ties.length, 'tie ids are unique');

// ---- scores ----
eq(C.normaliseScore({ sets: [[6, 3], [6, 4]] }), [{ h: 6, a: 3 }, { h: 6, a: 4 }], 'two sets');
eq(C.normaliseScore({ sets: [[6, 3], [4, 6]], tiebreak: [10, 6] }), [{ h: 6, a: 3 }, { h: 4, a: 6 }, { h: 7, a: 6, tbh: 10, tba: 6 }], 'super tie-break 10-6 stored as 7-6');
eq(C.normaliseScore({ sets: [[3, 6], [7, 5]], tiebreak: [10, 12] })[2], { h: 6, a: 7, tbh: 10, tba: 12 }, 'super tie-break 10-12 stored as 6-7');
eq(C.normaliseScore({ sets: [[7, 6], ['', '']] }), [{ h: 7, a: 6 }], 'a match in progress (one set)');
eq(C.normaliseScore({ sets: [] }), [], 'no score yet');
throws(() => C.normaliseScore({ sets: [[6, 5]] }), /not a finished set/, '6-5 is not a finished set');
throws(() => C.normaliseScore({ sets: [[8, 6]] }), /not a finished set/, '8-6 is not a finished set');
throws(() => C.normaliseScore({ sets: [[6, 2], [6, 1]], tiebreak: [10, 4] }), /one set all/, 'no tie-break after 2-0');
throws(() => C.normaliseScore({ sets: [[6, 2], [3, 6]], tiebreak: [10, 9] }), /win by 2/, '10-9 is not a finished tie-break');
throws(() => C.normaliseScore({ sets: [[6, 2], [3, 6]], tiebreak: [13, 10] }), /win by 2/, '13-10 is not a finished tie-break');
eq(C.normaliseScore({ sets: [[6, 2], [3, 6]], tiebreak: [12, 10] })[2].tbh, 12, '12-10 is a finished tie-break');
throws(() => C.normaliseScore({ sets: [['', ''], [6, 2]] }), /set 1 is empty/, 'set 2 without set 1');
throws(() => C.normaliseScore({ sets: [[6, '']] }), /both scores/, 'one score missing');

// ---- entering ties ----
/** Plays a tie: results per match as 'h'/'a' (home/away wins, 6-3 6-3) or a score object. */
function play(c, id, results) {
  const t = c.ties.find((x) => x.id === id);
  const sides = C.tieSides(c, t);
  const ph = pool(sides.home, t.category);
  const pa = pool(sides.away, t.category);
  results.forEach((r, i) => {
    const score = r === 'h' ? { sets: [[6, 3], [6, 3]] } : r === 'a' ? { sets: [[3, 6], [3, 6]] } : r;
    C.updateMatch(c, ros, { tieId: id, index: i, home: [ph[2 * i], ph[2 * i + 1]], away: [pa[2 * i], pa[2 * i + 1]], ...score });
  });
}

comp = C.createCompetition();
throws(() => C.updateMatch(comp, ros, { tieId: 'M-A1-17', index: 0, home: [pool('SE', 'M')[0], pool('BI', 'M')[0]], away: [], sets: [] }), /does not play for this region/, 'a player of another region is refused');
throws(() => C.updateMatch(comp, ros, { tieId: 'M-A1-17', index: 0, home: [pool('BI', 'F')[0]], away: [], sets: [] }), /not in the men/, 'a woman in the men\'s tie is refused');
C.updateMatch(comp, ros, { tieId: 'M-A1-17', index: 0, home: pool('BI', 'M').slice(0, 2), away: [], sets: [] });
throws(() => C.updateMatch(comp, ros, { tieId: 'M-A1-17', index: 1, home: pool('BI', 'M').slice(1, 3), away: [], sets: [] }), /already plays another match/, 'a player in two matches of one tie is refused');
C.updateMatch(comp, ros, { tieId: 'M-A1-17', index: 0, home: [], away: [], sets: [] });

play(comp, 'M-A1-17', ['h', 'a', 'h']);
let tr = C.tieResult(comp.ties.find((t) => t.id === 'M-A1-17'));
eq([tr.home, tr.away, tr.finished, tr.winner], [2, 1, true, 'home'], 'tie 2-1, finished, home wins');
play(comp, 'M-A1-35', ['h', 'h']);
tr = C.tieResult(comp.ties.find((t) => t.id === 'M-A1-35'));
eq([tr.home, tr.away, tr.finished], [2, 0, false], '2-0 after two matches: not finished (the third is played)');

// ---- standings: ties won, then matches, then sets, then games ----
comp = C.createCompetition();
// Group A men: BI (1), SE (3), SV (5), NV (7)
play(comp, 'M-A1-17', ['h', 'h', 'h']); // BI 3-0 NV
play(comp, 'M-A1-35', ['h', 'a', 'h']); // SE 2-1 SV
play(comp, 'M-A2-15', ['a', 'a', 'h']); // SV 2-1 BI
play(comp, 'M-A2-73', ['h', 'h', 'a']); // NV 2-1 SE
play(comp, 'M-A3-13', ['h', 'a', 'h']); // BI 2-1 SE
let st = C.groupStandings(comp, 'M', 'A');
assert(!st.finished && st.tiesFinished === 5, 'group not finished with one tie left');
eq(C.tieSides(comp, comp.ties.find((t) => t.id === 'M-P1')), { home: null, away: null }, 'classification ties wait for the groups');
play(comp, 'M-A3-57', ['h', 'a', 'h']); // SV 2-1 NV
st = C.groupStandings(comp, 'M', 'A');
// wins: BI 2, SV 2, SE 1, NV 1; BI matches 3+1+2=6-3, SV 1+2+2=5-4 → BI first
eq(st.rows.map((r) => r.region), ['BI', 'SV', 'SE', 'NV'], 'ranking: wins, then match difference (' + JSON.stringify(st.rows.map((r) => [r.region, r.won, r.matchesW - r.matchesL])) + ')');
eq([st.rows[0].won, st.rows[0].matchesW, st.rows[0].matchesL, st.rows[0].setsW, st.rows[0].setsL, st.rows[0].gamesW, st.rows[0].gamesL], [2, 6, 3, 12, 6, 90, 72], 'BI row: ties, matches, sets, games');
assert(st.finished, 'group finished after its 6 ties');
// SE (1 win, 4-5) and NV (1 win, 3-6 matches): SE ahead on matches

// set difference decides when wins and matches are equal
comp = C.createCompetition();
const wide = { sets: [[6, 0], [6, 0]] };
const tight = { sets: [[6, 4], [4, 6]], tiebreak: [10, 8] };
const lostTight = { sets: [[4, 6], [6, 4]], tiebreak: [8, 10] };
// every region wins one tie 2-1 … (rotate) — make SE and SV equal on wins and matches, SE with more sets
play(comp, 'M-A1-17', ['h', 'h', 'h']); // BI 3-0 NV
play(comp, 'M-A2-15', ['a', 'a', 'a']); // SV 3-0 BI
play(comp, 'M-A3-13', ['a', 'a', 'a']); // SE 3-0 BI
play(comp, 'M-A1-35', [wide, 'a', tight]); // SE 2-1 SV (SE sets 2+0+2=4, SV 0+2+1=3)
play(comp, 'M-A2-73', ['a', 'a', 'h']); // SE 2-1 NV (away SE)
play(comp, 'M-A3-57', ['h', 'h', lostTight]); // SV 2-1 NV
st = C.groupStandings(comp, 'M', 'A');
eq(st.rows.map((r) => r.region), ['SE', 'SV', 'BI', 'NV'], 'wins first (SE 3, SV 2, BI 1, NV 0)');
// equal wins and matches → sets: build a direct check of the comparator with games
comp = C.createCompetition();
play(comp, 'M-B1-46', ['h', 'h', 'a']); // SM 2-1 V
play(comp, 'M-B1-28', ['h', 'h', 'a']); // NE 2-1 C
play(comp, 'M-B2-26', ['a', 'a', 'h']); // V 2-1 NE
play(comp, 'M-B2-84', ['a', 'a', 'h']); // SM 2-1 C
play(comp, 'M-B3-24', [{ sets: [[6, 0], [6, 0]] }, { sets: [[6, 0], [6, 0]] }, { sets: [[0, 6], [6, 0]], tiebreak: [10, 0] }]); // NE 3-0 SM, sets 6-1
play(comp, 'M-B3-68', [{ sets: [[6, 4], [6, 4]] }, 'h', 'h']); // V 3-0 C
st = C.groupStandings(comp, 'M', 'B');
eq(st.rows.map((r) => [r.region, r.won, r.matchesW - r.matchesL]), [['V', 2, 3], ['NE', 2, 3], ['SM', 2, -1], ['C', 0, -5]], 'three regions on 2 wins: match difference puts SM third');
eq([st.rows[0].setsW - st.rows[0].setsL, st.rows[1].setsW - st.rows[1].setsL], [6, 5], 'V and NE level on wins and matches: set difference puts V first');

// games decide when wins, matches and sets are equal (women Group B: SM, V, C, each 1 win, 3-3 matches, sets level)
comp = C.createCompetition();
const love = { sets: [[6, 0], [6, 0]] };
play(comp, 'F-B1-46', [love, love, 'a']); // SM 2-1 V, SM games +18
play(comp, 'F-B2-48', ['h', 'a', 'a']); // C 2-1 SM
play(comp, 'F-B3-68', ['h', 'h', 'a']); // V 2-1 C
st = C.groupStandings(comp, 'F', 'B');
assert(st.rows.every((r) => r.won === 1 && r.matchesW === 3 && r.setsW === r.setsL), 'women B: all level on wins, matches and sets');
eq(st.rows.map((r) => [r.region, r.gamesW - r.gamesL]), [['SM', 12], ['C', 0], ['V', -12]], 'game difference decides');

// games decide when wins, matches and sets are equal: a direct two-region check
comp = C.createCompetition();
const twoSets = (h1, a1, h2, a2) => ({ sets: [[h1, a1], [h2, a2]] });
play(comp, 'F-B1-46', [twoSets(6, 0, 6, 0), twoSets(0, 6, 0, 6), twoSets(6, 4, 4, 6)]); // incomplete: third match 1-1 without tie-break
const t46 = comp.ties.find((t) => t.id === 'F-B1-46');
assert(!C.tieResult(t46).finished && C.tieResult(t46).played === 2, 'a match at one set all is not finished');

// ---- classification and final ranking (women: Group B has 3 regions) ----
comp = C.createCompetition();
for (const id of ['F-A1-17', 'F-A1-35', 'F-A2-15', 'F-A2-73', 'F-A3-13', 'F-A3-57']) play(comp, id, ['h', 'h', 'h']); // home always 3-0
// A: BI beats NV, SV, SE → 3 wins; SE beats SV; NV beats SE; SV beats NV → SE, NV, SV on 1 win each
for (const id of ['F-B1-46', 'F-B2-48', 'F-B3-68']) play(comp, id, ['a', 'h', 'h']); // home 2-1
// B: SM beats V and C (2 wins), V beats C (1), C 0
const stA = C.groupStandings(comp, 'F', 'A');
const stB = C.groupStandings(comp, 'F', 'B');
eq(stB.rows.map((r) => r.region), ['SM', 'V', 'C'], 'women B ranking');
assert(stA.rows[0].region === 'BI', 'women A: BI first');
const p1 = comp.ties.find((t) => t.id === 'F-P1');
eq(C.tieSides(comp, p1), { home: 'BI', away: 'SM' }, '1st A vs 1st B for places 1-2');
eq(C.tieSides(comp, comp.ties.find((t) => t.id === 'F-P5')), { home: stA.rows[2].region, away: 'C' }, '3rd A vs 3rd B for places 5-6');
let rk = C.finalRanking(comp, 'F');
eq(rk.map((r) => r.place), [1, 2, 3, 4, 5, 6, 7], 'women: places 1 to 7');
eq(rk[6].region, stA.rows[3].region, 'women: the 4th of Group A is 7th without a tie');
assert(rk[0].region === null, 'places 1-2 open until the final is played');
play(comp, 'F-P1', ['a', 'a', 'h']); // SM 2-1 BI
play(comp, 'F-P3', ['h', 'h', 'h']);
play(comp, 'F-P5', ['a', 'h', 'a']);
rk = C.finalRanking(comp, 'F');
eq(rk.slice(0, 2).map((r) => r.region), ['SM', 'BI'], 'final: SM 1st, BI 2nd');
eq(rk.slice(2, 4).map((r) => r.region), [stA.rows[1].region, 'V'], 'places 3-4');
eq(rk.slice(4, 6).map((r) => r.region), ['C', stA.rows[2].region], 'places 5-6');
assert(new Set(rk.map((r) => r.region)).size === 7, 'women: 7 different regions ranked');
// players of a classification tie must be from the resolved regions
throws(() => C.updateMatch(comp, ros, { tieId: 'F-P1', index: 0, home: [pool('V', 'F')[0]], away: [], sets: [] }), /does not play for this region/, 'classification tie: only the resolved region\'s players');

// men's ranking: 8 places
comp = C.createCompetition();
for (const t of comp.ties.filter((x) => x.category === 'M' && x.phase === 'group')) play(comp, t.id, ['h', 'h', 'a']);
for (const t of comp.ties.filter((x) => x.category === 'M' && x.phase === 'place')) play(comp, t.id, ['a', 'a', 'h']);
rk = C.finalRanking(comp, 'M');
eq(rk.map((r) => r.place), [1, 2, 3, 4, 5, 6, 7, 8], 'men: places 1 to 8');
assert(new Set(rk.map((r) => r.region)).size === 8 && rk.every((r) => r.region), 'men: all 8 regions ranked');

// the view
const vw = C.view(comp, ros);
assert(vw.exists && vw.categories.M.ties.length === 16 && vw.categories.F.ties.length === 12, 'view: all ties of both categories');
assert(vw.categories.M.groups.A.rows.length === 4 && vw.categories.F.groups.B.rows.length === 3, 'view: group tables');
assert(vw.categories.M.ties.every((t, i, a) => i === 0 || (a[i - 1].day + a[i - 1].time + a[i - 1].court) <= t.day + t.time + t.court), 'view: ties in schedule order');
assert(!C.view(null, ros).exists, 'view without a competition');

// tie details
comp = C.createCompetition();
C.updateTie(comp, 'M-P1', { day: '2026-11-30', time: '15:00', court: 'T5' });
const p1m = comp.ties.find((t) => t.id === 'M-P1');
eq([p1m.time, p1m.court], ['15:00', 'T5'], 'time and court of a tie can be changed');
C.updateTie(comp, 'M-P1', { time: '25h' });
eq(p1m.time, '15:00', 'a bad time is ignored');

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed ? 1 : 0);

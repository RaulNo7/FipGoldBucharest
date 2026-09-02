'use strict';

/* Minimal zero-dependency test runner for the padel scoring engine. */

const scoring = require('../src/scoring');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ FAIL: ' + msg);
  }
}

function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

/** Apply a sequence of point winners (array of 0/1) to a state. */
function play(state, points) {
  let s = state;
  for (const t of points) s = scoring.applyCommand(s, { type: 'point', team: t });
  return s;
}

function withConfig(overrides) {
  const s = scoring.createDefaultState();
  Object.assign(s.config, overrides);
  return s;
}

console.log('\nRunning padel scoring tests…\n');

// --- Golden point ---------------------------------------------------------
(function goldenPoint() {
  let s = withConfig({ deuceMode: 'golden' });
  // 40-40 then team 0 wins the golden point -> wins the game.
  s = play(s, [0, 1, 0, 1, 0, 1]); // 3-3 (40-40)
  eq(scoring.pointLabel(s.points, 0, s.config), 'GP', 'golden: 3-3 shows GP (golden point)');
  s = play(s, [0]); // golden point team 0
  eq(s.games, [1, 0], 'golden: team0 wins game on sudden death');
  eq(s.points, [0, 0], 'golden: points reset after game');
})();

// --- Advantage ------------------------------------------------------------
(function advantage() {
  let s = withConfig({ deuceMode: 'advantage' });
  s = play(s, [0, 1, 0, 1, 0, 1]); // 3-3 deuce
  s = play(s, [0]); // Ad team0
  eq(scoring.pointLabel(s.points, 0, s.config), 'Ad1', 'advantage: shows Ad1');
  eq(s.games, [0, 0], 'advantage: no game yet at Ad');
  s = play(s, [1]); // back to deuce (4-4 = deuce #2)
  eq(scoring.pointLabel(s.points, 0, s.config), 'D2', 'advantage: back to deuce shows D2');
  s = play(s, [0, 0]); // Ad then game
  eq(s.games, [1, 0], 'advantage: team0 wins by two');
})();

// --- Star point (custom deuce limit 2) ------------------------------------
(function starPointCustomLimit() {
  let s = withConfig({ deuceMode: 'star', starDeuceLimit: 2 });
  s = play(s, [0, 1, 0, 1, 0, 1]); // 3-3 (deuce #1)
  eq(scoring.pointLabel(s.points, 0, s.config), 'D1', 'star: 3-3 shows D1');
  s = play(s, [0]); // Ad team0 (still advantage, deuce#1 < limit 2)
  eq(scoring.pointLabel(s.points, 0, s.config), 'Ad1', 'star: advantage shows Ad1');
  eq(s.games, [0, 0], 'star: Ad does not win during deuce #1');
  s = play(s, [1]); // 4-4 (deuce #2 == limit) -> sudden-death golden point
  eq(s.points, [4, 4], 'star: reached 4-4');
  eq(scoring.pointLabel(s.points, 0, s.config), 'GP', 'star: golden deuce shows GP');
  eq(scoring.pointLabel(s.points, 1, s.config), 'GP', 'star: GP shows on both teams');
  s = play(s, [1]); // sudden death, team1 wins by one
  eq(s.games, [0, 1], 'star: sudden death awards game on single point at limit');
})();

// --- Silver point (one advantage deuce, then sudden death) -----------------
(function silverPoint() {
  let s = withConfig({ deuceMode: 'silver' });
  s = play(s, [0, 1, 0, 1, 0, 1]); // 3-3 (deuce #1 — advantage play)
  eq(scoring.pointLabel(s.points, 0, s.config), 'D1', 'silver: 40-40 shows D1');
  s = play(s, [0]); // Ad team0
  eq(scoring.pointLabel(s.points, 0, s.config), 'Ad1', 'silver: advantage shows Ad1');
  eq(s.games, [0, 0], 'silver: Ad does not end the game at deuce #1');
  s = play(s, [0]); // team0 wins by two during deuce #1
  eq(s.games, [1, 0], 'silver: winning by two during deuce #1 takes the game');

  // Back to deuce instead: 4-4 becomes sudden death.
  s = withConfig({ deuceMode: 'silver' });
  s = play(s, [0, 1, 0, 1, 0, 1, 0, 1]); // 40-40 then Ad lost -> 4-4 (deuce #2)
  eq(s.points, [4, 4], 'silver: reached 4-4');
  eq(scoring.pointLabel(s.points, 0, s.config), 'GP', 'silver: 4-4 is the sudden-death point');
  s = play(s, [1]); // single point decides
  eq(s.games, [0, 1], 'silver: sudden death awards the game by one point');
})();

// --- Star point (default: two advantage deuces, then sudden death) ---------
(function starPointDefault() {
  let s = withConfig({ deuceMode: 'star' }); // default starDeuceLimit = 3
  s = play(s, [0, 1, 0, 1, 0, 1]); // 3-3 (deuce #1 — advantage play)
  eq(scoring.pointLabel(s.points, 0, s.config), 'D1', 'star default: 40-40 shows D1');
  s = play(s, [0, 1]); // Ad lost -> 4-4 (deuce #2 — still advantage play)
  eq(scoring.pointLabel(s.points, 0, s.config), 'D2', 'star default: 4-4 still advantage (D2)');
  s = play(s, [0]); // Ad team0 at deuce #2
  eq(s.games, [0, 0], 'star default: Ad at deuce #2 does not end the game');
  s = play(s, [1]); // back to 5-5 (deuce #3) -> sudden death
  eq(s.points, [5, 5], 'star default: reached 5-5');
  eq(scoring.pointLabel(s.points, 0, s.config), 'GP', 'star default: 5-5 is the sudden-death point');
  s = play(s, [0]);
  eq(s.games, [1, 0], 'star default: sudden death awards the game by one point');
})();

// --- Normal set win (6-4) -------------------------------------------------
(function setWin() {
  let s = withConfig({ deuceMode: 'golden', tiebreakEnabled: true });
  // Team 0 wins 6 games to 4 -> wins the set.
  const seq = [];
  // win 4 games each first to make it 4-4? simpler: just give team0 6 quick games, team1 4
  // Each game: 4 straight points.
  function game(winner) {
    return [winner, winner, winner, winner];
  }
  let pts = [];
  for (let i = 0; i < 4; i++) pts = pts.concat(game(0));
  for (let i = 0; i < 4; i++) pts = pts.concat(game(1));
  // 4-4 now, team0 wins next two games -> 6-4
  pts = pts.concat(game(0), game(0));
  s = play(s, pts);
  eq(s.setsWon, [1, 0], 'set: team0 wins set 6-4');
  eq(s.sets.length, 1, 'set: one completed set recorded');
  eq([s.sets[0].a, s.sets[0].b], [6, 4], 'set: recorded 6-4');
})();

// --- Tiebreak at 6-6 ------------------------------------------------------
(function tiebreak() {
  let s = withConfig({ deuceMode: 'golden', gamesPerSet: 6, tiebreakEnabled: true, tiebreakPoints: 7 });
  function game(w) { return [w, w, w, w]; }
  let pts = [];
  for (let i = 0; i < 6; i++) pts = pts.concat(game(0)); // would be 6-0; need 6-6
  // Do 6-6 instead:
  s = withConfig({ deuceMode: 'golden', gamesPerSet: 6, tiebreakEnabled: true, tiebreakPoints: 7 });
  pts = [];
  for (let i = 0; i < 6; i++) pts = pts.concat(game(0), game(1)); // 6-6
  s = play(s, pts);
  eq(s.inTiebreak, true, 'tiebreak: entered at 6-6');
  // Team0 wins tiebreak 7-0
  s = play(s, [0, 0, 0, 0, 0, 0, 0]);
  eq(s.setsWon, [1, 0], 'tiebreak: team0 wins the set via tiebreak');
  eq([s.sets[0].a, s.sets[0].b], [7, 6], 'tiebreak: set recorded 7-6');
  assert(s.sets[0].tb && s.sets[0].tb.a === 7, 'tiebreak: tb score recorded');
})();

// --- Match win (best of 3) -----------------------------------------------
(function matchWin() {
  let s = withConfig({ deuceMode: 'golden', setsToWin: 2, gamesPerSet: 6 });
  function game(w) { return [w, w, w, w]; }
  function set0() { let p = []; for (let i = 0; i < 6; i++) p = p.concat(game(0)); return p; }
  s = play(s, set0()); // set 1: 6-0 team0
  s = play(s, set0()); // set 2: 6-0 team0 -> match
  eq(s.status, 'finished', 'match: finished after 2 sets');
  eq(s.winner, 0, 'match: team0 wins match');
})();

// --- Super tiebreak final set --------------------------------------------
(function superTiebreak() {
  let s = withConfig({ deuceMode: 'golden', setsToWin: 2, gamesPerSet: 6, finalSetMode: 'superTiebreak', superTiebreakPoints: 10 });
  function game(w) { return [w, w, w, w]; }
  function set6(w) { let p = []; for (let i = 0; i < 6; i++) p = p.concat(game(w)); return p; }
  s = play(s, set6(0)); // 1-0 team0
  s = play(s, set6(1)); // 1-1 -> deciding set should be super tiebreak
  eq(s.inTiebreak, true, 'superTb: deciding set starts as tiebreak');
  eq(s.inSuperTiebreak, true, 'superTb: flagged super tiebreak');
  s = play(s, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // team0 to 10
  eq(s.status, 'finished', 'superTb: match finished');
  eq(s.winner, 0, 'superTb: team0 wins via super tiebreak');
  assert(s.sets[2].superTb === true, 'superTb: final set marked super');
})();

// --- Server alternation ---------------------------------------------------
(function serverToggle() {
  let s = withConfig({ deuceMode: 'golden' });
  const startServer = s.server;
  s = play(s, [0, 0, 0, 0]); // team0 wins a game
  eq(s.server, 1 - startServer, 'serve: server alternates after a game');
})();

// --- Tournament defaults (FIP Gold Bucharest 2026) -------------------------
(function tournamentDefaults() {
  const s = scoring.createDefaultState();
  eq(s.config.deuceMode, 'star', 'defaults: star point is the default deuce rule');
  eq(s.config.starDeuceLimit, 3, 'defaults: two advantage deuces, then golden point');
  eq(s.config.setsToWin, 2, 'defaults: best of 3 sets');
  eq(s.config.gamesPerSet, 6, 'defaults: 6 games per set');
  eq(s.config.tiebreakEnabled, true, 'defaults: tiebreak at 6-6');
  eq(s.config.tiebreakPoints, 7, 'defaults: tiebreak to 7');
  eq(s.config.tiebreakWinByTwo, true, 'defaults: tiebreak win by two');
  eq(s.config.finalSetMode, 'normal', 'defaults: 3rd set is a normal set');
  eq(s.servingPlayer, 0, 'defaults: servingPlayer present');
  eq(typeof s.teams_registry, 'object', 'defaults: teams_registry present');
  eq(typeof s.teams[0].players[0], 'object', 'defaults: players are {name,country} objects');
})();

// --- Serving player commands (with per-team rotation memory) ---------------
(function servingPlayerCommands() {
  let s = scoring.createDefaultState();
  s = scoring.applyCommand(s, { type: 'setServingPlayer', player: 1 });
  eq(s.servingPlayer, 1, 'servingPlayer: setServingPlayer selects partner 2');
  s = scoring.applyCommand(s, { type: 'swapServingPlayer' });
  eq(s.servingPlayer, 0, 'servingPlayer: swapServingPlayer toggles back');
  s = scoring.applyCommand(s, { type: 'setServingPlayer', player: 1 }); // anchor team0's rotation to partner 2
  s = scoring.applyCommand(s, { type: 'setServer', team: 1 });
  eq(s.server, 1, 'servingPlayer: setServer switches the serving team');
  eq(s.servingPlayer, 0, 'servingPlayer: team 2 serves with its own due partner (player 1)');
  s = scoring.applyCommand(s, { type: 'swapServer' });
  eq(s.server, 0, 'servingPlayer: swapServer switches back to team 1');
  eq(s.servingPlayer, 1, 'servingPlayer: team 1 remembered that partner 2 is its server');
  s = scoring.applyCommand(s, { type: 'setServer', team: 0 });
  eq(s.servingPlayer, 1, 'servingPlayer: re-picking the same team keeps its due partner');
})();

// --- Serve rotation between games (padel rule: partners alternate their
// team's service games; the same player must NOT serve every team turn) -----
(function serveRotationBetweenGames() {
  let s = scoring.createDefaultState(); // team 1 / player 1 serves first
  s = play(s, [0, 0, 0, 0]); // game 1 done -> serve passes
  eq(s.server, 1, 'rotation: serve passes to team 2 after a game');
  eq(s.servingPlayer, 0, 'rotation: team 2 opens with its player 1');
  s = play(s, [0, 0, 0, 0]); // game 2 -> team 1 serves again
  eq(s.server, 0, 'rotation: serve back with team 1');
  eq(s.servingPlayer, 1, 'rotation: team 1 now serves with the PARTNER');
  s = play(s, [0, 0, 0, 0]); // game 3 -> team 2 again
  eq(s.servingPlayer, 1, 'rotation: team 2 also rotates to its partner');
  s = play(s, [0, 0, 0, 0]); // game 4 -> team 1
  eq(s.servingPlayer, 0, 'rotation: back to the first server after a full cycle');
  // A mid-match referee correction re-anchors the rotation from there on.
  s = scoring.applyCommand(s, { type: 'setServingPlayer', player: 1 });
  s = play(s, [0, 0, 0, 0]); // team 1 finished its game served by partner 2
  s = play(s, [0, 0, 0, 0]); // team 2's game; then team 1 serves again:
  eq(s.server, 0, 'rotation: team 1 serving again after the correction cycle');
  eq(s.servingPlayer, 0, 'rotation: team 1 alternates away from the corrected partner');
})();

// --- Serve rotation inside a tiebreak --------------------------------------
(function serveRotationInTiebreak() {
  let s = scoring.createDefaultState();
  function game(w) { return [w, w, w, w]; }
  let pts = [];
  for (let i = 0; i < 6; i++) pts = pts.concat(game(0), game(1)); // 6-6
  s = play(s, pts);
  eq(s.inTiebreak, true, 'tb rotation: tiebreak started at 6-6');
  const firstTeam = s.server;
  const firstPlayer = s.servingPlayer;
  s = play(s, [0]); // after the 1st point the serve passes
  eq(s.server, 1 - firstTeam, 'tb rotation: serve passes after the first point');
  s = play(s, [0, 0]); // two more points -> back to the opening team
  eq(s.server, firstTeam, 'tb rotation: serve returns after a two-point stint');
  eq(s.servingPlayer, 1 - firstPlayer, 'tb rotation: opening team returns with the other partner');
})();

// --- Team selection + elimination registry ---------------------------------
(function teamSelectionAndRegistry() {
  let s = scoring.createDefaultState();
  s = scoring.applyCommand(s, {
    type: 'selectTeam', team: 0, teamId: 'M-MD-01',
    teamData: { id: 'M-MD-01', players: [{ name: 'Enzo Jensen Sirvent', country: 'ITA' }, { name: 'David Gala', country: 'ESP' }] },
  });
  eq(s.teams[0].teamId, 'M-MD-01', 'selectTeam: teamId stored');
  eq(s.teams[0].players[0].country, 'ITA', 'selectTeam: player country stored');
  const noResolve = scoring.applyCommand(s, { type: 'selectTeam', team: 1, teamId: 'X' });
  assert(noResolve === s, 'selectTeam: unresolved team is a no-op');

  s = scoring.applyCommand(s, { type: 'setTeamActive', teamId: 'M-MD-02', active: false });
  eq(s.teams_registry['M-MD-02'], { active: false }, 'registry: team eliminated');
  s = scoring.applyCommand(s, { type: 'resetMatch' });
  eq(s.teams_registry['M-MD-02'], { active: false }, 'registry: elimination survives resetMatch');
  eq(s.teams[0].teamId, 'M-MD-01', 'resetMatch: selected teams kept');
  s = scoring.applyCommand(s, { type: 'setTeamActive', teamId: 'M-MD-02', active: true });
  eq(s.teams_registry['M-MD-02'], { active: true }, 'registry: team reactivated');
})();

// --- Score visibility (commercial breaks) ----------------------------------
(function scoreVisibleFlag() {
  let s = scoring.createDefaultState();
  eq(s.display.scoreVisible, true, 'scoreVisible: defaults to visible');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { scoreVisible: false } });
  eq(s.display.scoreVisible, false, 'scoreVisible: setDisplay can hide the scorebug');
  s = scoring.applyCommand(s, { type: 'startMatch' });
  eq(s.display.scoreVisible, true, 'scoreVisible: startMatch shows it again');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { scoreVisible: false } });
  s = scoring.applyCommand(s, { type: 'point', team: 0 });
  eq(s.display.scoreVisible, true, 'scoreVisible: the first point shows it again');
  // A stray +POINT while the previous match is still "finished" must NOT reveal it.
  s = scoring.applyCommand(s, { type: 'finishMatch', winner: 0 });
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { scoreVisible: false } });
  s = scoring.applyCommand(s, { type: 'point', team: 0 });
  eq(s.display.scoreVisible, false, 'scoreVisible: a point on a finished match stays hidden');
})();

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed ? 1 : 0);

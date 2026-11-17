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
  eq(scoring.pointLabel(s.points, 0, s.config), 'GP', 'golden: 3-3 shows GP (golden point, no advantage)');
  eq(scoring.isSuddenDeathLabel('GP') && scoring.isSuddenDeathLabel('KP') && scoring.isSuddenDeathLabel('SP') && !scoring.isSuddenDeathLabel('D1'), true, 'isSuddenDeathLabel: SP/GP/KP only');
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
  eq(scoring.pointLabel(s.points, 0, s.config), 'SP', 'star: golden deuce shows SP');
  eq(scoring.pointLabel(s.points, 1, s.config), 'SP', 'star: SP shows on both teams');
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
  eq(scoring.pointLabel(s.points, 0, s.config), 'KP', 'silver/killer: 4-4 is the decisive point, shown as KP');
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
  eq(scoring.pointLabel(s.points, 0, s.config), 'SP', 'star default: 5-5 is the sudden-death point');
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

  // Player name corrections (Teams page): stored in the registry, applied to a selected pair.
  s = scoring.applyCommand(s, { type: 'setPlayerName', teamId: 'M-MD-01', player: 1, name: '  David   Gala Jr. ', resolvedName: 'David Gala Jr.' });
  eq(s.teams_registry['M-MD-01'].names, [null, 'David Gala Jr.'], 'rename: override stored (trimmed)');
  eq(s.teams[0].players[1].name, 'David Gala Jr.', 'rename: the selected pair is updated live');
  eq(s.teams[0].players[0].name, 'Enzo Jensen Sirvent', 'rename: the partner is untouched');
  s = scoring.applyCommand(s, { type: 'setTeamActive', teamId: 'M-MD-01', active: false });
  eq(s.teams_registry['M-MD-01'], { names: [null, 'David Gala Jr.'], active: false }, 'rename: elimination keeps the name override');
  s = scoring.applyCommand(s, { type: 'setPlayerName', teamId: 'M-MD-01', player: 1, name: '', resolvedName: 'David Gala' });
  eq(s.teams_registry['M-MD-01'], { active: false }, 'rename: empty name clears the override');
  eq(s.teams[0].players[1].name, 'David Gala', 'rename: clearing restores the entry-list name on the selected pair');
  const noTeam = scoring.applyCommand(s, { type: 'setPlayerName', teamId: '', player: 0, name: 'X' });
  assert(noTeam === s, 'rename: missing teamId is a no-op');

  // Country corrections work the same way (flag follows on every page).
  s = scoring.applyCommand(s, { type: 'setPlayerCountry', teamId: 'M-MD-01', player: 1, country: ' pol ', resolvedCountry: 'POL' });
  eq(s.teams_registry['M-MD-01'].countries, [null, 'POL'], 'country: override stored upper-cased');
  eq(s.teams[0].players[1].country, 'POL', 'country: the selected pair is updated live');
  const badCode = scoring.applyCommand(s, { type: 'setPlayerCountry', teamId: 'M-MD-01', player: 1, country: 'Poland' });
  assert(badCode === s, 'country: anything but a 3-letter code is rejected');
  s = scoring.applyCommand(s, { type: 'setPlayerCountry', teamId: 'M-MD-01', player: 1, country: '', resolvedCountry: 'ESP' });
  eq(s.teams_registry['M-MD-01'], { active: false }, 'country: empty code clears the override');
  eq(s.teams[0].players[1].country, 'ESP', 'country: clearing restores the entry-list code on the selected pair');
})();

// --- Score visibility (commercial breaks) ----------------------------------
(function scoreVisibleFlag() {
  let s = scoring.createDefaultState();
  eq(s.display.scoreVisible, true, 'scoreVisible: defaults to visible');
  eq(s.display.startTime, '', 'startTime: empty by default');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { startTime: '14:30' } });
  eq(s.display.startTime, '14:30', 'startTime: stored by setDisplay (players intro shows it)');
  s = scoring.applyCommand(s, { type: 'resetMatch' });
  eq(s.display.startTime, '14:30', 'startTime: survives a score reset');
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

// --- Players intro visibility ----------------------------------------------
(function introVisibleFlag() {
  let s = scoring.createDefaultState();
  eq(s.display.introVisible, false, 'intro: hidden by default');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { introVisible: true } });
  eq(s.display.introVisible, true, 'intro: setDisplay can show it');
  s = scoring.applyCommand(s, { type: 'startMatch' });
  eq(s.display.introVisible, false, 'intro: startMatch hides it');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { introVisible: true } });
  s = scoring.applyCommand(s, { type: 'point', team: 0 });
  eq(s.display.introVisible, false, 'intro: the first point hides it');
})();

// --- Players intro and scorebug are mutually exclusive -----------------------
(function introAndScoreExclusive() {
  let s = scoring.createDefaultState();
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { introVisible: true } });
  eq([s.display.introVisible, s.display.scoreVisible], [true, false], 'exclusive: showing the players hides the score');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { scoreVisible: true } });
  eq([s.display.introVisible, s.display.scoreVisible], [false, true], 'exclusive: showing the score hides the players');
  s = scoring.applyCommand(s, { type: 'setDisplay', display: { scoreVisible: false } });
  eq([s.display.introVisible, s.display.scoreVisible], [false, false], 'exclusive: hiding one does not force the other on');
})();

// --- Killer point (Score settings option): D1, then the decisive point -------
(function killerPoint() {
  let s = withConfig({ deuceMode: 'silver' });
  s = play(s, [0, 1, 0, 1, 0, 1]); // 40-40
  eq(scoring.pointLabel(s.points, 0, s.config), 'D1', 'killer: 40-40 is played as a normal deuce (D1)');
  s = play(s, [1, 0]); // Ad team1, back to 4-4
  eq(scoring.pointLabel(s.points, 1, s.config), 'KP', 'killer: the second deuce is the killer point (KP)');
  s = play(s, [1]);
  eq(s.games, [0, 1], 'killer: one point decides the game at the killer point');
})();

// --- Match format is switched live with setConfig -----------------------------
(function setConfigSwitchesRules() {
  let s = scoring.createDefaultState();
  s = play(s, [0, 1, 0, 1, 0, 1]); // 40-40 under star point
  eq(scoring.pointLabel(s.points, 0, s.config), 'D1', 'setConfig: star point shows D1 at 40-40');
  s = scoring.applyCommand(s, { type: 'setConfig', config: { deuceMode: 'golden' } });
  eq(scoring.pointLabel(s.points, 0, s.config), 'GP', 'setConfig: switching to golden point relabels 40-40 as GP');
  s = play(s, [0]);
  eq(s.games, [1, 0], 'setConfig: ...and the next point wins the game');
  s = scoring.applyCommand(s, { type: 'resetMatch' });
  eq(s.config.deuceMode, 'golden', 'setConfig: resetMatch keeps the chosen rule');
  s = scoring.applyCommand(s, { type: 'resetAll' });
  eq(s.config.deuceMode, 'star', 'setConfig: resetAll restores star point');
})();

// --- 3rd set as a maxi tiebreak to 10 -----------------------------------------
(function maxiTiebreakThirdSet() {
  let s = withConfig({ finalSetMode: 'superTiebreak', superTiebreakPoints: 10, tiebreakWinByTwo: true });
  s = scoring.applyCommand(s, { type: 'adjustGames', team: 0, delta: 6 });
  s = scoring.applyCommand(s, { type: 'saveSet' }); // 1-0 in sets
  eq([s.inTiebreak, s.inSuperTiebreak], [false, false], 'maxi: the 2nd set is a normal set');
  s = scoring.applyCommand(s, { type: 'adjustGames', team: 1, delta: 6 });
  s = scoring.applyCommand(s, { type: 'saveSet' }); // 1-1 -> deciding set
  eq([s.inTiebreak, s.inSuperTiebreak, s.games], [true, true, [0, 0]], 'maxi: the deciding set starts straight as a tiebreak');
  const pts = [];
  for (let i = 0; i < 9; i++) pts.push(0, 1); // 9-9
  s = play(s, pts);
  eq(s.points, [9, 9], 'maxi: 9-9 reached');
  s = play(s, [0]); // 10-9: not over (win by 2)
  eq([s.status, s.points], ['live', [10, 9]], 'maxi: 10-9 does not end it (win by 2)');
  s = play(s, [1, 1, 1]); // 10-10, 10-11, 10-12
  eq([s.status, s.winner, s.setsWon], ['finished', 1, [1, 2]], 'maxi: 12-10 wins the match');
  const last = s.sets[s.sets.length - 1];
  eq([last.superTb, last.tb, last.a, last.b], [true, { a: 10, b: 12 }, 6, 7], 'maxi: the set is recorded as 6-7 with the tiebreak points 10-12');
  s = scoring.applyCommand(s, { type: 'removeLastSet' });
  eq([s.status, s.setsWon, s.inSuperTiebreak, s.games, s.points], ['live', [1, 1], true, [0, 0], [10, 12]], 'maxi: removing the set re-opens the maxi tiebreak at its points');

  // With the normal 3rd set (default) the deciding set is played as games.
  s = scoring.createDefaultState();
  s = scoring.applyCommand(s, { type: 'adjustGames', team: 0, delta: 6 });
  s = scoring.applyCommand(s, { type: 'saveSet' });
  s = scoring.applyCommand(s, { type: 'adjustGames', team: 1, delta: 6 });
  s = scoring.applyCommand(s, { type: 'saveSet' });
  eq([s.inTiebreak, s.inSuperTiebreak], [false, false], 'normal 3rd set: no tiebreak at the start of the deciding set');
})();

// ---- The bar under the scoreboard: set point / match point / deuce, numbered per game ----
(function pressureBar() {
  eq([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(scoring.ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'], 'ordinal: English 1st 2nd 3rd 4th ... 11th 21st');

  const L = (st) => scoring.pressureLabel(st);
  // advantage deuces so the game can go back and forth
  let s = scoring.createDefaultState();
  s.config.deuceMode = 'advantage';
  s = scoring.applyCommand(s, { type: 'adjustGames', team: 0, delta: 5 });
  s = scoring.applyCommand(s, { type: 'adjustGames', team: 1, delta: 3 });
  s = play(s, [0, 0]);
  eq(L(s), '', 'pressure: 30-0 at 5-3 is nothing yet');
  s = play(s, [0]);
  eq(L(s), 'SET POINT', 'pressure: 40-0 at 5-3 -> SET POINT');
  s = play(s, [1]);
  eq(L(s), '2nd SET POINT', 'pressure: 40-15 -> 2nd SET POINT');
  s = play(s, [1]);
  eq(L(s), '3rd SET POINT', 'pressure: 40-30 -> 3rd SET POINT');
  s = play(s, [1]);
  eq(L(s), 'DEUCE', 'pressure: 40-40 -> DEUCE');
  s = play(s, [0]);
  eq(L(s), '4th SET POINT', 'pressure: advantage set -> 4th SET POINT');
  s = play(s, [1]);
  eq(L(s), '2nd DEUCE', 'pressure: back to deuce -> 2nd DEUCE');
  s = play(s, [1]);
  eq(L(s), '', 'pressure: advantage to the receiver at 5-3 -> nothing');
  s = play(s, [1]);
  eq([s.games, L(s), s.pressure.setPoint, s.pressure.deuce], [[5, 4], '', 0, 0], 'pressure: the game ends -> counters start again');
  s = play(s, [1, 1, 1]);
  eq(L(s), '', 'pressure: 0-40 at 5-4 for the trailing team is no set point');

  // match point: one set up, 5-3, 40-0
  let m = scoring.createDefaultState();
  m = scoring.applyCommand(m, { type: 'adjustGames', team: 0, delta: 6 });
  m = scoring.applyCommand(m, { type: 'saveSet' });
  m = scoring.applyCommand(m, { type: 'adjustGames', team: 0, delta: 5 });
  m = scoring.applyCommand(m, { type: 'adjustGames', team: 1, delta: 3 });
  m = play(m, [0, 0, 0]);
  eq(L(m), 'MATCH POINT', 'pressure: one set up, 40-0 at 5-3 -> MATCH POINT (not set point)');
  m = play(m, [1]);
  eq(L(m), '2nd MATCH POINT', 'pressure: 40-15 -> 2nd MATCH POINT');
  m = play(m, [0]);
  eq([m.status, L(m)], ['finished', ''], 'pressure: match over -> nothing');

  // tiebreak set point
  let t = scoring.createDefaultState();
  t = scoring.applyCommand(t, { type: 'adjustGames', team: 0, delta: 5 });
  t = scoring.applyCommand(t, { type: 'adjustGames', team: 1, delta: 6 });
  t = play(t, [0, 0, 0, 0]); // 6-6 -> tiebreak
  eq(t.inTiebreak, true, 'pressure: 6-6 starts the tiebreak');
  t = play(t, [1, 1, 1, 1, 1, 1]);
  eq(L(t), 'SET POINT', 'pressure: 0-6 in the tiebreak -> SET POINT');
  t = play(t, [0]);
  eq(L(t), '2nd SET POINT', 'pressure: 1-6 -> 2nd SET POINT');
})();

// ---- Match timer: starts with the match, stops at the end, can be set ----
(function matchClock() {
  let s = scoring.createDefaultState();
  eq(scoring.clockElapsed(s, 5000), 0, 'clock: not started before the match');
  s = scoring.applyCommand(s, { type: 'point', team: 0, now: 1000 });
  eq(s.clock.startedAt, 1000, 'clock: starts with the first point');
  eq(scoring.clockElapsed(s, 61000), 60000, 'clock: running time');
  s = scoring.applyCommand(s, { type: 'setMatchClock', elapsedMs: 65 * 60000, now: 100000 });
  eq(scoring.clockElapsed(s, 100000), 65 * 60000, 'clock: set to 01:05 from the Broadcast section');
  s = scoring.applyCommand(s, { type: 'finishMatch', winner: 0, now: 200000 });
  eq([s.clock.endedAt, scoring.clockElapsed(s, 999999)], [200000, 200000 - (100000 - 65 * 60000)], 'clock: stops when the match ends');
  s = scoring.applyCommand(s, { type: 'setMatchClock', elapsedMs: null, now: 300000 });
  eq(scoring.clockElapsed(s, 300000), 0, 'clock: reset');
  s = scoring.applyCommand(s, { type: 'resetMatch', now: 400000 });
  eq(s.clock, { startedAt: null, endedAt: null }, 'clock: a new match starts without time');
  s = scoring.applyCommand(s, { type: 'startMatch', now: 500000 });
  eq(s.clock.startedAt, 500000, 'clock: Start starts it too');
})();

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed ? 1 : 0);

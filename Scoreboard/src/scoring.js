'use strict';

/**
 * Padel scoring engine.
 *
 * Pure(-ish) functions: every mutating command operates on a cloned state and
 * returns a new state, so the server can keep an undo/redo history simply by
 * snapshotting before each command.
 *
 * Scoring rules supported (config.deuceMode):
 *   - 'golden'    : sudden-death point at 40-40 (the deciding "golden point").
 *   - 'advantage' : classic tennis deuce, must win the game by two points.
 *   - 'silver'    : one advantage deuce (40-40), then the next deuce (4-4) is
 *                   a sudden-death point.
 *   - 'star'      : two advantage deuces (40-40 and 4-4), then the next deuce
 *                   (5-5) is a sudden-death point. The threshold can still be
 *                   overridden via `starDeuceLimit` (the Nth deuce is golden).
 *
 * Match format is fully configurable (sets to win, games per set, tiebreaks,
 * final-set behaviour). See createDefaultState() for every option.
 */

const POINT_LABELS = ['0', '15', '30', '40'];

/**
 * For staged deuce modes, the deuce number at which the tied point becomes
 * sudden death: silver = deuce #2 (one advantage deuce first), star = deuce #3
 * by default (two advantage deuces first). Infinity = never sudden death.
 * Deuce numbers: #1 at 40-40, #2 at 4-4, #3 at 5-5, ...
 */
function suddenDeathDeuceNumber(config) {
  switch (config.deuceMode) {
    case 'silver':
      return 2;
    case 'star':
      return config.starDeuceLimit || 3;
    default:
      return Infinity;
  }
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function createDefaultState() {
  return {
    config: {
      deuceMode: 'star', // tournament rule: two advantage deuces, then golden point ('golden' | 'advantage' | 'silver' | 'star')
      starDeuceLimit: 3, // star mode: the Nth deuce is golden (3 => 40-40 & 4-4 advantage, 5-5 golden); silver is fixed at 2
      gamesPerSet: 6,
      setsToWin: 2, // best of 3
      tiebreakEnabled: true,
      tiebreakPoints: 7,
      tiebreakWinByTwo: true,
      finalSetMode: 'normal', // 'normal' | 'tiebreak' | 'superTiebreak'
      superTiebreakPoints: 10,
    },
    teams: [
      { teamId: null, name: '', players: [{ name: 'Player 1', country: '' }, { name: 'Player 2', country: '' }], color: '#2E6CA4', logo: '' },
      { teamId: null, name: '', players: [{ name: 'Player 3', country: '' }, { name: 'Player 4', country: '' }], color: '#D4A017', logo: '' },
    ],
    points: [0, 0], // raw point counts in the current game (or tiebreak points)
    games: [0, 0], // games won in the current set
    sets: [], // completed sets: [{ a, b, tb?: {a,b}, superTb?: bool }]
    setsWon: [0, 0],
    inTiebreak: false,
    inSuperTiebreak: false,
    deuceCount: 0, // number of deuces reached in the current game (star mode)
    server: 0, // team index currently serving (0 or 1)
    servingPlayer: 0, // player index within the serving team (0 or 1)
    teamServers: [0, 0], // per-team rotation memory: which partner serves that team's next service game
    status: 'idle', // 'idle' | 'live' | 'finished'
    winner: null, // team index or null
    display: {
      title: '',
      subtitle: '',
      theme: 'dark', // 'dark' | 'light'
      showSets: true,
      showServe: true,
      showPlayers: true,
      showTitle: true,
      scoreVisible: true, // false while the stream shows commercials; the /tv page ignores it
      introVisible: false, // pre-match players presentation (the /intro overlay page)
    },
    teams_registry: {}, // live Active/Eliminated flags per entry-list teamId ({ [id]: { active } }; missing = active)
    seq: 0, // monotonically increasing change counter (animation hint)
    lastScorer: null, // team that won the last point (animation hint)
  };
}

// ---------------------------------------------------------------------------
// Game-level scoring
// ---------------------------------------------------------------------------

/**
 * Decide whether the current game has a winner given raw point counts.
 * Returns 0, 1, or null.
 */
function gameWinner(p, q, config) {
  const decide = (a, b, aIdx, bIdx) => {
    switch (config.deuceMode) {
      case 'golden':
        // Win by one once a team reaches 4 points (sudden death at 40-40).
        if (a >= 4 && a > b) return aIdx;
        break;
      case 'advantage':
        if (a >= 4 && a - b >= 2) return aIdx;
        break;
      case 'silver':
      case 'star': {
        const bothAtDeuce = a >= 3 && b >= 3;
        if (!bothAtDeuce) {
          if (a >= 4 && a - b >= 2) return aIdx;
        } else {
          // deuceNumber: 1 at 3-3, 2 at 4-4, ... (min point count minus 2)
          const deuceNumber = Math.min(a, b) - 2;
          if (deuceNumber >= suddenDeathDeuceNumber(config)) {
            // Sudden death: win by one.
            if (a >= 4 && a > b) return aIdx;
          } else if (a >= 4 && a - b >= 2) {
            return aIdx;
          }
        }
        break;
      }
      default:
        if (a >= 4 && a - b >= 2) return aIdx;
    }
    return null;
  };
  const w0 = decide(p, q, 0, 1);
  if (w0 !== null) return w0;
  return decide(q, p, 1, 0);
}

/**
 * Human-readable point label for a team in a normal (non-tiebreak) game.
 * Handles deuce / advantage display.
 */
function pointLabel(points, idx, config) {
  const p = points[idx];
  const q = points[1 - idx];
  const bothAtDeuce = p >= 3 && q >= 3;
  if (!bothAtDeuce) {
    return POINT_LABELS[Math.min(p, 3)];
  }
  // At or past 40-40. Deuce number within this game: 3-3 => 1, 4-4 => 2, ...
  const deuceNumber = Math.min(p, q) - 2;

  // Is this tied point a sudden-death "golden point"? Golden mode is always
  // sudden death at 40-40; silver/star become sudden death once their allowed
  // advantage deuces have been played.
  const isGoldenPoint =
    config.deuceMode === 'golden' || deuceNumber >= suddenDeathDeuceNumber(config);

  // The sudden-death point is labelled 'SP' (star point, tournament terminology).
  if (p === q) return isGoldenPoint ? 'SP' : 'D' + deuceNumber;
  // Advantage to this side during deuce #deuceNumber.
  if (p === q + 1) return 'Ad' + deuceNumber;
  // Trailing side during an advantage shows 40.
  return '40';
}

// ---------------------------------------------------------------------------
// Set / match resolution
// ---------------------------------------------------------------------------

function isDecidingSet(state) {
  const { setsToWin } = state.config;
  return state.setsWon[0] === setsToWin - 1 && state.setsWon[1] === setsToWin - 1;
}

function tiebreakTarget(state) {
  return state.inSuperTiebreak ? state.config.superTiebreakPoints : state.config.tiebreakPoints;
}

/** Begin a (super) tiebreak in the current set. */
function startTiebreak(state, isSuper) {
  state.inTiebreak = true;
  state.inSuperTiebreak = !!isSuper;
  state.points = [0, 0];
  state.deuceCount = 0;
}

/** Record the completed set and advance the match, or finish it. */
function completeSet(state, winnerIdx, setResult) {
  state.sets.push(setResult);
  state.setsWon[winnerIdx] += 1;

  state.games = [0, 0];
  state.points = [0, 0];
  state.inTiebreak = false;
  state.inSuperTiebreak = false;
  state.deuceCount = 0;

  if (state.setsWon[winnerIdx] >= state.config.setsToWin) {
    state.status = 'finished';
    state.winner = winnerIdx;
    return;
  }

  // If the next set is the deciding set and it is configured as a whole-set
  // super tiebreak, jump straight into it.
  if (isDecidingSet(state) && state.config.finalSetMode === 'superTiebreak') {
    startTiebreak(state, true);
  }
}

/** Called after a game is awarded (server already toggled by caller). */
function resolveSet(state, gameWinnerIdx) {
  const other = 1 - gameWinnerIdx;
  const g = state.games[gameWinnerIdx];
  const og = state.games[other];
  const { gamesPerSet, tiebreakEnabled } = state.config;
  const deciding = isDecidingSet(state);

  // Normal set win: reach gamesPerSet with a two-game lead.
  if (g >= gamesPerSet && g - og >= 2) {
    completeSet(state, gameWinnerIdx, { a: state.games[0], b: state.games[1] });
    return;
  }

  // 6-6 (or gamesPerSet-all): decide whether to enter a tiebreak.
  if (g === gamesPerSet && og === gamesPerSet) {
    let useTiebreak = tiebreakEnabled;
    if (deciding && state.config.finalSetMode === 'normal' && !tiebreakEnabled) {
      useTiebreak = false; // advantage final set, play on
    }
    if (useTiebreak) {
      startTiebreak(state, false);
    }
    // else: advantage set — keep playing games until a two-game lead.
  }
}

/** Resolve a finished tiebreak. */
function resolveTiebreak(state, tbWinnerIdx) {
  const tbScore = { a: state.points[0], b: state.points[1] };

  if (state.inSuperTiebreak) {
    // Whole deciding set decided by the super tiebreak.
    completeSet(state, tbWinnerIdx, {
      a: tbWinnerIdx === 0 ? 1 : 0,
      b: tbWinnerIdx === 1 ? 1 : 0,
      tb: tbScore,
      superTb: true,
    });
    return;
  }

  // Standard tiebreak: winner takes the set, games become e.g. 7-6.
  const games = state.games.slice();
  games[tbWinnerIdx] += 1;
  completeSet(state, tbWinnerIdx, { a: games[0], b: games[1], tb: tbScore });
}

// ---------------------------------------------------------------------------
// Point application
// ---------------------------------------------------------------------------

/**
 * Pass the serve to the other team after a completed game (or after a
 * tiebreak serving stint): the team that just served rotates to its partner
 * for its next service game, and the incoming team serves with whichever
 * partner its own rotation says is due.
 */
function rotateServe(state) {
  if (!Array.isArray(state.teamServers)) state.teamServers = [0, 0];
  state.teamServers[state.server] = state.servingPlayer ? 0 : 1;
  state.server = 1 - state.server;
  state.servingPlayer = state.teamServers[state.server] ? 1 : 0;
}

function awardPoint(state, team) {
  if (state.status === 'finished') return state;
  if (state.status === 'idle') state.status = 'live';

  state.lastScorer = team;

  if (state.inTiebreak) {
    state.points[team] += 1;
    const target = tiebreakTarget(state);
    const p = state.points[team];
    const q = state.points[1 - team];
    const won = state.config.tiebreakWinByTwo
      ? p >= target && p - q >= 2
      : p >= target && p > q;

    // Serve alternates after the first point, then every two points;
    // partners rotate within each team between its serving stints.
    if ((state.points[0] + state.points[1]) % 2 === 1) {
      rotateServe(state);
    }

    if (won) resolveTiebreak(state, team);
    return state;
  }

  // Normal game.
  state.points[team] += 1;
  const winner = gameWinner(state.points[0], state.points[1], state.config);

  // Track deuces for star mode display/logic.
  if (state.points[0] >= 3 && state.points[1] >= 3 && state.points[0] === state.points[1]) {
    state.deuceCount = Math.min(state.points[0], state.points[1]) - 2;
  }

  if (winner !== null) {
    state.games[winner] += 1;
    state.points = [0, 0];
    state.deuceCount = 0;
    rotateServe(state); // serving team alternates every game; partners rotate within each team
    resolveSet(state, winner);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Command reducer
// ---------------------------------------------------------------------------

const MUTATING = new Set([
  'point', 'adjustPoints', 'adjustGames', 'adjustSets', 'saveSet', 'removeLastSet',
  'setServer', 'swapServer', 'setServingPlayer', 'swapServingPlayer',
  'setTeams', 'selectTeam', 'setTeamActive', 'setConfig', 'setDisplay', 'resetMatch', 'resetAll', 'startMatch',
  'finishMatch', 'setStatus',
]);

function isMutating(type) {
  return MUTATING.has(type);
}

function clampInt(n, min, max) {
  n = Math.round(Number(n) || 0);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Apply a command, returning a NEW state object. Unknown / no-op commands
 * return the original reference (caller can skip the history push).
 */
function applyCommand(prev, cmd) {
  const type = cmd && cmd.type;
  if (!type) return prev;

  const state = clone(prev);
  state.seq = (prev.seq || 0) + 1;

  switch (type) {
    case 'point': {
      const t = cmd.team === 1 ? 1 : 0;
      // The next match is underway — bring the scorebug back, drop the players intro.
      if (state.status !== 'finished' && state.display) {
        state.display.scoreVisible = true;
        state.display.introVisible = false;
      }
      return awardPoint(state, t);
    }

    case 'adjustPoints': {
      const t = cmd.team === 1 ? 1 : 0;
      state.points[t] = clampInt(state.points[t] + (cmd.delta || 0), 0, 99);
      return state;
    }

    case 'adjustGames': {
      const t = cmd.team === 1 ? 1 : 0;
      state.games[t] = clampInt(state.games[t] + (cmd.delta || 0), 0, 99);
      return state;
    }

    case 'adjustSets': {
      const t = cmd.team === 1 ? 1 : 0;
      state.setsWon[t] = clampInt(state.setsWon[t] + (cmd.delta || 0), 0, 9);
      return state;
    }

    case 'saveSet': {
      // Commit the current games as a completed set. The team leading in games
      // wins it. This is what makes the per-set boxes appear on the overlay so
      // an operator can manually build a match up to the deciding set.
      const g0 = state.games[0];
      const g1 = state.games[1];
      if (g0 === g1) return prev; // need a leader to decide the set (no-op)
      const winnerIdx = g0 > g1 ? 0 : 1;
      completeSet(state, winnerIdx, { a: g0, b: g1 });
      return state;
    }

    case 'removeLastSet': {
      if (!state.sets.length) return prev;
      const last = state.sets.pop();
      const winnerIdx = (last.a || 0) > (last.b || 0) ? 0 : 1;
      if (state.setsWon[winnerIdx] > 0) state.setsWon[winnerIdx] -= 1;
      // Re-open the match and restore the games so the set can be re-edited.
      state.games = [last.a || 0, last.b || 0];
      state.points = [0, 0];
      state.inTiebreak = false;
      state.inSuperTiebreak = false;
      state.deuceCount = 0;
      state.status = 'live';
      state.winner = null;
      return state;
    }

    case 'setServer': {
      const t = cmd.team === 1 ? 1 : 0;
      if (!Array.isArray(state.teamServers)) state.teamServers = [0, 0];
      state.server = t;
      state.servingPlayer = state.teamServers[t] ? 1 : 0; // the partner due in that team's rotation
      return state;
    }

    case 'swapServer':
      if (!Array.isArray(state.teamServers)) state.teamServers = [0, 0];
      state.server = 1 - state.server;
      state.servingPlayer = state.teamServers[state.server] ? 1 : 0;
      return state;

    case 'setServingPlayer': {
      if (!Array.isArray(state.teamServers)) state.teamServers = [0, 0];
      const p = cmd.player === 1 ? 1 : 0;
      state.servingPlayer = p;
      state.teamServers[state.server] = p; // manual correction re-anchors this team's rotation
      return state;
    }

    case 'swapServingPlayer':
      if (!Array.isArray(state.teamServers)) state.teamServers = [0, 0];
      state.servingPlayer = 1 - (state.servingPlayer ? 1 : 0);
      state.teamServers[state.server] = state.servingPlayer;
      return state;

    case 'selectTeam': {
      // cmd.teamData is resolved by the server from data/teams.json before dispatch.
      const t = cmd.team === 1 ? 1 : 0;
      const data = cmd.teamData;
      if (!data || !Array.isArray(data.players)) return prev;
      const dst = state.teams[t];
      dst.teamId = data.id;
      dst.name = '';
      dst.players = data.players.slice(0, 2).map((p) => ({ name: p.name || '', country: p.country || '' }));
      if (!Array.isArray(state.teamServers)) state.teamServers = [0, 0];
      state.teamServers[t] = 0; // a freshly picked pair starts its rotation at player 1
      if (state.server === t) state.servingPlayer = 0;
      return state;
    }

    case 'setTeamActive': {
      if (typeof cmd.teamId !== 'string' || !cmd.teamId) return prev;
      if (!state.teams_registry) state.teams_registry = {};
      state.teams_registry[cmd.teamId] = { active: cmd.active !== false };
      return state;
    }

    case 'setTeams': {
      if (Array.isArray(cmd.teams)) {
        for (let i = 0; i < 2; i++) {
          if (!cmd.teams[i]) continue;
          const src = cmd.teams[i];
          const dst = state.teams[i];
          if (typeof src.name === 'string') dst.name = src.name;
          if (typeof src.color === 'string') dst.color = src.color;
          if (typeof src.logo === 'string') dst.logo = src.logo;
          if (Array.isArray(src.players))
            dst.players = src.players.slice(0, 2).map((p) =>
              typeof p === 'string' ? { name: p, country: '' } : { name: (p && p.name) || '', country: (p && p.country) || '' });
        }
      }
      return state;
    }

    case 'setConfig':
      if (cmd.config && typeof cmd.config === 'object') {
        Object.assign(state.config, cmd.config);
      }
      return state;

    case 'setDisplay':
      if (cmd.display && typeof cmd.display === 'object') {
        Object.assign(state.display, cmd.display);
        // The players intro and the scorebug never share the screen: showing
        // one hides the other (hiding one leaves the screen empty).
        if (cmd.display.scoreVisible === true) state.display.introVisible = false;
        else if (cmd.display.introVisible === true) state.display.scoreVisible = false;
      }
      return state;

    case 'startMatch':
      state.status = 'live';
      if (state.display) {
        state.display.scoreVisible = true;
        state.display.introVisible = false;
      }
      return state;

    case 'setStatus':
      if (['idle', 'live', 'finished'].includes(cmd.status)) state.status = cmd.status;
      return state;

    case 'finishMatch':
      state.status = 'finished';
      if (cmd.winner === 0 || cmd.winner === 1) state.winner = cmd.winner;
      return state;

    case 'resetMatch': {
      // Keep teams, config and display; reset the live score.
      const fresh = createDefaultState();
      fresh.config = state.config;
      fresh.teams = state.teams;
      fresh.display = state.display;
      fresh.teams_registry = state.teams_registry || {}; // eliminations are tournament-level, not per-match
      fresh.seq = state.seq;
      return fresh;
    }

    case 'resetAll':
      return createDefaultState();

    default:
      return prev; // unknown command: no change
  }
}

const api = {
  createDefaultState,
  applyCommand,
  isMutating,
  gameWinner,
  pointLabel,
  clone,
  POINT_LABELS,
};

// Dual environment: Node (server) and browser (overlay/admin share label logic).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.PadelScoring = api;
}

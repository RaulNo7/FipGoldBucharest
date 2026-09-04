'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createWsHub } = require('./src/wsserver');
const scoring = require('./src/scoring');
const { ObsClient } = require('./src/obsclient');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
// Read-only widget port for the internet tunnel (0 disables it). Serves only
// the overlay/TV/intro pages + assets, GET /api/state and a broadcast-only
// WebSocket - never the control pages, commands or settings.
const PUBLIC_PORT = process.env.PUBLIC_PORT !== undefined ? Number(process.env.PUBLIC_PORT) || 0 : PORT + 1;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const MAX_HISTORY = 100;

// ---------------------------------------------------------------------------
// Tournament entry list (static seed data shipped with the app)
// ---------------------------------------------------------------------------

const TEAMS_FILE = path.join(__dirname, 'data', 'teams.json');
let teamsData = { tournament: 'FIP Gold Bucharest 2026', teams: [] };
try {
  teamsData = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
} catch (err) {
  console.error('Could not load data/teams.json:', err.message);
}
const teamById = new Map((teamsData.teams || []).map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// State + history
// ---------------------------------------------------------------------------

let state = loadState();
const undoStack = [];
const redoStack = [];

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Merge over defaults so new fields are always present after upgrades.
      const base = scoring.createDefaultState();
      return {
        ...base,
        ...saved,
        config: { ...base.config, ...(saved.config || {}) },
        display: { ...base.display, ...(saved.display || {}) },
        teams: normalizeTeams(saved.teams, base.teams),
        teams_registry: { ...(saved.teams_registry || {}) },
      };
    }
  } catch (err) {
    console.error('Could not load saved state, starting fresh:', err.message);
  }
  return scoring.createDefaultState();
}

/** Accept both the current per-player object shape and the legacy string[] players. */
function normalizeTeams(savedTeams, baseTeams) {
  if (!savedTeams || savedTeams.length !== 2) return baseTeams;
  return savedTeams.map((t, i) => ({
    ...baseTeams[i],
    ...t,
    players: (t.players || []).slice(0, 2).map((p) =>
      typeof p === 'string' ? { name: p, country: '' } : { name: (p && p.name) || '', country: (p && p.country) || '' }),
  }));
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATE_FILE, JSON.stringify(state), (err) => {
      if (err) console.error('Failed to persist state:', err.message);
    });
  }, 200);
}

function pushHistory() {
  undoStack.push(scoring.clone(state));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

// Undo/redo cover only the score (points, games, sets, serve, match status) —
// never team selection, display toggles (score / players-intro visibility) or
// the elimination registry: those are operator settings, not match events.
const SCORE_FIELDS = [
  'points', 'games', 'sets', 'setsWon', 'inTiebreak', 'inSuperTiebreak', 'deuceCount',
  'server', 'servingPlayer', 'teamServers', 'status', 'winner', 'lastScorer',
];
const UNDOABLE = new Set([
  'point', 'adjustPoints', 'adjustGames', 'adjustSets', 'saveSet', 'removeLastSet',
  'setServer', 'swapServer', 'setServingPlayer', 'swapServingPlayer',
  'startMatch', 'finishMatch', 'setStatus', 'resetMatch',
]);

/** The current state with only the score fields taken from a history snapshot. */
function withScoreFrom(snapshot) {
  const next = scoring.clone(state);
  for (const k of SCORE_FIELDS) {
    if (k in snapshot) next[k] = scoring.clone(snapshot[k]);
  }
  next.seq = (state.seq || 0) + 1;
  return next;
}

// ---------------------------------------------------------------------------
// WebSocket hub
// ---------------------------------------------------------------------------

const hub = createWsHub();

// Hub for the public read-only port: gets every state broadcast, ignores
// anything a client sends.
const publicHub = createWsHub();
publicHub.onConnect((socket) => {
  publicHub.sendText(socket, publicStateMessage());
});
// Sockets that connected with the referee key (/ws?key=...) may send commands;
// every other public socket is a read-only viewer.
const refereeSockets = new WeakSet();
publicHub.onMessage((socket, text) => {
  if (!refereeSockets.has(socket)) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (_) {
    return;
  }
  handleCommand(msg);
});

function publicStateMessage() {
  // Same as the LAN message minus the client count. The OBS/break status is
  // needed by the (key-protected) Media page and contains nothing sensitive.
  return JSON.stringify({ type: 'state', state, obs: obsStatusPayload() });
}

function stateMessage() {
  // `obs` is transient status for the admin UI — never persisted, never secret.
  return JSON.stringify({ type: 'state', state, clients: hub.size, obs: obsStatusPayload() });
}

function broadcastState() {
  hub.broadcast(stateMessage());
  if (PUBLIC_PORT) publicHub.broadcast(publicStateMessage());
}

hub.onConnect((socket) => {
  hub.sendText(socket, stateMessage());
});

hub.onMessage((socket, text) => {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (_) {
    return;
  }
  handleCommand(msg);
});

// ---------------------------------------------------------------------------
// Commercial break (OBS automation)
// ---------------------------------------------------------------------------

const OBS_SETTINGS_FILE = path.join(path.dirname(STATE_FILE), 'obs-settings.json');

const DEFAULT_OBS_SETTINGS = {
  enabled: true, // automatic break after a match ends
  url: 'ws://127.0.0.1:4455',
  password: '',
  liveScene: 'LIVE',
  commercialsScene: 'COMMERCIALS',
  mediaSource: 'Commercials', // the media source inside the commercials scene
  autoDelaySeconds: 60,
  maxBreakSeconds: 300, // safety cap if the media never reports "ended"
  breakMode: 'playlist', // 'playlist' = play every spot below in order | 'file' = play the media source's own file
  publicHostname: '', // e.g. scorebug.example.com (the tunnel hostname) - only used to build URLs in the admin panel
  refereeKey: '', // secret that unlocks the referee page + score commands on the public port (empty = LAN only)
  youtubeUrl: '', // live-stream link; when set, the website menu shows a "YouTube Live" entry (public, not secret)
  // Individual spots for the Media tab: each temporarily swaps the media
  // source's file, plays through the same break routine, then restores the
  // merged break video configured in OBS.
  commercials: [
    { id: 'FIP_INTRO', label: 'FIP INTRO', file: 'C:\\Padel\\FipGoldBucharest\\Commercials\\01_FIP_INTRO.mp4' },
    { id: 'INVERSORES', label: 'INVERSORES', file: 'C:\\Padel\\FipGoldBucharest\\Commercials\\02_INVERSORES.mp4' },
    { id: 'BULLPADEL', label: 'BULLPADEL', file: 'C:\\Padel\\FipGoldBucharest\\Commercials\\03_BULLPADEL.mp4' },
    { id: 'CUPRA', label: 'CUPRA', file: 'C:\\Padel\\FipGoldBucharest\\Commercials\\04_CUPRA.mp4' },
    { id: 'FIP_BEYOND', label: 'FIP BEYOND', file: 'C:\\Padel\\FipGoldBucharest\\Commercials\\05_FIP_BEYOND.mp4' },
    { id: 'MONDO', label: 'MONDO', file: 'C:\\Padel\\FipGoldBucharest\\Commercials\\06_MONDO.mov' },
  ],
};

let obsSettings = loadObsSettings();

function loadObsSettings() {
  try {
    if (fs.existsSync(OBS_SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(OBS_SETTINGS_FILE, 'utf8'));
      const merged = { ...DEFAULT_OBS_SETTINGS, ...saved };
      merged.commercials = sanitizeCommercials(saved.commercials) || DEFAULT_OBS_SETTINGS.commercials;
      return merged;
    }
  } catch (err) {
    console.error('Could not load obs-settings.json:', err.message);
  }
  return { ...DEFAULT_OBS_SETTINGS };
}

function saveObsSettings() {
  try {
    fs.writeFileSync(OBS_SETTINGS_FILE, JSON.stringify(obsSettings, null, 2));
  } catch (err) {
    console.error('Could not save obs-settings.json:', err.message);
  }
}

/** Valid spot list ({id, label, file} entries) or null. */
function sanitizeCommercials(list) {
  if (!Array.isArray(list)) return null;
  const clean = list
    .filter((c) => c && typeof c.id === 'string' && c.id && typeof c.file === 'string' && c.file)
    .map((c) => ({ id: c.id, label: typeof c.label === 'string' && c.label ? c.label : c.id, file: c.file }));
  return clean.length ? clean : null;
}

const obs = new ObsClient();
const breakState = {
  phase: 'idle', countdownEndsAt: null, timer: null, abort: false, lastError: null,
  currentCommercial: null, // spot id (or 'BREAK') while running
  lastCommercial: null, // spot id (or 'BREAK') that played last - highlighted on the Media tab
  origFile: null, // the file that was on the media source, restored after a break
  playlist: false, // true while the full spot list is being played
  playlistIndex: 0,
  playlistTotal: 0,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obsStatusPayload() {
  return {
    enabled: !!obsSettings.enabled,
    connected: obs.connected,
    phase: breakState.phase, // 'idle' | 'countdown' | 'running'
    countdownEndsAt: breakState.countdownEndsAt,
    currentCommercial: breakState.currentCommercial,
    lastCommercial: breakState.lastCommercial,
    playlist: breakState.playlist,
    playlistIndex: breakState.playlistIndex,
    playlistTotal: breakState.playlistTotal,
    lastError: breakState.lastError || obs.lastError || null,
    youtubeUrl: obsSettings.youtubeUrl || '', // for the website menu ("YouTube Live"); updates live on save
  };
}

/** Normalizes a user-typed stream link: trims, adds https:// when missing, allows only http(s) (or empty). */
function sanitizeLink(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch (_) {
    return '';
  }
}

/** Called after every state change with the previous status: match finished / reopened. */
function onStatusMaybeChanged(prevStatus) {
  if (state.status === 'finished' && prevStatus !== 'finished') {
    eliminateLoser();
    scheduleAutoBreak();
  } else if (state.status !== 'finished' && prevStatus === 'finished') {
    // Back to 'live' = the result was reverted (undo / undo set): reinstate the
    // team we eliminated. Anything else (reset for the next match) keeps it.
    if (state.status === 'live') reinstateAutoEliminated();
    else autoEliminatedTeamId = null;
    cancelBreak();
  }
}

// The pair that lost the match is marked Eliminated automatically (Teams tab /
// match pickers). Remembered so an undone result can reinstate exactly that team.
let autoEliminatedTeamId = null;

function eliminateLoser() {
  if (state.winner !== 0 && state.winner !== 1) return;
  const loser = state.teams[1 - state.winner];
  if (!loser || !loser.teamId) return;
  autoEliminatedTeamId = loser.teamId;
  handleCommand({ type: 'setTeamActive', teamId: loser.teamId, active: false });
}

function reinstateAutoEliminated() {
  if (!autoEliminatedTeamId) return;
  const teamId = autoEliminatedTeamId;
  autoEliminatedTeamId = null;
  handleCommand({ type: 'setTeamActive', teamId, active: true });
}

function scheduleAutoBreak() {
  if (!obsSettings.enabled || breakState.phase !== 'idle') return;
  const delayMs = Math.max(0, Number(obsSettings.autoDelaySeconds) || 0) * 1000;
  breakState.phase = 'countdown';
  breakState.countdownEndsAt = Date.now() + delayMs;
  breakState.timer = setTimeout(() => {
    breakState.timer = null;
    runBreak();
  }, delayMs);
}

/** Cancel a pending countdown, or abort a running break (returns to the live scene). */
function cancelBreak() {
  if (breakState.phase === 'countdown') {
    clearTimeout(breakState.timer);
    breakState.timer = null;
    breakState.phase = 'idle';
    breakState.countdownEndsAt = null;
    broadcastState();
  } else if (breakState.phase === 'running') {
    breakState.abort = true;
  }
}

/**
 * Run a break on the stream. With { id, file } it plays that single spot;
 * otherwise, in 'playlist' mode, it plays every configured spot in order (no
 * merged file needed), or in 'file' mode whatever the media source holds.
 * Spots are loaded one by one into the OBS media source; the file that was on
 * the source before is put back afterwards.
 */
async function runBreak(opts = {}) {
  if (breakState.phase === 'running') return;
  const spots = obsSettings.commercials || [];
  let queue;
  if (opts.file) queue = [{ id: opts.id, file: opts.file }];
  else if (obsSettings.breakMode !== 'file' && spots.length) queue = spots.map((c) => ({ id: c.id, file: c.file }));
  else queue = [null]; // play the source's own file, no swap

  breakState.phase = 'running';
  breakState.countdownEndsAt = null;
  breakState.abort = false;
  breakState.lastError = null;
  breakState.playlist = !opts.file && queue[0] !== null;
  breakState.playlistTotal = breakState.playlist ? queue.length : 0;
  breakState.playlistIndex = 0;
  breakState.currentCommercial = queue[0] ? queue[0].id : 'BREAK';
  // A single spot is meant for use during a game: the score always comes back
  // afterwards. A full break (play-all / automatic) gives the score back only
  // when it interrupted a live match with the score on; after a finished match
  // the score stays hidden until the next match starts.
  const single = !!opts.file;
  const restoreScore = single || (state.status === 'live' && state.display && state.display.scoreVisible !== false);
  broadcastState();

  // 1. Hide the on-stream scorebug (the /tv court page keeps the final score).
  handleCommand({ type: 'setDisplay', display: { scoreVisible: false } });
  await sleep(1000); // let the overlay fade out before the scene switch

  let swapped = false;
  try {
    if (!obs.connected) await obs.connect(obsSettings.url, obsSettings.password);
    await fitMediaSourceToCanvas();
    if (queue[0]) {
      // Remember the file that was on the source so it can be put back afterwards.
      const current = await obs.request('GetInputSettings', { inputName: obsSettings.mediaSource });
      const orig = current.inputSettings && current.inputSettings.local_file;
      const isSpot = spots.some((c) => c.file === orig);
      if (orig && !isSpot) breakState.origFile = orig;
    }
    for (let i = 0; i < queue.length; i++) {
      if (breakState.abort) break;
      const spot = queue[i];
      if (spot) {
        breakState.currentCommercial = spot.id;
        breakState.playlistIndex = i + 1;
        broadcastState();
        await obs.request('SetInputSettings', {
          inputName: obsSettings.mediaSource,
          inputSettings: { is_local_file: true, local_file: spot.file },
          overlay: true,
        });
        swapped = true;
      }
      if (i === 0) {
        await obs.request('SetCurrentProgramScene', { sceneName: obsSettings.commercialsScene });
      } else {
        // The source is already on air: make sure the new file starts from the top.
        try {
          await obs.request('TriggerMediaInputAction', {
            inputName: obsSettings.mediaSource,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
          });
        } catch (_) { /* the settings change alone restarts playback on most builds */ }
      }
      await waitForCommercialsEnd();
      if (spot) breakState.lastCommercial = spot.id;
    }
    await obs.request('SetCurrentProgramScene', { sceneName: obsSettings.liveScene });
  } catch (err) {
    breakState.lastError = err.message;
    console.error('Commercial break failed:', err.message);
    // Best effort: never leave the stream stuck on the commercials scene.
    try {
      if (obs.connected) await obs.request('SetCurrentProgramScene', { sceneName: obsSettings.liveScene });
    } catch (_) { /* reported above */ }
  }

  if (swapped && breakState.origFile) {
    try {
      await obs.request('SetInputSettings', {
        inputName: obsSettings.mediaSource,
        inputSettings: { is_local_file: true, local_file: breakState.origFile },
        overlay: true,
      });
    } catch (err) {
      breakState.lastError = 'Could not restore the media source file: ' + err.message;
    }
  }

  if (!queue[0]) breakState.lastCommercial = 'BREAK';
  breakState.currentCommercial = null;
  breakState.playlist = false;
  breakState.playlistIndex = 0;
  breakState.playlistTotal = 0;
  if (restoreScore && (single || state.status === 'live')) {
    handleCommand({ type: 'setDisplay', display: { scoreVisible: true } });
  }
  breakState.phase = 'idle';
  broadcastState();
}

/**
 * Best effort: make the commercials media source fill the canvas whatever the
 * video's resolution is (spots differ) - the same as OBS's "Fit to screen".
 * The scene item keeps its old scale otherwise, so a larger file looks cropped.
 */
async function fitMediaSourceToCanvas() {
  try {
    const video = await obs.request('GetVideoSettings');
    const item = await obs.request('GetSceneItemId', {
      sceneName: obsSettings.commercialsScene,
      sourceName: obsSettings.mediaSource,
    });
    await obs.request('SetSceneItemTransform', {
      sceneName: obsSettings.commercialsScene,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        alignment: 5, // top-left
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsAlignment: 0, // centered inside the bounds (letterboxed if needed)
        boundsWidth: video.baseWidth,
        boundsHeight: video.baseHeight,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0,
      },
    });
  } catch (err) {
    console.error('Could not fit the media source to the canvas:', err.message);
  }
}

async function waitForCommercialsEnd() {
  const started = Date.now();
  const capMs = Math.max(5, Number(obsSettings.maxBreakSeconds) || 300) * 1000;
  let sawPlayback = false;

  while (Date.now() - started < capMs) {
    if (breakState.abort) return;
    await sleep(500);

    let status;
    try {
      status = await obs.request('GetMediaInputStatus', { inputName: obsSettings.mediaSource });
    } catch (_) {
      // Media source not queryable — fall back to the fixed safety cap.
      while (Date.now() - started < capMs && !breakState.abort) await sleep(500);
      return;
    }

    const s = status.mediaState;
    if (s === 'OBS_MEDIA_STATE_PLAYING' || s === 'OBS_MEDIA_STATE_PAUSED') {
      sawPlayback = true;
      continue;
    }
    if (s === 'OBS_MEDIA_STATE_OPENING' || s === 'OBS_MEDIA_STATE_BUFFERING') continue;
    // ENDED / STOPPED / ERROR / NONE — allow a short startup grace period.
    if (sawPlayback || Date.now() - started > 3000) return;
  }
}

function testObsConnection() {
  (async () => {
    try {
      if (!obs.connected) await obs.connect(obsSettings.url, obsSettings.password);
      await obs.request('GetVersion');
      breakState.lastError = null;
    } catch (err) {
      breakState.lastError = err.message;
    }
    broadcastState();
  })();
}

function handleCommand(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return;

  if (cmd.type === 'undo') {
    if (undoStack.length) {
      const prevStatus = state.status;
      redoStack.push(scoring.clone(state));
      state = withScoreFrom(undoStack.pop());
      persist();
      onStatusMaybeChanged(prevStatus);
      broadcastState();
    }
    return;
  }

  if (cmd.type === 'redo') {
    if (redoStack.length) {
      const prevStatus = state.status;
      undoStack.push(scoring.clone(state));
      state = withScoreFrom(redoStack.pop());
      persist();
      onStatusMaybeChanged(prevStatus);
      broadcastState();
    }
    return;
  }

  if (cmd.type === 'ping') {
    return; // handled by ws layer; ignore app-level pings
  }

  if (cmd.type === 'playCommercials') {
    if (breakState.phase === 'countdown') {
      clearTimeout(breakState.timer);
      breakState.timer = null;
      breakState.phase = 'idle';
      breakState.countdownEndsAt = null;
    }
    if (breakState.phase !== 'running') runBreak();
    return;
  }

  if (cmd.type === 'playCommercial') {
    const spot = (obsSettings.commercials || []).find((c) => c.id === cmd.id);
    if (!spot) return;
    if (breakState.phase === 'countdown') {
      clearTimeout(breakState.timer);
      breakState.timer = null;
      breakState.phase = 'idle';
      breakState.countdownEndsAt = null;
    }
    if (breakState.phase !== 'running') runBreak({ id: spot.id, file: spot.file });
    return;
  }

  if (cmd.type === 'cancelCommercials') {
    cancelBreak();
    return;
  }

  if (cmd.type === 'obsTest') {
    testObsConnection();
    return;
  }

  if (cmd.type === 'selectTeam') {
    // Resolve the entry-list team server-side; the reducer stays data-agnostic.
    const rec = teamById.get(cmd.teamId);
    if (!rec) return;
    cmd = {
      ...cmd,
      teamData: { id: rec.id, players: (rec.players || []).map((p) => ({ name: p.name, country: p.country })) },
    };
  }

  if (scoring.isMutating(cmd.type)) {
    const next = scoring.applyCommand(state, cmd);
    if (next !== state) {
      const prevStatus = state.status;
      if (UNDOABLE.has(cmd.type)) {
        pushHistory();
      } else if (cmd.type === 'resetAll') {
        undoStack.length = 0; // a full reset starts a fresh history
        redoStack.length = 0;
      }
      state = next;
      persist();
      onStatusMaybeChanged(prevStatus);
      broadcastState();
    }
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function safeJoin(base, target) {
  const resolved = path.normalize(path.join(base, target));
  if (!resolved.startsWith(base)) return null; // path traversal guard
  return resolved;
}

/**
 * Appends ?v=<file mtime> to every local .css/.js reference in an HTML page.
 * CDNs in front of the tunnel (Cloudflare) cache static assets for hours and
 * ignore our no-cache; a changed query string is a new URL for them and for
 * the phones, so every deploy is picked up immediately.
 */
function versionAssets(html) {
  return html.replace(/((?:src|href)=")([^"?#:]+\.(?:css|js))(")/g, (m, pre, ref, post) => {
    const rel = ref.replace(/^\//, '');
    const file = rel === 'scoring.js' ? path.join(__dirname, 'src', 'scoring.js') : safeJoin(PUBLIC_DIR, '/' + rel);
    try {
      return `${pre}${ref}?v=${Math.floor(fs.statSync(file).mtimeMs)}${post}`;
    } catch (_) {
      return m;
    }
  });
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(ext === '.html' ? versionAssets(data.toString('utf8')) : data);
  });
}

function handleMainRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  // REST fallback for posting commands (useful for stream decks / hotkey apps).
  if (req.method === 'POST' && pathname === '/api/command') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        handleCommand(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  if (pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  // Entry-list roster with the LIVE active/eliminated flag merged in.
  if (pathname === '/api/teams') {
    const reg = (state && state.teams_registry) || {};
    const teams = (teamsData.teams || []).map((t) => ({
      ...t,
      active: reg[t.id] ? reg[t.id].active !== false : t.active !== false,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tournament: teamsData.tournament || '', teams }));
    return;
  }

  // Host info so the admin page can build LAN URLs (it may itself be viewed
  // via 127.0.0.1 inside the desktop app's WebView).
  if (pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ port: PORT, publicPort: PUBLIC_PORT, lanHost: firstLanAddress() }));
    return;
  }

  // Commercial spots for the Media tab (no secrets: ids, labels, file names only).
  if (pathname === '/api/commercials') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      commercials: (obsSettings.commercials || []).map((c) => ({ id: c.id, label: c.label, file: c.file })),
    }));
    return;
  }

  // OBS / commercial-break settings. Server-side only — deliberately NOT part
  // of the broadcast state, so the OBS password never reaches referee phones.
  if (pathname === '/api/obs-settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obsSettings));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const clean = { ...obsSettings };
          if (typeof incoming.enabled === 'boolean') clean.enabled = incoming.enabled;
          for (const k of ['url', 'password', 'liveScene', 'commercialsScene', 'mediaSource', 'publicHostname', 'refereeKey']) {
            if (typeof incoming[k] === 'string') clean[k] = incoming[k];
          }
          if (typeof incoming.youtubeUrl === 'string') clean.youtubeUrl = sanitizeLink(incoming.youtubeUrl);
          for (const k of ['autoDelaySeconds', 'maxBreakSeconds']) {
            const n = Number(incoming[k]);
            if (Number.isFinite(n) && n >= 0) clean[k] = Math.round(n);
          }
          const spots = sanitizeCommercials(incoming.commercials);
          if (spots) clean.commercials = spots;
          if (incoming.breakMode === 'playlist' || incoming.breakMode === 'file') clean.breakMode = incoming.breakMode;
          obsSettings = clean;
          saveObsSettings();
          obs.close(); // reconnect with the new url/password on next use
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          broadcastState();
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
  }

  // Shared scoring module (single source of truth for score labels).
  if (pathname === '/scoring.js') {
    serveFile(res, path.join(__dirname, 'src', 'scoring.js'));
    return;
  }

  // Friendly routes.
  if (pathname === '/' || pathname === '/home') pathname = '/home.html';
  if (pathname === '/scorebug') pathname = '/scorebug.html';
  if (pathname === '/settings') pathname = '/settings.html'; // app-only Admin page (never public)
  if (pathname === '/overlay') pathname = '/overlay.html';
  if (pathname === '/admin') pathname = '/admin.html';
  if (pathname === '/mobile') pathname = '/mobile.html';
  if (pathname === '/teams') pathname = '/teams.html';
  if (pathname === '/tv') pathname = '/tv.html';
  if (pathname === '/intro') pathname = '/intro.html';
  if (pathname === '/media') pathname = '/media.html';

  const filePath = safeJoin(PUBLIC_DIR, pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath);
}

const server = http.createServer(handleMainRequest);

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/ws') {
    hub.handleUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const lan = firstLanAddress();
  console.log('');
  console.log('  🎾  FIP Gold Bucharest 2026 — score server is running');
  console.log('  ----------------------------------------');
  console.log(`  Admin panel : http://localhost:${PORT}/admin`);
  console.log(`  OBS overlay : http://localhost:${PORT}/overlay`);
  if (lan) {
    console.log('');
    console.log(`  On your network (other devices / OBS on another PC):`);
    console.log(`  Admin       : http://${lan}:${PORT}/admin`);
    console.log(`  Overlay     : http://${lan}:${PORT}/overlay`);
  }
  console.log('');
  console.log('  Add the overlay URL as a Browser Source in OBS.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

// ---------------------------------------------------------------------------
// Public read-only port (what the internet tunnel exposes to FIP)
// ---------------------------------------------------------------------------

const PUBLIC_PAGES = {
  '/': 'home.html', '/home': 'home.html', '/scorebug': 'scorebug.html',
  '/overlay': 'overlay.html', '/tv': 'tv.html', '/intro': 'intro.html',
};
const PUBLIC_ASSET = /^\/(home|scorebug|overlay|tv|intro)\.(html|css|js)$|^\/(mobile|admin|teams|media)\.(css|js)$|^\/(client|countries)\.js$|^\/fip-logo\.png$|^\/flags\/[a-z]{2}\.svg$/;

// Operator pages (referee, admin, teams, media) and the APIs they use: only
// with the access key, given as ?key=... or as the cookie set when a page was
// opened with the key. They are then handled by the main server's own routing.
const KEYED_PAGES = new Set([
  '/mobile', '/mobile.html', '/admin', '/admin.html', '/teams', '/teams.html', '/media', '/media.html',
]);
const KEYED_PATHS = new Set([
  ...KEYED_PAGES, '/api/command', '/api/teams', '/api/info', '/api/obs-settings', '/api/commercials',
]);

/** True when the request carries the configured access key (?key=... or cookie). */
function hasRefereeKey(url, req) {
  const key = obsSettings.refereeKey;
  if (!key) return false;
  if (url.searchParams.get('key') === key) return true;
  const cookie = req && req.headers && req.headers.cookie;
  if (!cookie) return false;
  return cookie.split(';').some((part) => {
    const [name, ...rest] = part.trim().split('=');
    if (name !== 'key') return false;
    try {
      return decodeURIComponent(rest.join('=')) === key;
    } catch (_) {
      return false;
    }
  });
}

if (PUBLIC_PORT) {
  const publicServer = http.createServer((req, res) => {
    let url;
    let pathname;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
      pathname = decodeURIComponent(url.pathname);
    } catch (_) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    // Any page opened with a valid ?key= (the main page included) stores the key
    // in a cookie so the operator pages and their requests pass afterwards.
    if (url.searchParams.get('key') && hasRefereeKey(url, req)) {
      res.setHeader('Set-Cookie',
        `key=${encodeURIComponent(obsSettings.refereeKey)}; Path=/; Max-Age=2592000; SameSite=Lax`);
    }

    if (KEYED_PATHS.has(pathname)) {
      if (!hasRefereeKey(url, req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access key required');
        return;
      }
      handleMainRequest(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Read-only');
      return;
    }

    if (pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(state));
      return;
    }
    if (pathname === '/scoring.js') {
      serveFile(res, path.join(__dirname, 'src', 'scoring.js'));
      return;
    }
    const page = PUBLIC_PAGES[pathname];
    if (page) {
      serveFile(res, path.join(PUBLIC_DIR, page));
      return;
    }
    if (PUBLIC_ASSET.test(pathname)) {
      const filePath = safeJoin(PUBLIC_DIR, pathname);
      if (filePath) {
        serveFile(res, filePath);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  publicServer.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (hasRefereeKey(url, req)) refereeSockets.add(socket); // operator pages: may send commands
    publicHub.handleUpgrade(req, socket);
  });

  publicServer.on('error', (err) => {
    console.error(`Public read-only port ${PUBLIC_PORT} unavailable:`, err.message);
  });

  publicServer.listen(PUBLIC_PORT, HOST, () => {
    console.log(`  Read-only widget port (tunnel this): http://localhost:${PUBLIC_PORT}/overlay`);
  });
}

function firstLanAddress() {
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name]) {
        if (ni.family === 'IPv4' && !ni.internal) return ni.address;
      }
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

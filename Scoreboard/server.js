'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createWsHub } = require('./src/wsserver');
const scoring = require('./src/scoring');
const { ObsClient } = require('./src/obsclient');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
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

// ---------------------------------------------------------------------------
// WebSocket hub
// ---------------------------------------------------------------------------

const hub = createWsHub();

function stateMessage() {
  // `obs` is transient status for the admin UI — never persisted, never secret.
  return JSON.stringify({ type: 'state', state, clients: hub.size, obs: obsStatusPayload() });
}

function broadcastState() {
  hub.broadcast(stateMessage());
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
};

let obsSettings = loadObsSettings();

function loadObsSettings() {
  try {
    if (fs.existsSync(OBS_SETTINGS_FILE)) {
      return { ...DEFAULT_OBS_SETTINGS, ...JSON.parse(fs.readFileSync(OBS_SETTINGS_FILE, 'utf8')) };
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

const obs = new ObsClient();
const breakState = { phase: 'idle', countdownEndsAt: null, timer: null, abort: false, lastError: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obsStatusPayload() {
  return {
    enabled: !!obsSettings.enabled,
    connected: obs.connected,
    phase: breakState.phase, // 'idle' | 'countdown' | 'running'
    countdownEndsAt: breakState.countdownEndsAt,
    lastError: breakState.lastError || obs.lastError || null,
  };
}

/** Auto-break trigger: called after every state change with the previous status. */
function onStatusMaybeChanged(prevStatus) {
  if (state.status === 'finished' && prevStatus !== 'finished') scheduleAutoBreak();
  else if (state.status !== 'finished' && prevStatus === 'finished') cancelBreak();
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

async function runBreak() {
  if (breakState.phase === 'running') return;
  breakState.phase = 'running';
  breakState.countdownEndsAt = null;
  breakState.abort = false;
  breakState.lastError = null;
  broadcastState();

  // 1. Hide the on-stream scorebug (the /tv court page keeps the final score).
  handleCommand({ type: 'setDisplay', display: { scoreVisible: false } });
  await sleep(1000); // let the overlay fade out before the scene switch

  try {
    if (!obs.connected) await obs.connect(obsSettings.url, obsSettings.password);
    await obs.request('SetCurrentProgramScene', { sceneName: obsSettings.commercialsScene });
    await waitForCommercialsEnd();
    await obs.request('SetCurrentProgramScene', { sceneName: obsSettings.liveScene });
  } catch (err) {
    breakState.lastError = err.message;
    console.error('Commercial break failed:', err.message);
    // Best effort: never leave the stream stuck on the commercials scene.
    try {
      if (obs.connected) await obs.request('SetCurrentProgramScene', { sceneName: obsSettings.liveScene });
    } catch (_) { /* reported above */ }
  }

  // The score stays hidden; it comes back on startMatch / the first point.
  breakState.phase = 'idle';
  broadcastState();
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
      state = undoStack.pop();
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
      state = redoStack.pop();
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
      pushHistory();
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
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
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
    res.end(JSON.stringify({ port: PORT, lanHost: firstLanAddress() }));
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
          for (const k of ['url', 'password', 'liveScene', 'commercialsScene', 'mediaSource']) {
            if (typeof incoming[k] === 'string') clean[k] = incoming[k];
          }
          for (const k of ['autoDelaySeconds', 'maxBreakSeconds']) {
            const n = Number(incoming[k]);
            if (Number.isFinite(n) && n >= 0) clean[k] = Math.round(n);
          }
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
  if (pathname === '/') pathname = '/admin.html';
  if (pathname === '/overlay') pathname = '/overlay.html';
  if (pathname === '/admin') pathname = '/admin.html';
  if (pathname === '/mobile') pathname = '/mobile.html';
  if (pathname === '/teams') pathname = '/teams.html';
  if (pathname === '/tv') pathname = '/tv.html';

  const filePath = safeJoin(PUBLIC_DIR, pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath);
});

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

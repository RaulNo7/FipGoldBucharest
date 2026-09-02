'use strict';

/**
 * End-to-end test of the commercial-break automation, without real OBS:
 * spins up a mock obs-websocket v5 server (reusing our own wsserver hub),
 * launches server.js as a child process pointed at it (2s auto delay), then
 * finishes a match over the REST API and asserts the whole flow:
 *   finish -> countdown -> score hidden -> COMMERCIALS scene -> media polled
 *   until ended -> back to LIVE -> score stays hidden -> next match shows it.
 *
 * Run: node test/break.e2e.js
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { createWsHub } = require('../src/wsserver');

const SB_PORT = 8231;
const OBS_PORT = 8232;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fipgold-e2e-'));
const stateFile = path.join(tmp, 'state.json');
fs.writeFileSync(
  path.join(tmp, 'obs-settings.json'),
  JSON.stringify({
    enabled: true,
    url: `ws://127.0.0.1:${OBS_PORT}`,
    password: '',
    liveScene: 'LIVE',
    commercialsScene: 'COMMERCIALS',
    mediaSource: 'Commercials',
    autoDelaySeconds: 2,
    maxBreakSeconds: 60,
  })
);

// ---- mock obs-websocket v5 server -----------------------------------------
const sceneSwitches = [];
let mediaPolls = 0;

const hub = createWsHub();
hub.onConnect((sock) => hub.sendText(sock, JSON.stringify({ op: 0, d: { rpcVersion: 1 } })));
hub.onMessage((sock, text) => {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (_) {
    return;
  }
  if (msg.op === 1) {
    hub.sendText(sock, JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    return;
  }
  if (msg.op === 6) {
    const { requestType, requestId, requestData } = msg.d;
    let responseData = {};
    if (requestType === 'SetCurrentProgramScene') sceneSwitches.push(requestData.sceneName);
    if (requestType === 'GetMediaInputStatus') {
      mediaPolls++;
      responseData = { mediaState: mediaPolls <= 2 ? 'OBS_MEDIA_STATE_PLAYING' : 'OBS_MEDIA_STATE_ENDED' };
    }
    hub.sendText(
      sock,
      JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } })
    );
  }
});
const obsSrv = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});
obsSrv.on('upgrade', (req, socket) => hub.handleUpgrade(req, socket));
obsSrv.listen(OBS_PORT);

// ---- scoreboard server under test -----------------------------------------
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(SB_PORT), STATE_FILE: stateFile },
  stdio: 'ignore',
});

const api = (p) => fetch(`http://127.0.0.1:${SB_PORT}${p}`).then((r) => r.json());
const cmd = (body) =>
  fetch(`http://127.0.0.1:${SB_PORT}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.error('  ✗ FAIL: ' + msg);
  }
}

function cleanupAndExit() {
  try { child.kill(); } catch (_) {}
  try { obsSrv.close(); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed ? 1 : 0);
}

(async () => {
  console.log('\nRunning commercial-break e2e test…\n');

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      await api('/api/state');
      up = true;
    } catch (_) {
      await sleep(250);
    }
  }
  assert(up, 'scoreboard server started');

  await cmd({ type: 'startMatch' });

  // Undo/redo are score-only: a display toggle is neither undone nor recorded.
  await cmd({ type: 'point', team: 0 });
  await cmd({ type: 'setDisplay', display: { scoreVisible: false, introVisible: true } });
  await cmd({ type: 'undo' });
  let st = await api('/api/state');
  assert(st.points[0] === 0, 'undo reverts the last point, not the display toggle');
  assert(st.display.scoreVisible === false && st.display.introVisible === true, 'undo leaves score/players visibility untouched');
  await cmd({ type: 'redo' });
  st = await api('/api/state');
  assert(st.points[0] === 1, 'redo re-applies the point');
  assert(st.display.scoreVisible === false, 'redo also leaves the display untouched');
  await cmd({ type: 'undo' });
  await cmd({ type: 'setDisplay', display: { scoreVisible: true, introVisible: false } });

  await cmd({ type: 'adjustGames', team: 0, delta: 6 });
  await cmd({ type: 'saveSet' });
  await cmd({ type: 'adjustGames', team: 0, delta: 6 });
  await cmd({ type: 'saveSet' });
  st = await api('/api/state');
  assert(st.status === 'finished', 'match finished');
  assert(st.display.scoreVisible !== false, 'score still visible right after the finish');

  // countdown (2s) + fade (1s) + media polls (3 x 0.5s) -> done well within 8s
  await sleep(8000);
  st = await api('/api/state');
  assert(
    JSON.stringify(sceneSwitches) === JSON.stringify(['COMMERCIALS', 'LIVE']),
    'OBS switched to COMMERCIALS then back to LIVE (got: ' + sceneSwitches.join(', ') + ')'
  );
  assert(mediaPolls >= 3, 'media status polled until it reported ended');
  assert(st.display.scoreVisible === false, 'score hidden after the break');

  await cmd({ type: 'resetMatch' });
  st = await api('/api/state');
  assert(st.display.scoreVisible === false, 'score still hidden while setting up the next match');
  await cmd({ type: 'startMatch' });
  st = await api('/api/state');
  assert(st.display.scoreVisible === true, 'score visible again when the next match starts');

  // manual break, mid-match
  sceneSwitches.length = 0;
  mediaPolls = 0;
  await cmd({ type: 'playCommercials' });
  await sleep(5000);
  st = await api('/api/state');
  assert(
    JSON.stringify(sceneSwitches) === JSON.stringify(['COMMERCIALS', 'LIVE']),
    'manual break switched scenes (got: ' + sceneSwitches.join(', ') + ')'
  );
  assert(st.display.scoreVisible === false, 'manual break hid the score');

  cleanupAndExit();
})().catch((err) => {
  console.error(err);
  failed++;
  cleanupAndExit();
});

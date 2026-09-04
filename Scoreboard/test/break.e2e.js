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
const PUBLIC_PORT = 8233;

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
    refereeKey: 'testkey',
  })
);

// ---- mock obs-websocket v5 server -----------------------------------------
const sceneSwitches = [];
let mediaPolls = 0; // polls since the current file was loaded (drives PLAYING -> ENDED)
let totalPolls = 0; // never reset
const inputSettingsCalls = []; // files set on the media source, in order
const transformCalls = []; // scene-item transforms applied to the media source
let mediaFile = 'C:\\merged-break.mp4';

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
    if (requestType === 'GetInputSettings') responseData = { inputSettings: { local_file: mediaFile } };
    if (requestType === 'GetVideoSettings') responseData = { baseWidth: 1280, baseHeight: 720 };
    if (requestType === 'GetSceneItemId') responseData = { sceneItemId: 7 };
    if (requestType === 'SetSceneItemTransform') transformCalls.push(requestData.sceneItemTransform);
    if (requestType === 'SetInputSettings') {
      mediaFile = requestData.inputSettings.local_file;
      inputSettingsCalls.push(mediaFile);
      mediaPolls = 0; // a newly loaded file plays from the start
    }
    if (requestType === 'GetMediaInputStatus') {
      mediaPolls++;
      totalPolls++;
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
  env: { ...process.env, PORT: String(SB_PORT), PUBLIC_PORT: String(PUBLIC_PORT), STATE_FILE: stateFile },
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
  await cmd({ type: 'selectTeam', team: 0, teamId: 'M-Q-23' });
  await cmd({ type: 'selectTeam', team: 1, teamId: 'M-MD-27' });

  // Public read-only port: widget pages only, commands rejected, WS is broadcast-only.
  const pub = (p, opts) => fetch(`http://127.0.0.1:${PUBLIC_PORT}${p}`, opts);
  assert((await pub('/overlay')).status === 200, 'public port serves /overlay');
  assert((await pub('/overlay.js')).status === 200 && (await pub('/flags/ro.svg')).status === 200, 'public port serves the widget assets');
  assert((await pub('/api/state')).status === 200, 'public port serves read-only state');
  assert((await pub('/admin')).status === 404 && (await pub('/media')).status === 404, 'public port hides the control pages');
  assert((await pub('/api/obs-settings')).status === 404 && (await pub('/api/teams')).status === 404, 'public port hides settings and other APIs');
  const post = await pub('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'point', team: 0 }) });
  assert(post.status === 403, 'public port rejects POSTed commands without the referee key');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUBLIC_PORT}/ws`);
    const timer = setTimeout(() => reject(new Error('no state on public ws')), 4000);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      assert(m.type === 'state' && m.state && m.obs === undefined, 'public ws pushes the state (without the OBS status)');
      ws.send(JSON.stringify({ type: 'point', team: 0 }));
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 600);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('public ws error')); });
  });
  let st0 = await api('/api/state');
  assert(st0.points[0] === 0, 'a command sent through the public ws is ignored');

  // Referee key: unlocks the referee page and commands on the public port.
  assert((await pub('/mobile')).status === 403, 'public port: referee page needs the key');
  assert((await pub('/mobile?key=testkey')).status === 200 && (await pub('/mobile.js')).status === 200, 'public port: referee page + assets with the key');
  const keyed = await pub('/api/command?key=testkey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'point', team: 0 }) });
  st0 = await api('/api/state');
  assert(keyed.status === 200 && st0.points[0] === 1, 'public port: a command with the key is applied (REST)');
  await cmd({ type: 'adjustPoints', team: 0, delta: -1 });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUBLIC_PORT}/ws?key=testkey`);
    const timer = setTimeout(() => reject(new Error('no state on referee ws')), 4000);
    ws.addEventListener('message', () => {
      ws.send(JSON.stringify({ type: 'point', team: 0 }));
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 600);
    }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('referee ws error')); });
  });
  st0 = await api('/api/state');
  assert(st0.points[0] === 1, 'public port: a command over the keyed websocket is applied');
  await cmd({ type: 'adjustPoints', team: 0, delta: -1 });

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

  // A single spot: file swapped in, played, restored; the score always comes back
  // afterwards (spots are played during the game) - even if it was hidden before.
  sceneSwitches.length = 0;
  mediaPolls = 0;
  inputSettingsCalls.length = 0;
  await cmd({ type: 'setDisplay', display: { scoreVisible: false } });
  await cmd({ type: 'playCommercial', id: 'FIP_INTRO' });
  await sleep(6000);
  st = await api('/api/state');
  assert(
    inputSettingsCalls.length === 2 && /01_FIP_INTRO\.mp4$/.test(inputSettingsCalls[0]) && inputSettingsCalls[1] === 'C:\\merged-break.mp4',
    'spot: media file swapped to the spot and restored to the break video (got: ' + inputSettingsCalls.join(' | ') + ')'
  );
  assert(JSON.stringify(sceneSwitches) === JSON.stringify(['COMMERCIALS', 'LIVE']), 'spot: scenes switched to COMMERCIALS and back');
  const tf = transformCalls[transformCalls.length - 1];
  assert(tf && tf.boundsType === 'OBS_BOUNDS_SCALE_INNER' && tf.boundsWidth === 1280 && tf.boundsHeight === 720, 'spot: media source fitted to the canvas (scale to inner bounds 1280x720)');
  assert(st.display.scoreVisible === true, 'single spot: score is shown afterwards even though it was hidden before');
  sceneSwitches.length = 0;
  mediaPolls = 0;
  inputSettingsCalls.length = 0;

  await cmd({ type: 'adjustGames', team: 0, delta: 6 });
  await cmd({ type: 'saveSet' });
  await cmd({ type: 'adjustGames', team: 0, delta: 6 });
  await cmd({ type: 'saveSet' });
  st = await api('/api/state');
  assert(st.status === 'finished', 'match finished');
  assert(st.display.scoreVisible !== false, 'score still visible right after the finish');

  // The losing pair is eliminated automatically; reverting the result reinstates it.
  let roster = await api('/api/teams');
  const team = (id) => roster.teams.find((t) => t.id === id);
  assert(team('M-MD-27').active === false, 'the losing team is eliminated automatically');
  assert(team('M-Q-23').active === true, 'the winning team stays active');
  await cmd({ type: 'removeLastSet' }); // result reverted -> match live again
  roster = await api('/api/teams');
  assert(team('M-MD-27').active === true, 'reverting the result reinstates the team');
  await cmd({ type: 'saveSet' }); // ...and finishing again eliminates it again
  roster = await api('/api/teams');
  assert(team('M-MD-27').active === false, 'finishing again eliminates it again');

  // countdown (2s) + fade (1s) + 6 spots x (load + 3 polls x 0.5s) -> done well within 16s
  await sleep(16000);
  st = await api('/api/state');
  assert(
    JSON.stringify(sceneSwitches) === JSON.stringify(['COMMERCIALS', 'LIVE']),
    'OBS switched to COMMERCIALS then back to LIVE (got: ' + sceneSwitches.join(', ') + ')'
  );
  assert(totalPolls >= 3, 'media status polled until it reported ended');
  assert(
    inputSettingsCalls.length === 7 && /01_FIP_INTRO\.mp4$/.test(inputSettingsCalls[0]) && /06_MONDO\.mov$/.test(inputSettingsCalls[5]) && inputSettingsCalls[6] === 'C:\\merged-break.mp4',
    'auto break: all 6 spots loaded in order, then the original file restored (got: ' + inputSettingsCalls.join(' | ') + ')'
  );
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
  inputSettingsCalls.length = 0;
  await cmd({ type: 'playCommercials' });
  await sleep(14000);
  st = await api('/api/state');
  assert(
    JSON.stringify(sceneSwitches) === JSON.stringify(['COMMERCIALS', 'LIVE']),
    'manual break switched scenes (got: ' + sceneSwitches.join(', ') + ')'
  );
  assert(inputSettingsCalls.length === 7, 'manual break: playlist of 6 spots + restore (got ' + inputSettingsCalls.length + ' loads)');
  assert(st.display.scoreVisible === true, 'manual break during a live match: score restored afterwards');

  cleanupAndExit();
})().catch((err) => {
  console.error(err);
  failed++;
  cleanupAndExit();
});

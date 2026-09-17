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
    replayEnabled: true,
    replaySeconds: 15,
    replayDir: path.join(tmp, 'Replay'),
    replayScene: 'REPLAY',
    replaySource: 'Replay',
  })
);

// ---- mock obs-websocket v5 server -----------------------------------------
const sceneSwitches = [];
let mediaPolls = 0; // polls since the current file was loaded (drives PLAYING -> ENDED)
let totalPolls = 0; // never reset
const inputSettingsCalls = []; // files set on the media source, in order
const transformCalls = []; // scene-item transforms applied to the media source
let mediaFile = 'C:\\merged-break.mp4';
let replayBufferActive = false;
let replaySaves = 0;
let lastReplayPath = '';
const profileParams = {};
const obsRecDir = path.join(tmp, 'obs-videos');
fs.mkdirSync(obsRecDir);

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
    // Replay buffer: "recording" once started; a save writes a small file to
    // OBS's own recording folder (the app moves it into the replay folder).
    if (requestType === 'GetReplayBufferStatus') responseData = { outputActive: replayBufferActive };
    if (requestType === 'StartReplayBuffer') replayBufferActive = true;
    if (requestType === 'StopReplayBuffer') replayBufferActive = false;
    if (requestType === 'SetProfileParameter') profileParams[requestData.parameterCategory + '/' + requestData.parameterName] = requestData.parameterValue;
    if (requestType === 'SaveReplayBuffer') {
      replaySaves++;
      lastReplayPath = path.join(obsRecDir, `Replay 2026-09-15 10-30-${String(replaySaves).padStart(2, '0')}.mp4`);
      fs.writeFileSync(lastReplayPath, Buffer.alloc(2048, 1));
    }
    if (requestType === 'GetLastReplayBufferReplay') responseData = { savedReplayPath: lastReplayPath };
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
  await cmd({ type: 'selectTeam', team: 0, teamId: 'M-MD-14' });
  await cmd({ type: 'selectTeam', team: 1, teamId: 'M-MD-01' });

  // Public read-only port: widget pages only, commands rejected, WS is broadcast-only.
  const pub = (p, opts) => fetch(`http://127.0.0.1:${PUBLIC_PORT}${p}`, opts);
  assert((await pub('/overlay')).status === 200, 'public port serves /overlay');
  const home = await pub('/');
  assert(home.status === 200 && /id="youtubeLink"/.test(await home.text()) && (await pub('/home.css')).status === 200, 'public port serves the main page');
  assert((await pub('/scorebug')).status === 200 && (await pub('/scorebug.js')).status === 200, 'public port serves the scorebug page (embed code)');
  assert((await pub('/settings')).status === 404 && (await pub('/settings.js')).status === 404, 'public port never serves the app-only Admin page');
  assert((await fetch(`http://127.0.0.1:${SB_PORT}/settings`)).status === 200 && /Bucharest 2026 — Home/.test(await (await fetch(`http://127.0.0.1:${SB_PORT}/`)).text()), 'LAN port serves the Admin page and the main page');
  const keyedHome = await pub('/?key=testkey');
  assert(keyedHome.status === 200 && /^key=testkey/.test(keyedHome.headers.get('set-cookie') || ''), 'main page opened with the key sets the key cookie');
  assert((await pub('/overlay.js')).status === 200 && (await pub('/flags/ro.svg')).status === 200, 'public port serves the widget assets');
  assert((await pub('/api/state')).status === 200, 'public port serves read-only state');
  assert((await pub('/admin')).status === 403 && (await pub('/teams')).status === 403 && (await pub('/media')).status === 403, 'public port: admin/teams/media need the key');
  assert((await pub('/media?key=testkey')).status === 200 && (await pub('/api/commercials', { headers: { cookie: 'key=testkey' } })).status === 200, 'public port: media page + its spot list with the key');
  assert((await pub('/api/obs-settings')).status === 403 && (await pub('/api/teams')).status === 403, 'public port: settings and roster APIs need the key');
  const adminRes = await pub('/admin?key=testkey');
  const cookie = adminRes.headers.get('set-cookie') || '';
  assert(adminRes.status === 200 && /^key=testkey/.test(cookie), 'public port: admin page opens with the key and sets the key cookie');
  assert((await pub('/teams?key=testkey')).status === 200 && (await pub('/admin.js')).status === 200, 'public port: teams page + admin assets with the key');
  const withCookie = await pub('/api/obs-settings', { headers: { cookie: 'key=testkey' } });
  assert(withCookie.status === 200, 'public port: the cookie alone unlocks the APIs the pages use');
  const post = await pub('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'point', team: 0 }) });
  assert(post.status === 403, 'public port rejects POSTed commands without the referee key');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUBLIC_PORT}/ws`);
    const timer = setTimeout(() => reject(new Error('no state on public ws')), 4000);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      assert(m.type === 'state' && m.state, 'public ws pushes the state');
      ws.send(JSON.stringify({ type: 'point', team: 0 }));
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 600);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('public ws error')); });
  });
  let st0 = await api('/api/state');
  assert(st0.points[0] === 0, 'a command sent through the public ws is ignored');

  // YouTube live link (Admin tab): normalized on save, published to the website menu via the status payload.
  const ytSave = await fetch(`http://127.0.0.1:${SB_PORT}/api/obs-settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl: ' youtube.com/live/abc123 ' }),
  });
  const ytCfg = await (await fetch(`http://127.0.0.1:${SB_PORT}/api/obs-settings`)).json();
  assert(ytSave.status === 200 && ytCfg.youtubeUrl === 'https://youtube.com/live/abc123', 'YouTube link is saved and normalized (https:// added)');
  const ytOnPublic = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUBLIC_PORT}/ws`);
    const timer = setTimeout(() => reject(new Error('no state on public ws')), 4000);
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(ev.data).obs?.youtubeUrl);
    }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('public ws error')); });
  });
  assert(ytOnPublic === 'https://youtube.com/live/abc123', 'public ws state carries the YouTube link for the website menu');
  await fetch(`http://127.0.0.1:${SB_PORT}/api/obs-settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl: 'javascript:alert(1)' }),
  });
  assert((await (await fetch(`http://127.0.0.1:${SB_PORT}/api/obs-settings`)).json()).youtubeUrl === '', 'a non-http(s) YouTube link is rejected (cleared)');

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

  // Media tab "check a video": any file from the commercials folder, by name only.
  const ads = await api('/api/commercials');
  assert(
    !!ads.dir && ads.videos.includes('02_INVERSORES.mp4') && ads.commercials.length === 6 && ads.commercials.every((c) => c.exists === true && path.isAbsolute(c.file)),
    'commercials API: folder, its video files and the spots resolved to existing files (got dir=' + ads.dir + ', ' + ads.videos.length + ' videos)'
  );
  await cmd({ type: 'playVideo', file: '..\\server.js' });
  await cmd({ type: 'playVideo', file: 'nope.mp4' });
  await sleep(300);
  assert(inputSettingsCalls.length === 0 && sceneSwitches.length === 0, 'playVideo: names outside the folder are ignored');
  await cmd({ type: 'playVideo', file: '02_INVERSORES.mp4' });
  await sleep(6000);
  st = await api('/api/state');
  assert(
    inputSettingsCalls.length === 2 && /02_INVERSORES\.mp4$/.test(inputSettingsCalls[0]) && inputSettingsCalls[1] === 'C:\\merged-break.mp4',
    'playVideo: the chosen file is loaded, played and the break video restored (got: ' + inputSettingsCalls.join(' | ') + ')'
  );
  assert(JSON.stringify(sceneSwitches) === JSON.stringify(['COMMERCIALS', 'LIVE']), 'playVideo: scenes switched to COMMERCIALS and back');
  assert(st.display.scoreVisible === true, 'playVideo: the score is shown again afterwards');
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

  // Player name corrections from the Teams page: roster API, live pair and re-selection all follow.
  await cmd({ type: 'setPlayerName', teamId: 'M-MD-14', player: 1, name: 'Giulio Graziotti (WC)' });
  let roster = await api('/api/teams');
  const team = (id) => roster.teams.find((t) => t.id === id);
  assert(team('M-MD-14').players[1].name === 'Giulio Graziotti (WC)' && team('M-MD-14').players[1].originalName === 'Giulio Graziotti', 'rename: /api/teams shows the corrected name and keeps the original');
  st = await api('/api/state');
  assert(st.teams[0].players[1].name === 'Giulio Graziotti (WC)', 'rename: the pair selected for the current match is updated live');
  assert((await cmd({ type: 'setPlayerName', teamId: 'NOPE', player: 0, name: 'x' })).status === 200 && !(await api('/api/state')).teams_registry.NOPE, 'rename: unknown team ids are ignored');
  await cmd({ type: 'setPlayerName', teamId: 'M-MD-14', player: 1, name: '' });
  st = await api('/api/state');
  assert(st.teams[0].players[1].name === 'Giulio Graziotti' && !st.teams_registry['M-MD-14'].names, 'rename: clearing restores the entry-list name');
  await cmd({ type: 'setPlayerCountry', teamId: 'M-MD-14', player: 1, country: 'pol' });
  roster = await api('/api/teams');
  st = await api('/api/state');
  assert(team('M-MD-14').players[1].country === 'POL' && team('M-MD-14').players[1].originalCountry === 'ITA' && st.teams[0].players[1].country === 'POL', 'country: /api/teams and the selected pair show the corrected code');
  await cmd({ type: 'setPlayerCountry', teamId: 'M-MD-14', player: 1, country: '' });
  st = await api('/api/state');
  assert(st.teams[0].players[1].country === 'ITA' && !st.teams_registry['M-MD-14'].countries, 'country: clearing restores the entry-list code');

  // The losing pair is eliminated automatically; reverting the result reinstates it.
  roster = await api('/api/teams');
  assert(team('M-MD-01').active === false, 'the losing team is eliminated automatically');
  assert(team('M-MD-14').active === true, 'the winning team stays active');
  await cmd({ type: 'removeLastSet' }); // result reverted -> match live again
  roster = await api('/api/teams');
  assert(team('M-MD-01').active === true, 'reverting the result reinstates the team');
  await cmd({ type: 'saveSet' }); // ...and finishing again eliminates it again
  roster = await api('/api/teams');
  assert(team('M-MD-01').active === false, 'finishing again eliminates it again');

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

  // Instant replay: the housekeeping loop keeps the buffer running with the configured length.
  const replayDir = path.join(tmp, 'Replay');
  assert(replayBufferActive === true && profileParams['AdvOut/RecRBTime'] === '15', 'replay: buffer started by the app with the configured length (got active=' + replayBufferActive + ', RecRBTime=' + profileParams['AdvOut/RecRBTime'] + ')');
  sceneSwitches.length = 0;
  mediaPolls = 0;
  inputSettingsCalls.length = 0;
  const waitFor = async (cond, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (cond()) return true;
      await sleep(250);
    }
    return cond();
  };
  const backToLive = () => sceneSwitches.length >= 2 && sceneSwitches[sceneSwitches.length - 1] === 'LIVE';
  await cmd({ type: 'setDisplay', display: { scoreVisible: true } });
  await cmd({ type: 'saveReplay' });
  await waitFor(() => sceneSwitches.includes('REPLAY'), 15000);
  st = await api('/api/state');
  assert(st.display.scoreVisible === false, 'replay: the scorebug is hidden while the clip is on the stream');
  await waitFor(backToLive, 15000);
  await sleep(500);
  st = await api('/api/state');
  assert(st.display.scoreVisible === true, 'replay: the scorebug comes back after the clip');
  const clips = fs.existsSync(replayDir) ? fs.readdirSync(replayDir) : [];
  assert(clips.length === 1 && /^Replay 2026-09-15 10-30-01\.mp4$/.test(clips[0]) && !fs.existsSync(lastReplayPath), 'replay: the saved clip was moved into the replay folder (got: ' + clips.join(', ') + ')');
  assert(inputSettingsCalls.length === 1 && inputSettingsCalls[0] === path.join(replayDir, clips[0] || ''), 'replay: the clip was loaded into the replay media source (got: ' + inputSettingsCalls.join(' | ') + ')');
  assert(JSON.stringify(sceneSwitches) === JSON.stringify(['REPLAY', 'LIVE']), 'replay: scenes switched to REPLAY and back to LIVE (got: ' + sceneSwitches.join(', ') + ')');
  let list = await api('/api/replays');
  assert(list.replays.length === 1 && list.replays[0].name === clips[0] && list.seconds === 15, 'replay: /api/replays lists the clip');

  // A second save lands first in the list; a saved clip can be replayed by name only.
  sceneSwitches.length = 0;
  await cmd({ type: 'saveReplay' });
  await waitFor(backToLive, 15000);
  await sleep(500);
  list = await api('/api/replays');
  assert(list.replays.length === 2 && /10-30-02/.test(list.replays[0].name), 'replay: the newest clip is listed first (got: ' + list.replays.map((r) => r.name).join(', ') + ')');
  sceneSwitches.length = 0;
  mediaPolls = 0;
  inputSettingsCalls.length = 0;
  await cmd({ type: 'playReplay', file: '..\\server.js' });
  await cmd({ type: 'playReplay', file: 'nope.mp4' });
  await sleep(300);
  assert(inputSettingsCalls.length === 0 && sceneSwitches.length === 0, 'playReplay: names outside the replay folder are ignored');
  await cmd({ type: 'setDisplay', display: { scoreVisible: false } }); // hidden by the operator before the replay
  await cmd({ type: 'playReplay', file: (list.replays[1] || {}).name || 'missing.mp4' });
  await waitFor(backToLive, 15000);
  await sleep(500);
  st = await api('/api/state');
  assert(st.display.scoreVisible === false, 'playReplay: a score that was already hidden stays hidden afterwards');
  assert(inputSettingsCalls.length === 1 && /10-30-01\.mp4$/.test(inputSettingsCalls[0]) && JSON.stringify(sceneSwitches) === JSON.stringify(['REPLAY', 'LIVE']), 'playReplay: the chosen clip plays on the replay scene, then back to LIVE (got: ' + inputSettingsCalls.join(' | ') + ' / ' + sceneSwitches.join(', ') + ')');

  cleanupAndExit();
})().catch((err) => {
  console.error(err);
  failed++;
  cleanupAndExit();
});

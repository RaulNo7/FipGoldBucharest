/* Media tab: broadcast controls + one button per commercial spot. */
(function () {
  'use strict';

  let state = null;
  let latestObs = null; // transient OBS/break status from the state broadcasts
  let spots = [];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const client = PadelClient.connect({
    onState: (s, msg) => {
      state = s;
      if (msg && msg.obs) latestObs = msg.obs;
      render();
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });

  function send(obj) {
    client.send(obj);
  }

  // ---- the spot list (for status texts) + the videos in the commercials folder ----
  function loadCommercials() {
    fetch('/api/commercials')
      .then((r) => r.json())
      .then((data) => {
        spots = data.commercials || [];
        buildVideos(data);
        render();
      })
      .catch(() => {
        buildVideos({ videos: [], dir: '' });
        $('#videoDir').textContent = '(could not load the commercials list)';
      });
  }
  loadCommercials();

  function buildVideos(data) {
    const sel = $('#videoSelect');
    const videos = data.videos || [];
    sel.innerHTML = '';
    if (!videos.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— no video files in this folder —';
      sel.appendChild(opt);
    }
    videos.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    $('#videoDir').textContent = data.dir || '';
    $('#playVideoBtn').disabled = !videos.length;
  }

  $('#playVideoBtn').addEventListener('click', () => {
    const file = $('#videoSelect').value;
    if (file) send({ type: 'playVideo', file });
  });

  // ---- instant replay ----
  let replayCount = -1; // last `replay.count` seen: the list reloads when it changes
  function loadReplays() {
    fetch('/api/replays')
      .then((r) => r.json())
      .then((data) => {
        const sel = $('#replaySelect');
        const current = sel.value;
        const clips = data.replays || [];
        sel.innerHTML = '';
        if (!clips.length) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '— no replay saved yet —';
          sel.appendChild(opt);
        }
        clips.forEach((c, i) => {
          const opt = document.createElement('option');
          opt.value = c.name;
          const when = c.time ? new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          opt.textContent = `${i + 1}. ${c.name}${when ? '  (' + when + ')' : ''}`;
          sel.appendChild(opt);
        });
        // Keep the operator's pick if it is still listed, else the newest clip.
        sel.value = clips.some((c) => c.name === current) ? current : (clips[0] ? clips[0].name : '');
        $('#replayDir').textContent = data.dir || '';
        $('#replaySecondsLabel').textContent = `last ${data.seconds} s → on the stream`;
        render();
      })
      .catch(() => {
        $('#replayDir').textContent = '(could not load the replay list)';
      });
  }
  loadReplays();

  $('#saveReplayBtn').addEventListener('click', () => send({ type: 'saveReplay' }));
  $('#playReplayBtn').addEventListener('click', () => {
    const file = $('#replaySelect').value;
    if (file) send({ type: 'playReplay', file });
  });
  $('#cancelReplayBtn').addEventListener('click', () => send({ type: 'cancelCommercials' }));

  // ---- broadcast controls ----
  $('#introBtn').addEventListener('click', () => {
    const visible = !!(state && state.display && state.display.introVisible);
    send({ type: 'setDisplay', display: { introVisible: !visible } });
  });
  $('#toggleScoreBtn').addEventListener('click', () => {
    const visible = !state || !state.display || state.display.scoreVisible !== false;
    send({ type: 'setDisplay', display: { scoreVisible: !visible } });
  });
  $('#playAdsBtn').addEventListener('click', () => {
    if (confirm('Switch the stream to the commercials now?')) send({ type: 'playCommercials' });
  });
  $('#cancelAdsBtn').addEventListener('click', () => send({ type: 'cancelCommercials' }));

  // ---- commercial break settings (stored server-side, never broadcast) ----
  fetch('/api/obs-settings')
    .then((r) => r.json())
    .then((cfg) => {
      $('#obsEnabled').checked = cfg.enabled !== false;
      $('#obsDelay').value = cfg.autoDelaySeconds;
      $('#obsBreakMode').value = cfg.breakMode === 'file' ? 'file' : 'playlist';
      $('#obsUrl').value = cfg.url || '';
      $('#obsPassword').value = cfg.password || '';
      $('#obsLiveScene').value = cfg.liveScene || '';
      $('#obsAdsScene').value = cfg.commercialsScene || '';
      $('#obsMediaSource').value = cfg.mediaSource || '';
      $('#obsAdsDir').value = cfg.commercialsDir || '';
      $('#obsMaxBreak').value = cfg.maxBreakSeconds;
      $('#rpEnabled').checked = cfg.replayEnabled !== false;
      $('#rpSeconds').value = cfg.replaySeconds || 20;
      $('#rpScene').value = cfg.replayScene || '';
      $('#rpSource').value = cfg.replaySource || '';
      $('#rpDir').value = cfg.replayDir || '';
    })
    .catch(() => {
      $('#breakStatus').textContent = 'Could not load the OBS settings.';
    });

  $('#saveObsBtn').addEventListener('click', () => {
    const body = {
      enabled: $('#obsEnabled').checked,
      autoDelaySeconds: +$('#obsDelay').value,
      breakMode: $('#obsBreakMode').value,
      url: $('#obsUrl').value.trim(),
      password: $('#obsPassword').value,
      liveScene: $('#obsLiveScene').value.trim(),
      commercialsScene: $('#obsAdsScene').value.trim(),
      mediaSource: $('#obsMediaSource').value.trim(),
      commercialsDir: $('#obsAdsDir').value.trim(),
      maxBreakSeconds: +$('#obsMaxBreak').value,
      replayEnabled: $('#rpEnabled').checked,
      replaySeconds: +$('#rpSeconds').value,
      replayScene: $('#rpScene').value.trim(),
      replaySource: $('#rpSource').value.trim(),
      replayDir: $('#rpDir').value.trim(),
    };
    fetch('/api/obs-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => {
        flash($('#saveObsBtn'), r.ok ? 'Saved!' : 'Failed');
        if (r.ok) {
          loadCommercials(); // the folders may have changed
          loadReplays();
        }
      })
      .catch(() => flash($('#saveObsBtn'), 'Failed'));
  });

  $('#testObsBtn').addEventListener('click', () => {
    send({ type: 'obsTest' });
    flash($('#testObsBtn'), 'Testing…');
  });

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  // ---- render ----
  function render() {
    if (state) {
      const introOn = !!(state.display && state.display.introVisible);
      const introBtn = $('#introBtn');
      introBtn.textContent = introOn ? '👥 Hide players' : '👥 Show players';
      introBtn.classList.toggle('is-on', introOn);
      $('#toggleScoreBtn').textContent =
        state.display && state.display.scoreVisible === false ? 'Show score' : 'Hide score';
    }

    const o = latestObs;
    if (!o) return;
    const running = o.phase === 'running';

    const badge = $('#obsBadge');
    badge.textContent = o.connected ? 'OBS: connected' : 'OBS: offline';
    badge.className = 'badge ' + (o.connected ? 'live' : '');

    $('#cancelAdsBtn').disabled = o.phase === 'idle';
    const breakBtn = $('#playAdsBtn');
    breakBtn.disabled = running;
    breakBtn.classList.toggle('is-last', !running && o.lastCommercial === 'BREAK');
    breakBtn.classList.toggle('is-playing', running && (o.playlist || o.currentCommercial === 'BREAK'));

    let text;
    if (o.phase === 'countdown') {
      const secs = Math.max(0, Math.ceil((o.countdownEndsAt - Date.now()) / 1000));
      text = `Match finished — commercials start in ${secs}s. Press Cancel to abort.`;
    } else if (running) {
      const cur = spots.find((c) => c.id === o.currentCommercial);
      const pos = o.playlist && o.playlistTotal ? ` (${o.playlistIndex}/${o.playlistTotal})` : '';
      const label = cur ? cur.label : videoName(o.currentCommercial);
      text = label ? `Playing "${label}"${pos} on the stream…` : 'Commercials are playing on the stream…';
    } else if (!o.enabled) {
      text = 'Automatic break is OFF — use the buttons to run commercials manually.';
    } else {
      text = 'Waiting — the break video starts automatically after a match ends.';
    }
    if (o.lastError) text += ` — last error: ${o.lastError}`;
    $('#breakStatus').textContent = text;

    // Replay card.
    const rp = o.replay || {};
    const replayPlaying = running && !!rp.playing;
    const rpBadge = $('#replayBadge');
    rpBadge.textContent = !rp.enabled ? 'replay OFF' : rp.bufferActive ? 'buffer: recording' : 'buffer: off';
    rpBadge.className = 'badge ' + (rp.enabled && rp.bufferActive ? 'live' : '');
    const saveBtn = $('#saveReplayBtn');
    saveBtn.disabled = running || !!rp.saving || !rp.enabled;
    saveBtn.classList.toggle('is-playing', !!rp.saving || replayPlaying);
    $('#cancelReplayBtn').disabled = !replayPlaying;
    $('#playReplayBtn').disabled = running || !!rp.saving || !$('#replaySelect').value;
    $('#playReplayBtn').classList.toggle('is-playing', replayPlaying);
    $('#replaySelect').disabled = running || !!rp.saving;
    let rpText;
    if (rp.saving) rpText = 'Saving the replay from OBS…';
    else if (replayPlaying) rpText = `Replay "${rp.playing}" is on the stream…`;
    else if (!rp.enabled) rpText = 'Instant replay is OFF (settings card below).';
    else if (rp.bufferActive) rpText = `Ready — Replay puts the last ${rp.seconds} s on the stream.` + (rp.last ? ` Last clip: ${rp.last}.` : '');
    else rpText = 'Waiting for OBS — the replay buffer is not recording yet.';
    if (rp.error) rpText += ` — ${rp.error}`;
    $('#replayStatus').textContent = rpText;
    if (typeof rp.count === 'number' && rp.count !== replayCount) {
      const first = replayCount < 0;
      replayCount = rp.count;
      if (!first) loadReplays();
    }

    // Video row: locked while anything is on air, green while its file plays.
    const playingVideo = running && !!videoName(o.currentCommercial);
    const playBtn = $('#playVideoBtn');
    playBtn.disabled = running || !$('#videoSelect').value;
    playBtn.classList.toggle('is-playing', playingVideo);
    $('#videoSelect').disabled = running;

    const last = spots.find((c) => c.id === o.lastCommercial);
    $('#lastPlayed').textContent = last
      ? 'last played: ' + last.label
      : o.lastCommercial === 'BREAK' ? 'last played: break video'
        : videoName(o.lastCommercial) ? 'last played: ' + videoName(o.lastCommercial) : '';
  }

  /** File name behind a "check a video" run (its id is FILE:<name>), else ''. */
  function videoName(id) {
    return typeof id === 'string' && id.startsWith('FILE:') ? id.slice(5) : '';
  }
  setInterval(render, 500); // live countdown tick
})();

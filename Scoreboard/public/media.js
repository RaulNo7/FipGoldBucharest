/* Media tab: broadcast controls + one button per commercial spot. */
(function () {
  'use strict';

  let state = null;
  let latestObs = null; // transient OBS/break status from the state broadcasts
  let latestCards = {}; // player card data for the four players of the match ("0-0" ... "1-1")
  let spots = [];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const client = PadelClient.connect({
    onState: (s, msg) => {
      state = s;
      if (msg && msg.obs) latestObs = msg.obs;
      if (msg && msg.cards) latestCards = msg.cards;
      if (msg && msg.serverNow) serverOffset = msg.serverNow - Date.now();
      render();
    },
    onStatus: (status) => {
      $('#connDot').classList.toggle('connected', status === 'connected');
      $('#connText').textContent = status === 'connected' ? 'connected' : 'reconnecting…';
    },
  });

  const setText = (sel, text) => {
    const n = $(sel);
    if (n) n.textContent = text;
  };

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
        setText('#videoDir', '(could not load the commercials list)');
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
    setText('#videoDir', data.dir || '');
    $('#playVideoBtn').disabled = !videos.length;
  }

  $('#playVideoBtn').addEventListener('click', () => {
    const file = $('#videoSelect').value;
    if (file) send({ type: 'playVideo', file });
  });

  // ---- instant replay ----
  let replayCount = -1; // last `replay.count` seen: the list reloads when it changes
  let settingsRev = -1; // last `obs.settingsRev` seen (saves on the Admin tab)
  function loadReplays(pickNewest = false) {
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
          // Titled clips ("A_B vs C_D 6-4 (30-15) 12-11-2026 10꞉45.mp4"): show the time with a real ":"
          // (the file name uses the look-alike U+A789) and no extension; older clips keep their saved time.
          const title = c.name.replace(/\.[a-z0-9]+$/i, '').replace(/꞉/g, ':');
          const dated = /\d{2}-\d{2}-\d{4} \d{2}:\d{2}/.test(title);
          opt.textContent = `${i + 1}. ${title}${when && !dated ? '  (' + when + ')' : ''}${c.last ? '  [last ' + c.last + ' s]' : ''}`;
          sel.appendChild(opt);
        });
        // Keep the operator's pick if it is still listed, else the newest clip (a clip just saved: that one).
        sel.value = !pickNewest && clips.some((c) => c.name === current) ? current : (clips[0] ? clips[0].name : '');
        setText('#replayDir', data.dir || '');
        $('#replaySecondsBig').textContent = `⏪ ${data.seconds} s`;
        $('#replaySecondsLabel').textContent = `last ${data.seconds} s`;
        showPlayNow();
        render();
      })
      .catch(() => {
        setText('#replayDir', '(could not load the replay list)');
      });
  }
  loadReplays();

  // "Play right away": off = the 5 / 10 / 15 / 20 s buttons only save the clip (Play it later from the list).
  // Remembered in this browser.
  const playNow = $('#replayPlayNow');
  try {
    if (localStorage.getItem('replayPlayNow') === '0') playNow.checked = false;
  } catch (_) { /* no storage: stays on */ }
  function showPlayNow() {
    const now = playNow.checked;
    for (const b of document.querySelectorAll('[data-replay-last]')) {
      b.querySelector('.spot-file').textContent = now ? `last ${b.dataset.replayLast} s` : 'save only';
      b.title = now ? `Save the buffer and play only its last ${b.dataset.replayLast} seconds` : `Save the last ${b.dataset.replayLast} seconds; play it later from the list`;
    }
    $('#replaySecondsLabel').textContent = now ? $('#replaySecondsBig').textContent.replace('⏪', 'last').trim() : 'save only';
    $('#saveReplayBtn').title = now ? 'Save the buffer and play all of it' : 'Save the whole buffer; play it later from the list';
  }
  playNow.addEventListener('change', () => {
    try { localStorage.setItem('replayPlayNow', playNow.checked ? '1' : '0'); } catch (_) { /* this session only */ }
    showPlayNow();
  });
  showPlayNow();

  $('#saveReplayBtn').addEventListener('click', () => send({ type: 'saveReplay', play: playNow.checked }));
  for (const b of document.querySelectorAll('[data-replay-last]')) {
    b.addEventListener('click', () => send({ type: 'saveReplay', seconds: Number(b.dataset.replayLast), play: playNow.checked }));
  }
  $('#playReplayBtn').addEventListener('click', () => {
    const file = $('#replaySelect').value;
    if (file) send({ type: 'playReplay', file });
  });
  $('#cancelReplayBtn').addEventListener('click', () => send({ type: 'cancelCommercials' }));
  // Cancel next to Play: stops the replay on air and goes back to the live scene (score comes back).
  $('#stopReplayBtn').addEventListener('click', () => send({ type: 'cancelCommercials' }));

  // ---- broadcast controls ----
  $('#introBtn').addEventListener('click', () => {
    const visible = !!(state && state.display && state.display.introVisible);
    send({ type: 'setDisplay', display: { introVisible: !visible } });
  });
  $('#toggleScoreBtn').addEventListener('click', () => {
    const visible = !state || !state.display || state.display.scoreVisible !== false;
    send({ type: 'setDisplay', display: { scoreVisible: !visible } });
  });
  $('#playersOnlyBtn').addEventListener('click', () => {
    const scoreShown = !(state && state.display && state.display.showScore === false);
    send({ type: 'setDisplay', display: { showScore: !scoreShown } });
  });
  // Player cards: ◀ Left / Right ▶ shows that player's card on that side of the frame; the same
  // button hides it, the other side moves it, another player's button switches to that player.
  $$('[data-pcard]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.pcard;
      const side = b.dataset.side === 'right' ? 'right' : 'left';
      const d = (state && state.display) || {};
      const on = d.playerCard === key && (d.playerCardSide || 'left') === side;
      send({ type: 'setDisplay', display: on ? { playerCard: null } : { playerCard: key, playerCardSide: side } });
    })
  );

  // ---- match timer (hh:mm): shown live, set or cleared here ----
  let serverOffset = 0;
  function clockMs() {
    const c = (state && state.clock) || {};
    if (!c.startedAt) return null;
    return Math.max(0, (c.endedAt || Date.now() + serverOffset) - c.startedAt);
  }
  // 0h 5m 00s (the seconds tick here; the scoreboard shows 0h 5m)
  const hhmm = (ms) => {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return `${h}h ${m}m ${s}s`;
  };
  function renderClock() {
    const ms = clockMs();
    $('#clockNow').textContent = ms == null ? '-h --m --s' : hhmm(ms);
  }
  setInterval(renderClock, 1000);
  $('#clockSetBtn').addEventListener('click', () => {
    const m = $('#clockInput').value.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) {
      $('#clockInput').focus();
      return;
    }
    // "1:05" = 1 h 5 min, "45" = 45 min
    const mins = m[2] != null ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]);
    send({ type: 'setMatchClock', elapsedMs: mins * 60000 });
    $('#clockInput').value = '';
  });
  $('#clockInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('#clockSetBtn').click());
  $('#clockResetBtn').addEventListener('click', () => send({ type: 'setMatchClock', elapsedMs: null }));
  $('#clockHideBtn').addEventListener('click', () => {
    const shown = !(state && state.display && state.display.showClock === false);
    send({ type: 'setDisplay', display: { showClock: !shown } });
  });

  // ---- commentary label on the info bar (bottom left) ----
  const commentary = () => (state && state.display && state.display.commentary) || {};
  $$('[data-commentary]').forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.commentary;
      const on = commentary().mode === mode;
      send({ type: 'setDisplay', display: { commentary: { mode: on ? '' : mode, names: $('#commentatorNames').value.trim() } } });
    })
  );
  $('#commentatorNames').addEventListener('change', () => {
    const c = commentary();
    send({ type: 'setDisplay', display: { commentary: { mode: c.mode || 'live', names: $('#commentatorNames').value.trim() } } });
  });

  // Interview: one press sets everything up, the next one goes back to the court.
  $('#interviewBtn').addEventListener('click', () => {
    const iv = (latestObs && latestObs.interview) || {};
    if (iv.busy) return;
    send({ type: 'interview', on: !iv.active });
  });
  $('#playAdsBtn').addEventListener('click', () => {
    if (confirm('Switch the stream to the commercials now?')) send({ type: 'playCommercials' });
  });
  $('#cancelAdsBtn').addEventListener('click', () => send({ type: 'cancelCommercials' }));

  // ---- render ----
  function render() {
    if (state) {
      const introOn = !!(state.display && state.display.introVisible);
      const introBtn = $('#introBtn');
      introBtn.textContent = introOn ? '👥 Hide match' : '👥 Show match';
      introBtn.classList.toggle('is-on', introOn);
      $('#toggleScoreBtn').textContent =
        state.display && state.display.scoreVisible === false ? 'Show score' : 'Hide score';
      const playersOnly = !!(state.display && state.display.showScore === false);
      $('#playersOnlyBtn').classList.toggle('is-on', playersOnly);

      renderClock();
      const clockShown = !(state.display && state.display.showClock === false);
      $('#clockHideBtn').textContent = clockShown ? 'Hide' : 'Show';
      $('#clockHideBtn').classList.toggle('is-on', !clockShown);
      $('#clockNow').classList.toggle('off-air', !clockShown);
      const c = (state.display && state.display.commentary) || {};
      $$('[data-commentary]').forEach((b) => b.classList.toggle('is-on', c.mode === b.dataset.commentary));
      const names = $('#commentatorNames');
      if (document.activeElement !== names) names.value = c.names || '';

      // the four players: a name label + ◀ Left / Right ▶ (which side of the frame the card takes)
      const C = window.PadelCountries;
      const d = state.display || {};
      $$('.pcard-group').forEach((g) => {
        const key = g.dataset.player;
        const [t, i] = key.split('-').map(Number);
        const player = ((state.teams[t] || {}).players || [])[i];
        const card = latestCards[key] || {};
        const name = C.playerName(player) || 'Player ' + (t * 2 + i + 1);
        const label = g.querySelector('.pcard-name');
        label.textContent = '🪪 ' + C.shortName(name);
        label.title = card.profile
          ? `${name} - profile read ${new Date(card.profile.fetchedAt).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
          : `No padeltour.ro profile read for ${name} yet (Teams tab → ⟳ Profiles) - the card shows only the name and flag.`;
        g.classList.toggle('no-data', !card.profile);
        g.classList.toggle('is-on', d.playerCard === key);
        g.querySelectorAll('[data-pcard]').forEach((b) => {
          b.classList.toggle('is-on', d.playerCard === key && (d.playerCardSide || 'left') === b.dataset.side);
        });
      });
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

    // Interview button + its status line.
    const iv = o.interview || {};
    const ivBtn = $('#interviewBtn');
    ivBtn.textContent = iv.busy ? (iv.active ? '🎾 Going back…' : '🎤 Setting up…') : iv.active ? '🎾 Back to court' : '🎤 Interview';
    ivBtn.classList.toggle('is-on', !!iv.active);
    ivBtn.disabled = !!iv.busy;
    const ivText = $('#interviewStatus');
    let ivMsg = '';
    if (iv.active) ivMsg = 'Interview on (interview camera and mics) - press Back to court to undo it.';
    if (iv.error) ivMsg += (ivMsg ? ' ' : '') + 'Not done — ' + iv.error;
    ivText.textContent = ivMsg;
    ivText.hidden = !ivMsg;
    ivText.classList.toggle('warn', !!iv.error);

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
    rpBadge.textContent = !rp.enabled ? 'replay OFF' : rp.bufferActive ? 'buffer: recording' : rp.waitingForStream ? 'buffer: waits for the stream' : 'buffer: off';
    rpBadge.className = 'badge ' + (rp.enabled && rp.bufferActive ? 'live' : '');
    const saveBtn = $('#saveReplayBtn');
    saveBtn.disabled = running || !!rp.saving || !rp.enabled;
    saveBtn.classList.toggle('is-playing', !!rp.saving || replayPlaying);
    for (const b of document.querySelectorAll('[data-replay-last]')) {
      b.disabled = saveBtn.disabled;
      b.hidden = Number(b.dataset.replayLast) >= Number(rp.seconds || 20); // only when shorter than the buffer
    }
    $('#cancelReplayBtn').disabled = !replayPlaying;
    $('#stopReplayBtn').disabled = !replayPlaying;
    $('#stopReplayBtn').classList.toggle('is-armed', replayPlaying);
    $('#playReplayBtn').disabled = running || !!rp.saving || !$('#replaySelect').value;
    $('#playReplayBtn').classList.toggle('is-playing', replayPlaying);
    $('#replaySelect').disabled = running || !!rp.saving;
    let rpText;
    if (rp.saving) rpText = 'Saving the replay from OBS…';
    else if (replayPlaying) rpText = `Replay "${rp.playing}" is on the stream…`;
    else if (!rp.enabled) rpText = 'Instant replay is OFF (Admin tab → Commercial break settings).';
    else if (rp.bufferActive) rpText = `Ready — Replay puts the last ${rp.seconds} s on the stream.` + (rp.last ? ` Last clip: ${rp.last}.` : '');
    else if (rp.waitingForStream) rpText = 'Replay is ready once you are live: the buffer starts a few seconds after the stream does (and stops with it, so every stream starts cleanly).';
    else rpText = 'Waiting for OBS — the replay buffer is not recording yet.';
    if (rp.error) rpText += ` — ${rp.error}`;
    rpBadge.title = rpText; // the status line under Replay is gone: hover the badge for it
    if (typeof rp.count === 'number' && rp.count !== replayCount) {
      const first = replayCount < 0;
      replayCount = rp.count;
      if (!first) loadReplays(true); // a new clip: select it, ready for Play
    }
    // Settings saved on the Admin tab (folders may have changed): reload both lists.
    if (typeof o.settingsRev === 'number' && o.settingsRev !== settingsRev) {
      const first = settingsRev < 0;
      settingsRev = o.settingsRev;
      if (!first) {
        loadCommercials();
        loadReplays();
      }
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

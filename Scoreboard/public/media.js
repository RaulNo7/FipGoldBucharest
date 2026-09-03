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

  // ---- commercial spots ----
  fetch('/api/commercials')
    .then((r) => r.json())
    .then((data) => {
      spots = data.commercials || [];
      buildSpots();
      render();
    })
    .catch(() => {
      $('#spots').textContent = 'Could not load the commercials list.';
    });

  function buildSpots() {
    const box = $('#spots');
    box.innerHTML = '';
    spots.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn spot';
      btn.dataset.spot = c.id;

      const num = document.createElement('span');
      num.className = 'spot-num';
      num.textContent = String(i + 1).padStart(2, '0');

      const label = document.createElement('span');
      label.className = 'spot-label';
      label.textContent = c.label || c.id;

      const file = document.createElement('span');
      file.className = 'spot-file';
      file.textContent = (c.file || '').split(/[\\/]/).pop();

      btn.append(num, label, file);
      btn.addEventListener('click', () => send({ type: 'playCommercial', id: c.id }));
      box.appendChild(btn);
    });
  }

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
      $('#obsMaxBreak').value = cfg.maxBreakSeconds;
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
      maxBreakSeconds: +$('#obsMaxBreak').value,
    };
    fetch('/api/obs-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => flash($('#saveObsBtn'), r.ok ? 'Saved!' : 'Failed'))
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
      text = cur ? `Playing "${cur.label}"${pos} on the stream…` : 'Commercials are playing on the stream…';
    } else if (!o.enabled) {
      text = 'Automatic break is OFF — use the buttons to run commercials manually.';
    } else {
      text = 'Waiting — the break video starts automatically after a match ends.';
    }
    if (o.lastError) text += ` — last error: ${o.lastError}`;
    $('#breakStatus').textContent = text;

    $$('[data-spot]').forEach((btn) => {
      const id = btn.dataset.spot;
      btn.classList.toggle('is-playing', running && o.currentCommercial === id);
      btn.classList.toggle('is-last', !running && o.lastCommercial === id);
      btn.disabled = running;
    });
    const last = spots.find((c) => c.id === o.lastCommercial);
    $('#lastPlayed').textContent = last
      ? 'last played: ' + last.label
      : o.lastCommercial === 'BREAK' ? 'last played: break video' : '';
  }
  setInterval(render, 500); // live countdown tick
})();

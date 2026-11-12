/* Admin page (app-only): OBS overlay/intro URLs, court TV URL, tunnel hostname,
   access key and the public links. No live state needed here. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let publicPort = 0;

  // ---- OBS overlay URL (LAN, for the Browser Source) ----
  function updateOverlayUrl() {
    const pos = $('#ovPos').value;
    const scale = $('#ovScale').value;
    const url = new URL('/overlay', location.origin);
    url.searchParams.set('pos', pos);
    if (scale && scale !== '1') url.searchParams.set('scale', scale);
    $('#overlayUrl').value = url.toString();
    // Replay cover: the same scorebug URL + cover=1, so it lands on the same pixels.
    url.searchParams.set('cover', '1');
    $('#coverUrl').value = url.toString();
  }
  $('#copyCoverUrlBtn').addEventListener('click', () => copyField($('#coverUrl'), $('#copyCoverUrlBtn')));
  $('#openCoverBtn').addEventListener('click', () => window.open($('#coverUrl').value + '&preview=1', '_blank'));
  $('#ovPos').addEventListener('change', updateOverlayUrl);
  $('#ovScale').addEventListener('input', updateOverlayUrl);
  $('#copyUrlBtn').addEventListener('click', () => copyField($('#overlayUrl'), $('#copyUrlBtn')));
  $('#openOverlayBtn').addEventListener('click', () => window.open($('#overlayUrl').value, '_blank'));
  updateOverlayUrl();

  // ---- players intro URL (second Browser Source) ----
  $('#introUrl').value = new URL('/intro', location.origin).toString();
  $('#copyIntroUrlBtn').addEventListener('click', () => copyField($('#introUrl'), $('#copyIntroUrlBtn')));
  $('#openIntroBtn').addEventListener('click', () => window.open($('#introUrl').value, '_blank'));

  // ---- Import players (padeltour.ro link, or a pasted list) ----
  // read -> preview -> "keep or replace?" -> apply. The server does the reading.
  const IMP_URL_KEY = 'importLastUrl';
  const DEFAULT_CATS = ['Masculin 1', 'Masculin 2', 'Feminin 1'];
  let impPending = null; // preview returned by /api/import/read
  try {
    $('#impUrl').value = localStorage.getItem(IMP_URL_KEY) || '';
  } catch (_) { /* no storage */ }

  const impStatus = (text, kind) => {
    const el = $('#impStatus');
    el.textContent = text || '';
    el.className = 'hint imp-status' + (kind ? ' ' + kind : '');
  };
  const postJson = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || 'Request failed.')))));

  $('#impLoadBtn').addEventListener('click', () => {
    const link = $('#impUrl').value.trim();
    if (!link) return $('#impUrl').focus();
    try {
      localStorage.setItem(IMP_URL_KEY, link);
    } catch (_) { /* no storage */ }
    impStatus('Loading the categories…');
    $('#impLoadBtn').disabled = true;
    fetch('/api/import/categories?url=' + encodeURIComponent(link))
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || 'Could not load the page.')))))
      .then((info) => {
        const box = $('#impCats');
        box.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'imp-tournament';
        title.textContent = info.tournament || 'Tournament';
        box.appendChild(title);
        const defaults = (info.defaults || DEFAULT_CATS).map((s) => s.toLowerCase());
        for (const c of info.categories) {
          const label = document.createElement('label');
          label.className = 'check imp-cat';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = c.name;
          cb.checked = defaults.includes(c.name.toLowerCase());
          const cap = c.maxPairs != null ? ` · ${c.maxPairs} pairs` : '';
          label.append(cb, document.createTextNode(` ${c.name}${cap}`));
          box.appendChild(label);
        }
        box.hidden = false;
        $('#impReadRow').hidden = false;
        $('#impPreview').hidden = true;
        impStatus(`${info.categories.length} categories found. Tick the ones to import and press Read players.`);
      })
      .catch((err) => impStatus(err.message, 'error'))
      .finally(() => ($('#impLoadBtn').disabled = false));
  });

  function startRead(body, label) {
    impStatus(label);
    $('#impReadBtn').disabled = true;
    $('#impPasteBtn').disabled = true;
    $('#impPreview').hidden = true;
    postJson('/api/import/read', body)
      .then((preview) => {
        impPending = preview;
        showPreview(preview);
        askKeepOrReplace(preview);
      })
      .catch((err) => impStatus(err.message, 'error'))
      .finally(() => {
        $('#impReadBtn').disabled = false;
        $('#impPasteBtn').disabled = false;
      });
  }

  $('#impReadBtn').addEventListener('click', () => {
    const categories = $$('#impCats input[type=checkbox]:checked').map((cb) => cb.value);
    if (!categories.length) return impStatus('Tick at least one category.', 'error');
    startRead(
      { url: $('#impUrl').value.trim(), categories, includeWaiting: $('#impWaiting').checked },
      `Reading ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} from padeltour.ro… (about 2 seconds each)`
    );
  });

  $('#impPasteBtn').addEventListener('click', () => {
    const text = $('#impPasteText').value;
    const division = $('#impPasteDiv').value.trim();
    if (!division) return $('#impPasteDiv').focus();
    if (!text.trim()) return $('#impPasteText').focus();
    startRead(
      { paste: { text, division, gender: $('#impPasteGender').value }, includeWaiting: $('#impWaiting').checked },
      'Reading the pasted list…'
    );
  });

  function showPreview(p) {
    const box = $('#impPreview');
    box.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'imp-table';
    table.innerHTML = '<thead><tr><th>Category</th><th>On the site</th><th>Accepted</th><th>Waiting list</th><th>To import</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const c of p.categories) {
      const tr = document.createElement('tr');
      const notes = [];
      if (c.error) notes.push(c.error);
      if (c.noCountry) notes.push(`${c.noCountry} player${c.noCountry === 1 ? '' : 's'} without a country`);
      if (c.incomplete) notes.push(`${c.incomplete} entr${c.incomplete === 1 ? 'y' : 'ies'} without a partner skipped`);
      const cells = [c.name, c.registered == null ? '—' : c.registered, c.error ? '—' : c.accepted, c.error ? '—' : c.waiting, c.error ? 0 : c.imported, notes.join(' · ')];
      cells.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = String(v);
        if (i === 5) td.className = c.error ? 'imp-note error' : 'imp-note';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    box.hidden = false;
    impStatus(`${p.teams} pair${p.teams === 1 ? '' : 's'} read from “${p.tournament}”.` + (p.missing && p.missing.length ? ` Not on the page: ${p.missing.join(', ')}.` : ''));
  }

  function askKeepOrReplace(p) {
    const ex = p.existing || {};
    const fresh = ex.newIfKept == null ? p.teams : ex.newIfKept;
    const already = p.teams - fresh;
    const pairs = (n) => `${n} pair${n === 1 ? '' : 's'}`;
    $('#impModalText').textContent = ex.teams
      ? `The app has ${ex.teams} team${ex.teams === 1 ? '' : 's'} now${ex.tournament ? ` (${ex.tournament})` : ''}. ` +
        `Keep them and add ${fresh ? `the ${pairs(fresh)} that ${fresh === 1 ? 'is' : 'are'} not there yet` : 'nothing (all are there already)'}` +
        `${already ? ` — ${pairs(already)} already in the same division ${already === 1 ? 'is' : 'are'} skipped` : ''}, ` +
        `or replace them with the ${pairs(p.teams)} just read? Replacing also clears the eliminations and the name/country corrections made on the Teams tab.`
      : `The app has no teams yet. Import the ${pairs(p.teams)}?`;
    $('#impModal').hidden = false;
    $('#impKeepBtn').focus();
  }

  function finishImport(mode) {
    $('#impModal').hidden = true;
    if (!mode || !impPending) {
      impStatus('Import cancelled — nothing was changed.');
      return;
    }
    postJson('/api/import/apply', { token: impPending.token, mode })
      .then((r) => {
        impPending = null;
        const how = r.mode === 'replace' ? 'Teams replaced' : 'Teams kept';
        impStatus(`${how}: ${r.added} pair${r.added === 1 ? '' : 's'} added${r.skipped ? `, ${r.skipped} already there` : ''} — ${r.total} teams now. The Teams and Score settings tabs are updated.`, 'ok');
      })
      .catch((err) => impStatus(err.message, 'error'));
  }
  $('#impKeepBtn').addEventListener('click', () => finishImport('keep'));
  $('#impReplaceBtn').addEventListener('click', () => {
    if (confirm('Replace all teams with the imported ones? Eliminations and corrections are cleared.')) finishImport('replace');
  });
  $('#impCancelBtn').addEventListener('click', () => finishImport(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#impModal').hidden) finishImport(null);
  });

  // ---- Info bar (bottom announcements bar): settings + its URLs ----
  // The settings are announcement-bar settings on the server (annSettings);
  // this card is the only place they are edited.
  fetch('/api/announcements')
    .then((r) => r.json())
    .then((data) => {
      const s = data.settings || {};
      $('#ibVisible').checked = s.visible !== false;
      $('#ibRotate').value = s.rotateSeconds || 8;
      $('#ibLabel').value = s.label == null ? 'INFO' : s.label;
    })
    .catch(() => {});
  function saveInfoBar() {
    fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'annSettings',
        settings: {
          visible: $('#ibVisible').checked,
          rotateSeconds: Number($('#ibRotate').value) || 8,
          label: $('#ibLabel').value,
        },
      }),
    })
      // show the value the server kept (seconds are clamped to 3-120)
      .then(() => fetch('/api/announcements'))
      .then((r) => r.json())
      .then((data) => {
        if (document.activeElement !== $('#ibRotate')) $('#ibRotate').value = data.settings.rotateSeconds;
      })
      .catch(() => {});
  }
  ['#ibVisible', '#ibRotate', '#ibLabel'].forEach((sel) => $(sel).addEventListener('change', saveInfoBar));
  $('#ibUrl').value = new URL('/ticker', location.origin).toString();
  const isUrl = (v) => /^https?:\/\/\S+$/.test(v);
  const openPreview = (v) => isUrl(v) && window.open(v + (v.includes('?') ? '&' : '?') + 'preview=1', '_blank');
  $('#copyIbUrlBtn').addEventListener('click', () => copyField($('#ibUrl'), $('#copyIbUrlBtn')));
  $('#openIbUrlBtn').addEventListener('click', () => openPreview($('#ibUrl').value));
  $('#copyIbPubUrlBtn').addEventListener('click', () => isUrl($('#ibPubUrl').value) && copyField($('#ibPubUrl'), $('#copyIbPubUrlBtn')));
  $('#openIbPubUrlBtn').addEventListener('click', () => openPreview($('#ibPubUrl').value));

  // ---- Commercial break settings (OBS connection, scenes, commercials, instant replay) ----
  // Stored server-side in obs-settings.json, never broadcast. The Media tab
  // reloads its lists when they change (obs.settingsRev).
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
      $('#obsTestResult').textContent = 'Could not load the OBS settings.';
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
      .then((r) => flash($('#saveObsBtn'), r.ok ? 'Saved!' : 'Failed'))
      .catch(() => flash($('#saveObsBtn'), 'Failed'));
  });

  $('#testObsBtn').addEventListener('click', () => {
    const out = $('#obsTestResult');
    out.className = 'hint imp-status';
    out.textContent = 'Connecting to OBS…';
    $('#testObsBtn').disabled = true;
    fetch('/api/obs-test', { method: 'POST' })
      .then((r) => r.json())
      .then((r) => {
        out.className = 'hint imp-status ' + (r.ok ? 'ok' : 'error');
        out.textContent = r.ok
          ? `Connected to OBS${r.obsVersion ? ' ' + r.obsVersion : ''}${r.websocketVersion ? ' (WebSocket ' + r.websocketVersion + ')' : ''}.`
          : `Not connected: ${String(r.error || 'unknown error').trim()}${/[.?!]$/.test(String(r.error || '').trim()) ? '' : '.'} Save the settings first if you changed the URL or password.`;
      })
      .catch(() => {
        out.className = 'hint imp-status error';
        out.textContent = 'The score server did not answer.';
      })
      .finally(() => ($('#testObsBtn').disabled = false));
  });

  // ---- court TV URL (LAN) + public port info ----
  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      const host = info.lanHost || location.hostname;
      $('#tvUrl').value = `http://${host}:${info.port}/tv`;
      publicPort = info.publicPort || 0;
      $('#publicPort').textContent = publicPort || 'disabled';
      $('#publicLocal').textContent = publicPort ? `http://localhost:${publicPort}` : '(set PUBLIC_PORT)';
      updatePublicUrls();
    })
    .catch(() => {
      $('#tvUrl').value = new URL('/tv', location.origin).toString();
    });
  $('#copyTvUrlBtn').addEventListener('click', () => copyField($('#tvUrl'), $('#copyTvUrlBtn')));
  $('#openTvBtn').addEventListener('click', () => window.open($('#tvUrl').value, '_blank'));

  // ---- internet access (tunnel hostname + access key) ----
  function publicBase() {
    const host = ($('#publicHostname').value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host) return `https://${host}`;
    return publicPort ? `http://${location.hostname}:${publicPort}` : '';
  }

  function updatePublicUrls() {
    const base = publicBase();
    const key = ($('#refereeKey').value || '').trim();
    const keyed = (p) => (!base ? '' : key ? `${base}${p}?key=${encodeURIComponent(key)}` : '(set an access key first)');
    $('#pubHomeUrl').value = base ? (key ? `${base}/?key=${encodeURIComponent(key)}` : `${base}/`) : '';
    $('#pubOverlayUrl').value = base ? `${base}/overlay?pos=top-left` : '';
    $('#pubTvUrl').value = base ? `${base}/tv` : '';
    $('#pubTickerUrl').value = base ? `${base}/ticker` : '';
    $('#ibPubUrl').value = base ? `${base}/ticker` : '(set the public hostname in the Internet access card)';
    $('#pubAnnouncementsUrl').value = keyed('/announcements');
    $('#pubRefereeUrl').value = keyed('/mobile');
    $('#pubAdminUrl').value = keyed('/admin');
    $('#pubTeamsUrl').value = keyed('/teams');
    $('#pubMediaUrl').value = keyed('/media');
  }

  $('#publicHostname').addEventListener('input', updatePublicUrls);
  $('#refereeKey').addEventListener('input', updatePublicUrls);
  $('#genKeyBtn').addEventListener('click', () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters
    const rnd = new Uint32Array(12);
    crypto.getRandomValues(rnd);
    $('#refereeKey').value = Array.from(rnd, (n) => alphabet[n % alphabet.length]).join('');
    updatePublicUrls();
  });
  $('#saveInternetBtn').addEventListener('click', () => {
    fetch('/api/obs-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicHostname: $('#publicHostname').value.trim(),
        refereeKey: $('#refereeKey').value.trim(),
      }),
    })
      .then((r) => flash($('#saveInternetBtn'), r.ok ? 'Saved!' : 'Failed'))
      .catch(() => flash($('#saveInternetBtn'), 'Failed'));
  });
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copyField($('#' + b.dataset.copy), b)));

  // ---- Interview button (ATEM + OBS) ----
  const IV_FIELDS = ['atemHost', 'atemCourtInput', 'atemInterviewInput', 'interviewHide', 'interviewMute', 'interviewUnmute'];
  const atemStatus = (text) => ($('#atemStatus').textContent = text);
  fetch('/api/obs-settings')
    .then((r) => r.json())
    .then((cfg) => IV_FIELDS.forEach((k) => ($('#' + k).value = cfg[k] == null ? '' : cfg[k])))
    .catch(() => {});
  $('#saveInterviewBtn').addEventListener('click', () => {
    const body = {};
    IV_FIELDS.forEach((k) => (body[k] = $('#' + k).value.trim()));
    fetch('/api/obs-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => {
        flash($('#saveInterviewBtn'), r.ok ? 'Saved!' : 'Failed');
        if (!r.ok) atemStatus('Not saved - the ATEM IP must look like 192.168.88.240 (or be empty).');
      })
      .catch(() => flash($('#saveInterviewBtn'), 'Failed'));
  });
  $('#atemTestBtn').addEventListener('click', () => {
    const host = $('#atemHost').value.trim();
    atemStatus('Asking the ATEM…');
    fetch('/api/atem-test?host=' + encodeURIComponent(host), { method: 'POST' })
      .then((r) => r.json())
      .then((r) => {
        if (!r.ok) return atemStatus('✗ ' + r.error);
        const name = (id) => (r.inputs && r.inputs[id] ? r.inputs[id].long : 'input ' + id);
        atemStatus(`✓ ${r.product || 'ATEM'} at ${r.host} - on air now: ${name(r.programInput)} (${r.programInput}). Court = ${name($('#atemCourtInput').value)}, interview = ${name($('#atemInterviewInput').value)}.`);
      })
      .catch(() => atemStatus('✗ the score server did not answer'));
  });
  $('#atemFindBtn').addEventListener('click', () => {
    atemStatus('Looking for the ATEM on this network…');
    fetch('/api/atem-find', { method: 'POST' })
      .then((r) => r.json())
      .then((r) => {
        if (!r.found.length) {
          return atemStatus(`No ATEM found on ${r.networks.join(', ') || 'this PC'}. Check the network cable; the ATEM's IP is set with Blackmagic ATEM Setup (USB).`);
        }
        const typed = $('#atemHost').value.trim();
        if (!r.found.includes(typed)) $('#atemHost').value = r.found[0]; // the typed address does not answer
        atemStatus(`Found: ${r.found.join(', ')}${typed && !r.found.includes(typed) ? ` (nothing answers at ${typed})` : ''} - press Test, then Save.`);
      })
      .catch(() => atemStatus('✗ the score server did not answer'));
  });

  // ---- YouTube live stream link (website menu entry) ----
  $('#saveYoutubeBtn').addEventListener('click', () => {
    fetch('/api/obs-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: $('#youtubeUrl').value.trim() }),
    })
      .then((r) => (r.ok ? fetch('/api/obs-settings').then((x) => x.json()) : Promise.reject()))
      .then((cfg) => {
        $('#youtubeUrl').value = cfg.youtubeUrl || ''; // show the normalized link (https:// added, etc.)
        flash($('#saveYoutubeBtn'), 'Saved!');
      })
      .catch(() => flash($('#saveYoutubeBtn'), 'Failed'));
  });
  $('#openYoutubeBtn').addEventListener('click', () => {
    const url = $('#youtubeUrl').value.trim();
    if (url) window.open(/^https?:\/\//i.test(url) ? url : 'https://' + url, '_blank');
  });

  fetch('/api/obs-settings')
    .then((r) => r.json())
    .then((cfg) => {
      $('#publicHostname').value = cfg.publicHostname || '';
      $('#refereeKey').value = cfg.refereeKey || '';
      $('#youtubeUrl').value = cfg.youtubeUrl || '';
      updatePublicUrls();
    })
    .catch(() => {});

  // ---- score server (desktop app only, via the WebView2 message bridge) ----
  const host = window.chrome && window.chrome.webview;
  if (host) {
    const card = $('#hostCard');
    card.hidden = false;
    const send = (msg) => host.postMessage(msg);

    host.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || m.type !== 'host') return;
      $('#hostStatus').textContent = m.status || '';
      $('#hostDot').className = 'conn-dot' + (m.kind === 'ok' ? ' connected' : '');
      $('#hostStartStop').textContent = m.running ? 'Stop' : 'Start';
      if (document.activeElement !== $('#hostPort')) $('#hostPort').value = m.port;
      $('#hostAutoStart').checked = !!m.autoStart;
      $('#hostTray').checked = !!m.minimizeToTray;
      $('#hostOverlayUrl').value = m.overlayUrl || '';
      $('#hostMobileUrl').value = m.mobileUrl || '';
    });

    $('#hostStartStop').addEventListener('click', () => send({ type: 'startStop' }));
    $('#hostPort').addEventListener('change', () => {
      const port = parseInt($('#hostPort').value, 10);
      if (port > 0 && port < 65536) send({ type: 'setPort', port });
    });
    $('#hostAutoStart').addEventListener('change', () => send({ type: 'setAutoStart', value: $('#hostAutoStart').checked }));
    $('#hostTray').addEventListener('change', () => send({ type: 'setMinimizeToTray', value: $('#hostTray').checked }));
    $('#hostOpenBtn').addEventListener('click', () => send({ type: 'openInBrowser' }));
    $('#hostReloadBtn').addEventListener('click', () => send({ type: 'reload' }));
    send({ type: 'ready' });
  }

  // ---- collapsible cards: click a card's title to hide/show its content ----
  // Collapsed cards show only their title bar. Every card starts collapsed;
  // a card the operator opened (or closed) is remembered per card.
  const COLLAPSE_KEY = 'adminCollapsedCards';
  let collapsed = {};
  try {
    collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {};
  } catch (_) {
    collapsed = {};
  }
  $$('.layout > .card').forEach((card) => {
    const head = card.querySelector(':scope > .card-head');
    const title = head && head.querySelector('h2');
    if (!title) return;
    const name = title.textContent.trim();
    card.classList.add('collapsible');
    const chevron = document.createElement('span');
    chevron.className = 'collapse-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    head.appendChild(chevron);
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    const isCollapsed = () => collapsed[name] !== false; // no choice stored yet = collapsed
    const apply = () => {
      card.classList.toggle('collapsed', isCollapsed());
      head.setAttribute('aria-expanded', String(!isCollapsed()));
      head.title = isCollapsed() ? 'Show' : 'Hide';
    };
    const toggle = (e) => {
      if (e.target.closest('button, input, select, a, label')) return; // controls inside the title bar keep working
      collapsed[name] = !isCollapsed();
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
      } catch (_) { /* not persisted - still toggles */ }
      apply();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(e);
      }
    });
    apply();
  });

  // ---- helpers ----
  function copyField(input, btn) {
    input.select();
    navigator.clipboard?.writeText(input.value);
    flash(btn, 'Copied!');
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }
})();

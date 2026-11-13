'use strict';

/**
 * padeltour.ro importer: reads the registered pairs ("Înscriși") of a
 * tournament page, e.g.
 *   https://www.padeltour.ro/turnee/<club>/<tournament>/<edition>?tab=inscrisi
 *
 * How the site works (checked 2026-11-12): the page is a Next.js app. The
 * plain HTML carries the tournament and its categories (id, name, gender,
 * max_pairs, wildcard_count) inside the React Server Components payload
 * (`self.__next_f.push(...)`), but NOT the pairs - the browser loads those
 * from the site's database after the page opens. So:
 *   1. categories: plain GET of the page, decode the RSC payload;
 *   2. pairs: the page is rendered by Microsoft Edge in headless mode (like
 *      a visitor's browser) with `&cat=<category id>`, and the rendered DOM is
 *      read. Edge is preinstalled and Microsoft-signed on Windows.
 * Country codes come from the flag emoji the site shows (🇷🇴 -> "RO").
 *
 * Zero dependencies: Node's fetch + child_process only.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALLOWED_HOST = /(^|\.)padeltour\.ro$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) FRP-Live-importer';

/** Accepts only https://(www.)padeltour.ro/... links; returns a URL or throws. */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch (_) {
    throw new Error('That is not a valid link.');
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOST.test(u.hostname)) {
    throw new Error('Only padeltour.ro tournament links can be imported (https://www.padeltour.ro/turnee/...).');
  }
  if (!/^\/turnee\/[^/]+\/[^/]+/.test(u.pathname)) {
    throw new Error('Use the link of a tournament page (https://www.padeltour.ro/turnee/<club>/<tournament>/...).');
  }
  return u;
}

/** The page link for one category's registrations. */
function categoryUrl(pageUrl, catId) {
  const u = checkUrl(pageUrl);
  u.searchParams.set('tab', 'inscrisi');
  u.searchParams.set('cat', catId);
  return u.toString();
}

// ---------------------------------------------------------------------------
// 1. Categories from the plain HTML
// ---------------------------------------------------------------------------

/** Concatenated Next.js RSC payload (`self.__next_f.push([1,"..."])` chunks). */
function decodeRsc(html) {
  let rsc = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      rsc += JSON.parse(m[1]);
    } catch (_) {
      /* skip a broken chunk */
    }
  }
  return rsc;
}

/** The JSON object that starts at `start` (a '{'), by brace counting outside strings. */
function objectAt(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Tournament + categories from the page HTML.
 * Category objects in the payload look like
 *   {"id":"<uuid>","tournament_id":"<uuid>","name":"Masculin 2","gender":"male",...,"max_pairs":32,...,"wildcard_count":2,...}
 */
function parseTournamentPage(html) {
  const rsc = decodeRsc(html);
  const categories = [];
  const seen = new Set();
  const startRe = /\{"id":"([0-9a-f-]{36})","tournament_id":"([0-9a-f-]{36})"/gi;
  let m;
  while ((m = startRe.exec(rsc))) {
    const raw = objectAt(rsc, m.index);
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      continue;
    }
    if (!obj || typeof obj.name !== 'string' || !('max_pairs' in obj) || seen.has(obj.id)) continue;
    seen.add(obj.id);
    categories.push({
      id: obj.id,
      tournamentId: obj.tournament_id,
      name: obj.name.trim(),
      gender: obj.gender || '',
      maxPairs: Number.isFinite(obj.max_pairs) ? obj.max_pairs : null,
      wildcards: Number.isFinite(obj.wildcard_count) ? obj.wildcard_count : 0,
    });
  }
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i);
  const title = html.match(/<title>([^<]*)<\/title>/i);
  let name = decodeEntities((og && og[1]) || (title && title[1]) || '').trim();
  name = name.replace(/\s*[|·–—-]\s*Padel Tour\s*$/i, '').trim();
  return { name, categories };
}

async function fetchTournament(pageUrl) {
  const u = checkUrl(pageUrl);
  const r = await fetch(u.toString(), { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ro,en' } });
  if (!r.ok) throw new Error(`padeltour.ro answered ${r.status} for that link.`);
  const info = parseTournamentPage(await r.text());
  if (!info.categories.length) throw new Error('No categories found on that page — is it a tournament page?');
  return info;
}

// ---------------------------------------------------------------------------
// 2. Rendering a category with headless Edge
// ---------------------------------------------------------------------------

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch (_) {
      return false;
    }
  }) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A headless Edge driven over the DevTools protocol (WebSocket). `--dump-dom`
 * is not enough: it dumps ~2 s after load, before the site has fetched the
 * pairs from its database. Here every page is polled until it is ready.
 * One Edge process serves all categories of an import.
 */
async function openEdgeSession() {
  const edge = findEdge();
  if (!edge) throw new Error('Microsoft Edge was not found on this PC — use "Paste the list" instead.');
  const profile = path.join(os.tmpdir(), 'frp-live-edge-import');
  const portFile = path.join(profile, 'DevToolsActivePort');
  try {
    fs.unlinkSync(portFile);
  } catch (_) { /* first run */ }
  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', // Edge picks a free port and writes it to DevToolsActivePort
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => (exited = true));
  const kill = () => {
    try {
      if (!exited) child.kill();
    } catch (_) { /* gone */ }
  };

  try {
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
      if (exited) throw new Error('Edge closed right away.');
      try {
        port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]) || null;
      } catch (_) { /* not written yet */ }
      if (!port) await sleep(100);
    }
    if (!port) throw new Error('Edge did not start its DevTools interface.');

    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (_) { /* not up yet */ }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('Edge has no page to work with.');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Could not connect to Edge.')), { once: true });
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'DevTools error'));
      else p.resolve(msg.result);
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`Edge did not answer ${method}.`));
        }, 15000);
      });
    const html = async () => {
      const r = await call('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      return (r && r.result && r.result.value) || '';
    };

    return {
      /** Open `url` and poll its HTML until isReady(html) (or the timeout); returns the last HTML. */
      async load(url, isReady, timeoutMs = 30000) {
        await call('Page.navigate', { url });
        const t0 = Date.now();
        let last = '';
        while (Date.now() - t0 < timeoutMs) {
          await sleep(500);
          try {
            last = await html();
          } catch (_) {
            continue; // navigating
          }
          if (isReady(last)) return last;
        }
        return last;
      },
      /** Value of a JavaScript expression in the current page (e.g. 'document.body.innerText'). */
      async evaluate(expression) {
        // awaitPromise: an expression returning a promise resolves to its value
        const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        return r && r.result ? r.result.value : undefined;
      },
      async close() {
        try {
          await call('Browser.close');
        } catch (_) { /* already gone */ }
        try {
          ws.close();
        } catch (_) { /* closed */ }
        setTimeout(kill, 2000);
      },
    };
  } catch (err) {
    kill();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 3. Parsing the registrations list
// ---------------------------------------------------------------------------

/** Visible text of an HTML document, one text node per line. */
function htmlToLines(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
  )
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Text pasted by the operator (Ctrl+A, Ctrl+C on the page) -> lines. */
function textToLines(text) {
  return String(text || '')
    .split(/\r?\n|\t/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const flagToIso2 = (s) => [...s].map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join('');
const PTS = /^\((\d+|—|-)\s*pct\)$/i;
const isRowStart = (lines, i) => /^\d{1,3}$/.test(lines[i] || '') && /^\d{1,6}$/.test(lines[i + 1] || '');

/**
 * Pairs from the registrations list text. The list (on the page it appears
 * twice, once per screen layout - only the first copy is read) is
 *   26 / perechi înscrise / · 22+2 Wildcard-uri / ✓ Acceptați (24 / 24) / ...
 *   <rank> / <pair points> / [avatar initials] / [🇷🇴] / <name> / (3184 pct) / [🇷🇴] / <name> / (3789 pct) / ...
 *   ⏳ Listă de așteptare (2) / ... more rows ...
 */
function parseRegistrations(lines) {
  let start = lines.findIndex((l) => /^perechi înscrise$/i.test(l) || /perechi înscrise/i.test(l));
  if (start < 0) start = lines.findIndex((l) => /Acceptați/i.test(l));
  if (start < 0) return { found: false, registered: null, capacity: null, pairs: [], incomplete: 0 };
  let end = lines.findIndex((l, i) => i > start + 3 && /perechi înscrise/i.test(l));
  if (end < 0) end = lines.length;

  const registered = /^\d+$/.test(lines[start - 1] || '') ? Number(lines[start - 1]) : null;
  let capacity = null;
  for (let i = start; i < Math.min(end, start + 6); i++) {
    const c = lines[i].match(/^·?\s*(\d+)\s*\+\s*(\d+)\s+Wildcard/i);
    if (c) capacity = `${c[1]}+${c[2]}`;
  }

  const pairs = [];
  let incomplete = 0;
  let waiting = false;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (/Listă de așteptare/i.test(line)) {
      waiting = true;
      continue;
    }
    if (/^✓?\s*Acceptați/i.test(line)) {
      waiting = false;
      continue;
    }
    if (!isRowStart(lines, i)) continue;
    const rank = Number(lines[i]);
    const pairPoints = Number(lines[i + 1]);
    const players = [];
    let wildcard = false;
    let j = i + 2;
    for (; j < end && j < i + 40; j++) {
      const l = lines[j];
      if (isRowStart(lines, j) || /Listă de așteptare|^✓?\s*Acceptați/i.test(l)) break;
      if (l === 'Wildcard' || /^🔒/.test(l)) wildcard = true;
      const p = l.match(PTS);
      if (p && players.length < 2) {
        const name = lines[j - 1] || '';
        if (!name || FLAG.test(name) || /^[A-Z]{1,2}$/.test(name) || PTS.test(name)) continue;
        const flag = FLAG.test(lines[j - 2] || '') ? flagToIso2(lines[j - 2]) : '';
        players.push({ name, country: flag, points: /^\d+$/.test(p[1]) ? Number(p[1]) : 0 });
      }
    }
    if (players.length === 2) pairs.push({ rank, pairPoints, wildcard, waiting, players });
    else incomplete++;
    i = j - 1;
  }
  return { found: true, registered, capacity, pairs, incomplete };
}

// ---------------------------------------------------------------------------
// 4. Orchestration
// ---------------------------------------------------------------------------

/** "30+2" for a category with max_pairs 32 and 2 wildcards (as the page prints it). */
function expectedCapacity(cat) {
  return cat.maxPairs != null ? `${Math.max(0, cat.maxPairs - cat.wildcards)}+${cat.wildcards}` : null;
}

/**
 * Read the chosen categories of a tournament.
 * opts: { url, categories: ['Masculin 1', ...], session?, fetchInfo?, onProgress?, timeoutMs? }
 *   session: { load(url, isReady, timeoutMs) -> html, close() } - default: a headless Edge
 * Returns { name, url, categories: [{ name, gender, registered, capacity, pairs, incomplete, error }], missing }.
 */
async function readTournament(opts) {
  const info = await (opts.fetchInfo || fetchTournament)(opts.url);
  const wanted = (opts.categories || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const chosen = info.categories.filter((c) => wanted.includes(c.name.toLowerCase()));
  const missing = wanted.filter((w) => !info.categories.some((c) => c.name.toLowerCase() === w));
  if (!chosen.length) throw new Error('None of the chosen categories is on that page.');

  const session = opts.session || (await openEdgeSession());
  const results = [];
  const previous = []; // { name, keys } of the categories read so far
  try {
    for (const cat of chosen) {
      if (opts.onProgress) opts.onProgress(`Reading ${cat.name}…`);
      const expected = expectedCapacity(cat);
      let parsed = null;
      let error = null;
      let lastCount = -1;
      let stableSince = 0;
      // Ready = the list is there, shows this category (capacity), and its row count has stopped changing.
      const isReady = (html) => {
        const p = parseRegistrations(htmlToLines(html));
        if (!p.found || (expected && p.capacity && p.capacity !== expected)) return false;
        const complete = p.registered == null || p.pairs.length + p.incomplete >= p.registered;
        if (p.pairs.length !== lastCount) {
          lastCount = p.pairs.length;
          stableSince = Date.now();
          return false;
        }
        if (complete || Date.now() - stableSince > 3000) {
          parsed = p;
          return true;
        }
        return false;
      };
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        try {
          lastCount = -1;
          const html = await session.load(categoryUrl(opts.url, cat.id), isReady, opts.timeoutMs || 30000);
          if (parsed) attachProfiles(parsed.pairs, profileLinks(html));
          if (!parsed) {
            const p = parseRegistrations(htmlToLines(html));
            error = !p.found ? 'the list did not load in time' : expected && p.capacity !== expected ? `the page showed another category (${p.capacity} instead of ${expected})` : 'the list kept changing';
          }
        } catch (err) {
          error = err.message;
        }
      }
      if (parsed && parsed.pairs.length >= 4) {
        // The site ignoring &cat= would give the same list again. A few shared pairs are
        // normal (players may enter two divisions); a near-identical list is not.
        const keys = new Set(parsed.pairs.map((pr) => pairKey(pr.players)));
        const same = previous.find((prev) => {
          let shared = 0;
          for (const k of keys) if (prev.keys.has(k)) shared++;
          return shared >= 0.8 * Math.min(keys.size, prev.keys.size);
        });
        if (same) {
          error = `it showed the same pairs as ${same.name} — the site did not switch category`;
          parsed = null;
        } else {
          previous.push({ name: cat.name, keys });
        }
      }
      results.push({
        id: cat.id,
        name: cat.name,
        gender: cat.gender,
        registered: parsed ? parsed.registered : null,
        capacity: parsed ? parsed.capacity : null,
        pairs: parsed ? parsed.pairs : [],
        incomplete: parsed ? parsed.incomplete : 0,
        error: parsed ? null : `Could not read ${cat.name}: ${error || 'unknown error'}.`,
      });
    }
  } finally {
    if (!opts.session) await session.close();
  }
  return { name: info.name, url: checkUrl(opts.url).toString(), categories: results, missing };
}

function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Order-insensitive key of a pair's two names. */
function pairKey(players) {
  return (players || []).map((p) => normName(p.name)).sort().join(' + ');
}

/** "Masculin 1" -> "M1", "Feminin 2" -> "F2", "Mixt 1" -> "X1", "Divizia 40+" -> "D40". */
function divisionCode(name) {
  const n = normName(name);
  const num = (n.match(/\d+/) || [''])[0];
  if (/^masculin/.test(n)) return 'M' + num;
  if (/^feminin/.test(n)) return 'F' + num;
  if (/^mixt/.test(n)) return 'X' + num;
  if (/^divizia/.test(n)) return 'D' + num;
  return (n.replace(/[^a-z0-9]/g, '').slice(0, 4) || 'DIV').toUpperCase();
}

function categoryOf(gender, name) {
  if (gender === 'male') return 'men';
  if (gender === 'female') return 'women';
  if (gender === 'mixed') return 'mixed';
  const n = normName(name);
  if (/^masculin/.test(n)) return 'men';
  if (/^feminin/.test(n)) return 'women';
  return 'mixed';
}

/** Roster records (data/teams.json shape) for one parsed category. */
function toTeams(cat, opts = {}) {
  const code = divisionCode(cat.name);
  const out = [];
  for (const pr of cat.pairs) {
    if (pr.waiting && opts.includeWaiting === false) continue;
    const num = String(pr.rank).padStart(2, '0');
    out.push({
      id: pr.waiting ? `${code}-W${num}` : `${code}-${num}`,
      category: categoryOf(cat.gender, cat.name),
      division: cat.name,
      section: pr.waiting ? 'waiting_list' : 'main_draw',
      position: pr.rank,
      seed: null,
      wildcard: !!pr.wildcard,
      active: true,
      teamPoints: pr.pairPoints,
      players: pr.players.map((p) => ({
        name: p.name,
        country: p.country,
        ranking: null,
        rankingPoints: p.points,
        ...(p.profile ? { profile: p.profile } : {}), // '/slug' of the player's padeltour.ro profile
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Player profiles (padeltour.ro/<slug>) for the on-stream player cards
// ---------------------------------------------------------------------------

/** Site pages whose links are not player profiles. */
const NOT_PROFILES = new Set([
  'acasa', 'turnee', 'clasamente', 'regiuni', 'cluburi', 'liga', 'piata', 'regulament', 'termeni',
  'aderare', 'app', 'confidentialitate', 'cookies', 'americano', 'auth', 'club', 'padel',
]);

/** normalized player name -> '/slug', from the name links of a rendered registrations list. */
function profileLinks(html) {
  const map = new Map();
  const re = /<a\b[^>]*\bhref="(\/[a-z0-9][a-z0-9-]{0,80})"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of String(html || '').matchAll(re)) {
    if (NOT_PROFILES.has(m[1].slice(1).toLowerCase())) continue;
    const name = decodeEntities(m[2].replace(/<[^>]+>/g, ' '))
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const key = normName(name);
    if (key && /[a-z]/.test(key) && !map.has(key)) map.set(key, m[1]);
  }
  return map;
}

/** Puts `profile` ('/slug') on every parsed player whose name has a link. */
function attachProfiles(pairs, links) {
  for (const pr of pairs || []) {
    for (const p of pr.players || []) {
      const link = links.get(normName(p.name));
      if (link) p.profile = link;
    }
  }
}

/** '/slug', 'padeltour.ro/slug' or the full link -> 'https://www.padeltour.ro/slug' (null when it is not a profile link). */
function profileUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('/')) s = 'https://www.padeltour.ro' + s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  const slug = u.pathname.replace(/\/+$/, '').slice(1);
  if (!ALLOWED_HOST.test(u.hostname) || !/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug) || NOT_PROFILES.has(slug.toLowerCase())) return null;
  return 'https://www.padeltour.ro/' + slug.toLowerCase();
}

const num = (s) => {
  const m = String(s || '').replace(/\s/g, '').match(/^-?[\d.]+(,\d+)?$/);
  return m ? Number(m[0].replace(/\./g, '').replace(',', '.')) : null;
};

/**
 * Profile data from the visible text of a rendered profile page (document.body.innerText)
 * and its <title> ("Nedelcu Horia — jucător de padel, ..."). Values are read by
 * their labels, so a layout change on the site does not mix them up.
 */
function parseProfileText(text, title) {
  const lines = textToLines(text);
  const at = (re, from = 0) => {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  const out = {
    name: String(title || '').split(/\s+[—–-]\s+/)[0].trim(),
    points: null, level: null, tier: '', tournaments: null, wins: null, losses: null, winsWo: 0, lossesWo: 0, winRate: null,
    age: null, nationality: '', country: '', county: '', side: '', club: '',
    rankings: [], titles: { gold: 0, silver: 0, bronze: 0 }, form: [], setWinRate: null, setsWon: null, setsLost: null,
  };

  // Hero stats: 6.826 / PUNCTE TOTALE / 11,09 / Elite / 7 / TURNEE JUCATE / 39 / VICTORII / [+1 prin WO] / 3 / ÎNFRÂNGERI / ...
  const pts = at(/^puncte totale$/i);
  if (pts > 0) {
    out.points = num(lines[pts - 1]);
    if (/^\d+,\d+$/.test(lines[pts + 1] || '')) {
      out.level = num(lines[pts + 1]);
      if (lines[pts + 2] && num(lines[pts + 2]) == null) out.tier = lines[pts + 2];
    }
  }
  const before = (re) => {
    const i = at(re, Math.max(0, pts));
    return i > 0 ? num(lines[i - 1]) : null;
  };
  const woAfter = (re) => {
    const i = at(re, Math.max(0, pts));
    const m = i >= 0 && (lines[i + 1] || '').match(/^\+(\d+) prin WO$/i);
    return m ? Number(m[1]) : 0;
  };
  out.tournaments = before(/^turnee jucate$/i);
  out.wins = before(/^victorii$/i);
  out.losses = before(/^înfrângeri$/i);
  out.winsWo = woAfter(/^victorii$/i);
  out.lossesWo = woAfter(/^înfrângeri$/i);
  const wr = at(/^win rate$/i, Math.max(0, pts));
  if (wr > 0) out.winRate = num((lines[wr - 1] || '').replace('%', ''));

  // Badge: "<TIER> · 11,09" then the club (when the player has one)
  const badge = at(/^[\p{L} ]+ · \d+,\d+$/u);
  if (badge >= 0 && lines[badge + 1] && !/^vârstă$/i.test(lines[badge + 1])) out.club = lines[badge + 1];

  // INFORMAȚII: Vârstă / 30 ani / Naționalitate / 🇷🇴 / România / Județ / Constanța / Poziție joc / ◀ Stânga
  const info = at(/^informații$/i);
  if (info >= 0) {
    const end = at(/^clasamente pe categorii$|^titluri$/i, info);
    const sect = lines.slice(info + 1, end > info ? end : info + 14);
    const val = (re) => {
      const i = sect.findIndex((l) => re.test(l));
      return i >= 0 ? sect[i + 1] || '' : '';
    };
    const age = val(/^vârstă$/i).match(/^(\d+)\s*ani$/i);
    if (age) out.age = Number(age[1]);
    const n = sect.findIndex((l) => /^naționalitate$/i.test(l));
    if (n >= 0) {
      if (FLAG.test(sect[n + 1] || '')) {
        out.country = flagToIso2(sect[n + 1]);
        out.nationality = sect[n + 2] || '';
      } else out.nationality = sect[n + 1] || '';
    }
    out.county = val(/^(județ|raion)$/i);
    out.side = val(/^poziție joc$/i).replace(/[◀▶]/g, '').trim();
  }

  // CLASAMENTE PE CATEGORII: #1 / Masculin 1 / 8 turnee / 4500 pts, repeated
  const rk = at(/^clasamente pe categorii$/i);
  if (rk >= 0) {
    for (let i = rk + 1; i + 3 < lines.length && /^#\d+$/.test(lines[i]); i += 4) {
      const t = (lines[i + 2].match(/^(\d+)\s*turne(?:e|u)$/i) || [])[1]; // "8 turnee", "1 turneu"
      const p = (lines[i + 3].match(/^([\d.]+)\s*pts$/i) || [])[1];
      out.rankings.push({ rank: Number(lines[i].slice(1)), category: lines[i + 1], tournaments: t ? Number(t) : null, points: p ? num(p) : null });
    }
  }

  // TITLURI: 9 / AUR / 0 / ARGINT / 2 / BRONZ
  const tl = at(/^titluri$/i);
  if (tl >= 0) {
    const medal = (re) => {
      const i = at(re, tl);
      return i > tl && i < tl + 8 ? num(lines[i - 1]) || 0 : 0;
    };
    out.titles = { gold: medal(/^aur$/i), silver: medal(/^argint$/i), bronze: medal(/^bronz$/i) };
  }

  // Formă recentă: Tendință ultimele 10 meciuri / 10–0 / V / Î / ...
  const fr = at(/^formă recentă$/i);
  if (fr >= 0) {
    for (let i = fr + 1; i < Math.min(lines.length, fr + 16); i++) {
      if (/^[VÎ]$/.test(lines[i])) out.form.push(lines[i] === 'V' ? 'W' : 'L');
      else if (out.form.length) break;
    }
  }

  // Set win rate: Procent seturi câștigate / 91% / 75–7 seturi
  const sw = at(/^set win rate$/i);
  if (sw >= 0) {
    for (let i = sw + 1; i < Math.min(lines.length, sw + 5); i++) {
      const pct = lines[i].match(/^(\d+)%$/);
      if (pct && out.setWinRate == null) out.setWinRate = Number(pct[1]);
      const sets = lines[i].match(/^(\d+)\s*[–-]\s*(\d+)\s*seturi$/i);
      if (sets) {
        out.setsWon = Number(sets[1]);
        out.setsLost = Number(sets[2]);
        break;
      }
    }
  }
  return out;
}

/**
 * Reads profiles in a headless Edge (the info block is filled in by the page's script).
 * urls: ['https://www.padeltour.ro/horia', ...]. opts: { session?, timeoutMs?, onProgress? }
 * Returns [{ url, ok, data?, photoUrl?, error? }] in the same order.
 */
async function readProfiles(urls, opts = {}) {
  const session = opts.session || (await openEdgeSession());
  const out = [];
  try {
    for (const url of urls) {
      if (opts.onProgress) opts.onProgress(url);
      try {
        // Only text shown on the page counts (">…<"): the page's script also carries these words as labels.
        const shown = (h, re) => new RegExp('>\\s*' + re + '\\s*<', 'i').test(h);
        const html = await session.load(url, (h) => shown(h, 'Informații') || shown(h, 'Jucătorul nu a fost găsit\\.?'), opts.timeoutMs || 30000);
        if (!shown(html, 'Informații') && shown(html, 'Jucătorul nu a fost găsit\\.?')) throw new Error('profile not found');
        if (!opts.session) await new Promise((r) => setTimeout(r, 800)); // let the last blocks render
        const page = await session.evaluate(`JSON.stringify({
          text: document.body ? document.body.innerText : '',
          title: document.title,
          photo: (document.querySelector('link[rel=preload][href*="/avatar."]') || {}).href
            || (document.querySelector('img[src*="/avatar."]') || {}).src || ''
        })`);
        const p = JSON.parse(page || '{}');
        const data = parseProfileText(p.text, p.title);
        if (data.points == null && data.age == null && !data.rankings.length) throw new Error('the profile did not load');
        out.push({ url, ok: true, data, photoUrl: /^https:\/\//.test(p.photo || '') ? p.photo : '' });
      } catch (err) {
        out.push({ url, ok: false, error: err.message });
      }
    }
  } finally {
    if (!opts.session) await session.close();
  }
  return out;
}

module.exports = {
  checkUrl,
  categoryUrl,
  parseTournamentPage,
  fetchTournament,
  findEdge,
  openEdgeSession,
  htmlToLines,
  textToLines,
  parseRegistrations,
  readTournament,
  pairKey,
  divisionCode,
  categoryOf,
  toTeams,
  normName,
  profileLinks,
  attachProfiles,
  profileUrl,
  parseProfileText,
  readProfiles,
};

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
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) FRP-broadcasting-importer';

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
  const profile = path.join(os.tmpdir(), 'frp-broadcasting-edge-import');
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
        const r = await call('Runtime.evaluate', { expression, returnByValue: true });
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
      players: pr.players.map((p) => ({ name: p.name, country: p.country, ranking: null, rankingPoints: p.points })),
    });
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
};

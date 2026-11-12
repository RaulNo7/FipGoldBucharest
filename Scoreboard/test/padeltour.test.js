'use strict';

/* Tests for the padeltour.ro importer (src/padeltour.js) on synthetic pages
   that follow the real page structure (checked 2026-11-12). Names are made up. */

const P = require('../src/padeltour');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ FAIL: ' + msg);
  }
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

console.log('\nRunning padeltour importer tests…\n');

const flag = (iso2) => [...iso2].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');

// ---- the registrations list as rendered (one text node per element) ---------
function row(rank, pts, p1, p2, extra = []) {
  const player = (p) => [p.c ? `<span>${flag(p.c)}</span>` : '', `<a>${p.n}</a>`, `<span>(${p.pts} pct)</span>`].join('');
  return `<div><span>${rank}</span><span>${pts}</span>${extra.map((e) => `<span>${e}</span>`).join('')}${player(p1)}${player(p2)}</div>`;
}
function listHtml() {
  const rows = [
    row(1, 7000, { c: 'RO', n: 'Ion Popa', pts: 4000 }, { c: 'RO', n: 'Dan Marin', pts: 3000 }),
    row(2, 6000, { c: 'MD', n: 'Ana Rusu', pts: 3500 }, { c: 'ES', n: 'Luis Vega', pts: 2500 }, ['A']),
    row(3, 1200, { c: '', n: 'Kim Nordby', pts: 600 }, { c: 'RO', n: 'Radu Ene', pts: 600 }, ['K']),
    row(4, 500, { c: 'RO', n: 'Mihai Tudor', pts: 500 }, { c: 'BG', n: 'Petar Ivanov', pts: 0 }, ['M', 'Wildcard']),
  ].join('');
  const waiting = row(5, 300, { c: 'RO', n: 'Paul Stan', pts: 200 }, { c: 'MA', n: 'Omar Haddad', pts: 100 });
  const block = `<div><span>5</span><span>perechi înscrise</span><span>· 2+2 Wildcard-uri</span><span>✓ Acceptați (4 / 4)</span>${rows}<span>🔒 Garantat de organizator</span><span>⏳ Listă de așteptare (1)</span>${waiting}</div>`;
  // The real page renders the list twice (two layouts); only the first copy is read.
  return `<html><body><nav>Masculin 1</nav>${block}<div class="mobile">${block}</div><script>var x = "<span>9</span><span>9</span>";</script></body></html>`;
}

(function parsesRenderedList() {
  const p = P.parseRegistrations(P.htmlToLines(listHtml()));
  eq([p.found, p.registered, p.capacity, p.pairs.length, p.incomplete], [true, 5, '2+2', 5, 0], 'rendered list: header numbers, all 5 pairs read once (second layout ignored)');
  eq(p.pairs.map((x) => x.waiting), [false, false, false, false, true], 'rendered list: the pair after "Listă de așteptare" is on the waiting list');
  eq(p.pairs[0].players, [{ name: 'Ion Popa', country: 'RO', points: 4000 }, { name: 'Dan Marin', country: 'RO', points: 3000 }], 'rendered list: names, flag -> 2-letter code, points');
  eq(p.pairs[1].players.map((x) => x.country), ['MD', 'ES'], 'rendered list: avatar initials before the flag are skipped');
  eq(p.pairs[2].players.map((x) => x.country), ['', 'RO'], 'rendered list: a player without a flag gets an empty country');
  eq([p.pairs[3].wildcard, p.pairs[0].wildcard], [true, false], 'rendered list: "Wildcard" marks the pair');
  eq(p.pairs[4].players.map((x) => x.country), ['RO', 'MA'], 'rendered list: any 2-letter country (MA)');
})();

(function parsesPastedText() {
  // What Ctrl+A / Ctrl+C gives: one item per line, upper-cased headings, tabs.
  const text = [
    'Padel Tour', 'Înscriși', '5', 'perechi înscrise', '· 2+2 Wildcard-uri', '✓ ACCEPTAȚI (4 / 4)', '— sortare după suma punctelor perechii',
    '1', '7000', flag('RO'), 'Ion Popa', '(4000 pct)', flag('RO'), 'Dan Marin', '(3000 pct)', 'Puncte de calificare: 7100 (informativ)',
    '2', '6000', 'A', flag('MD'), 'Ana Rusu', '(3500 pct)', flag('ES'), 'Luis Vega', '(2500 pct)',
    '⏳ LISTĂ DE AȘTEPTARE (1)',
    '3', '300', flag('RO'), 'Paul Stan', '(200 pct)', flag('MA'), 'Omar Haddad', '(100 pct)',
  ].join('\r\n');
  const p = P.parseRegistrations(P.textToLines(text));
  eq([p.found, p.registered, p.pairs.length], [true, 5, 3], 'pasted text: list found and read');
  eq(p.pairs.map((x) => x.waiting), [false, false, true], 'pasted text: upper-case "LISTĂ DE AȘTEPTARE" starts the waiting list');
})();

(function noListFound() {
  const p = P.parseRegistrations(P.htmlToLines('<html><body><h1>Info</h1><p>291 perechi · 512 jucători</p></body></html>'));
  eq([p.found, p.pairs.length], [false, 0], 'info tab (list not loaded yet): not found');
})();

(function parsesCategoriesFromPayload() {
  const cat = (id, name, gender, max, wc) =>
    `{"id":"${id}","tournament_id":"2873ecdd-a2dd-4f0e-aa2a-2cef1da38fe2","name":"${name}","gender":"${gender}","min_level":null,"max_pairs":${max},"format":"groups","wildcard_count":${wc},"nested":{"a":"{not a brace}"}}`;
  const payload = `0:["$","div",null,{"categories":[${cat('ae042661-1c6b-4b60-8895-b7aa4487c057', 'Masculin 1', 'male', 24, 2)},${cat('6e7715dc-1be3-4112-9f81-c3c29fea0220', 'Feminin 1', 'female', 12, 2)}]}]`;
  const html = `<html><head><meta property="og:title" content="Club Cup &amp; Friends — Brașov, 1–2 dec 2026"></head><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
  const info = P.parseTournamentPage(html);
  eq(info.name, 'Club Cup & Friends — Brașov, 1–2 dec 2026', 'page: tournament name from og:title (entities decoded)');
  eq(info.categories.map((c) => [c.name, c.gender, c.maxPairs, c.wildcards]), [['Masculin 1', 'male', 24, 2], ['Feminin 1', 'female', 12, 2]], 'page: categories with capacity from the RSC payload');
})();

(function urlsAreChecked() {
  let err = null;
  try {
    P.checkUrl('https://evil.example/turnee/a/b');
  } catch (e) {
    err = e.message;
  }
  assert(/Only padeltour\.ro/.test(err || ''), 'links outside padeltour.ro are refused');
  err = null;
  try {
    P.checkUrl('http://www.padeltour.ro/turnee/a/b');
  } catch (e) {
    err = e.message;
  }
  assert(!!err, 'plain http is refused');
  const u = P.categoryUrl('https://www.padeltour.ro/turnee/padel-palace/padel-palace-major/nov2026?tab=info', 'ae042661-1c6b-4b60-8895-b7aa4487c057');
  eq(new URL(u).searchParams.get('tab') + ' ' + new URL(u).searchParams.get('cat'), 'inscrisi ae042661-1c6b-4b60-8895-b7aa4487c057', 'category link: tab=inscrisi&cat=<id>');
})();

(function buildsRosterRecords() {
  const p = P.parseRegistrations(P.htmlToLines(listHtml()));
  const all = P.toTeams({ name: 'Masculin 1', gender: 'male', pairs: p.pairs });
  const accepted = P.toTeams({ name: 'Masculin 1', gender: 'male', pairs: p.pairs }, { includeWaiting: false });
  eq(all.map((t) => t.id), ['M1-01', 'M1-02', 'M1-03', 'M1-04', 'M1-W05'], 'records: ids by division code and list position, W for the waiting list');
  eq([all.length, accepted.length], [5, 4], 'records: the waiting list can be left out');
  eq([all[0].category, all[0].division, all[0].section, all[4].section, all[0].teamPoints, all[0].players[0].rankingPoints], ['men', 'Masculin 1', 'main_draw', 'waiting_list', 7000, 4000], 'records: category, division, section, points');
  eq(['Masculin 2', 'Feminin 1', 'Mixt 1', 'Divizia 40+'].map(P.divisionCode), ['M2', 'F1', 'X1', 'D40'], 'division codes');
  eq([P.categoryOf('', 'Feminin 3'), P.categoryOf('open', 'Divizia 40+'), P.categoryOf('female', 'x')], ['women', 'mixed', 'women'], 'category from gender, else from the name');
  eq(P.pairKey([{ name: 'Ștefan Ionescu' }, { name: 'Ana  Pop' }]), P.pairKey([{ name: 'ana pop' }, { name: 'Stefan Ionescu' }]), 'pair key ignores order, case, spaces and diacritics');
})();

(async function readsWithAFakeBrowser() {
  // readTournament with a stub session: the first load shows the Info tab, the second the list.
  const html = listHtml();
  const loads = [];
  const session = {
    async load(url, isReady) {
      loads.push(url);
      if (isReady('<html><body>Info</body></html>')) return 'early';
      // the list arrives in two polls with the same row count -> ready
      for (let i = 0; i < 3; i++) if (isReady(html)) return html;
      return html;
    },
    async close() {},
  };
  const fetchInfo = async () => ({ name: 'Test Open', categories: [{ id: 'ae042661-1c6b-4b60-8895-b7aa4487c057', name: 'Masculin 1', gender: 'male', maxPairs: 4, wildcards: 2 }] });
  const r = await P.readTournament({ url: 'https://www.padeltour.ro/turnee/x/y/z', categories: ['Masculin 1', 'Feminin 9'], session, fetchInfo });
  eq([r.name, r.categories.length, r.categories[0].pairs.length, r.categories[0].error, r.missing], ['Test Open', 1, 5, null, ['feminin 9']], 'readTournament: waits for the list, reports categories not on the page');
  assert(/[?&]cat=ae042661/.test(loads[0]), 'readTournament: opens the category by its id');

  const wrongCat = async () => ({ name: 'T', categories: [{ id: 'ae042661-1c6b-4b60-8895-b7aa4487c057', name: 'Masculin 1', gender: 'male', maxPairs: 32, wildcards: 2 }] });
  const quick = { async load(url, isReady) { isReady(html); isReady(html); return html; }, async close() {} };
  const r2 = await P.readTournament({ url: 'https://www.padeltour.ro/turnee/x/y/z', categories: ['Masculin 1'], session: quick, fetchInfo: wrongCat });
  assert(/another category \(2\+2 instead of 30\+2\)/.test(r2.categories[0].error || ''), 'readTournament: a page showing another category is rejected (capacity check): ' + r2.categories[0].error);

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed ? 1 : 0);
})();

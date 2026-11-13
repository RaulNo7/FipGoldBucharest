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
  const player = (p) => [p.c ? `<span>${flag(p.c)}</span>` : '', `<a${p.s ? ` href="/${p.s}"` : ''}>${p.n}</a>`, `<span>(${p.pts} pct)</span>`].join('');
  return `<div><span>${rank}</span><span>${pts}</span>${extra.map((e) => `<span>${e}</span>`).join('')}${player(p1)}${player(p2)}</div>`;
}
function listHtml() {
  const rows = [
    row(1, 7000, { c: 'RO', n: 'Ion Popa', pts: 4000, s: 'ion-popa-1a2b3c' }, { c: 'RO', n: 'Dan Marin', pts: 3000, s: 'danmarin' }),
    row(2, 6000, { c: 'MD', n: 'Ana Rusu', pts: 3500 }, { c: 'ES', n: 'Luis Vega', pts: 2500 }, ['A']),
    row(3, 1200, { c: '', n: 'Kim Nordby', pts: 600 }, { c: 'RO', n: 'Radu Ene', pts: 600 }, ['K']),
    row(4, 500, { c: 'RO', n: 'Mihai Tudor', pts: 500 }, { c: 'BG', n: 'Petar Ivanov', pts: 0 }, ['M', 'Wildcard']),
  ].join('');
  const waiting = row(5, 300, { c: 'RO', n: 'Paul Stan', pts: 200 }, { c: 'MA', n: 'Omar Haddad', pts: 100 });
  const block = `<div><span>5</span><span>perechi înscrise</span><span>· 2+2 Wildcard-uri</span><span>✓ Acceptați (4 / 4)</span>${rows}<span>🔒 Garantat de organizator</span><span>⏳ Listă de așteptare (1)</span>${waiting}</div>`;
  // The real page renders the list twice (two layouts); only the first copy is read.
  return `<html><body><nav><a href="/turnee">Turnee</a> Masculin 1</nav>${block}<div class="mobile">${block}</div><script>var x = "<span>9</span><span>9</span>";</script></body></html>`;
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

  // ---- profile links kept by the import (player cards) ----
  const team1 = P.toTeams(r.categories[0])[0];
  eq(team1.players.map((x) => x.profile || ''), ['/ion-popa-1a2b3c', '/danmarin'], 'import: each player keeps the link of their padeltour.ro profile');
  eq(P.toTeams(r.categories[0])[1].players.map((x) => 'profile' in x), [false, false], 'import: players without a link get no profile field');
  eq(P.profileLinks('<a href="/turnee">Turnee</a><a href="/acasa">Acasă</a>').size, 0, 'profile links: site pages are not profiles');

  eq(
    [P.profileUrl('/horia'), P.profileUrl('padeltour.ro/Horia/'), P.profileUrl('https://www.padeltour.ro/ion-popa-1a2b3c?x=1'),
      P.profileUrl('https://example.com/horia'), P.profileUrl('/turnee'), P.profileUrl('/a/b'), P.profileUrl('')],
    ['https://www.padeltour.ro/horia', 'https://www.padeltour.ro/horia', 'https://www.padeltour.ro/ion-popa-1a2b3c', null, null, null, null],
    'profileUrl: only padeltour.ro player links'
  );

  // ---- a rendered profile (document.body.innerText layout, made-up player) ----
  const profileText = [
    'Înregistrare', '☀', '120 de vizite', flag('RO'), 'POPA', 'ION', '3', 'URMĂRITORI', '1', 'URMĂRIRI', 'Masculin', 'Brașov',
    'JOACĂ ÎN', 'Masculin 1', '2.100', 'puncte', '#4', 'Distribuie', 'PADEL TOUR', 'CLUB TEST', 'ION POPA', 'MASCULIN 1', 'PLAYER', 'ION POPA',
    'GRAND MASTER · 8,40', 'Club Test Brașov', 'VÂRSTĂ', '35 ani', 'JUDEȚ', 'Brașov', 'POZIȚIE JOC', 'Dreapta ▶', 'PADEL TOUR',
    '5.432', 'PUNCTE TOTALE', '8,40', 'Grand Master', '12', 'TURNEE JUCATE', '30', 'VICTORII', '+2 prin WO', '20', 'ÎNFRÂNGERI', '60%', 'WIN RATE',
    'NIVEL PT', '8,40', 'NIVEL OFICIAL', 'Grand Master',
    'INFORMAȚII', 'Vârstă', '35 ani', 'Naționalitate', flag('RO'), 'România', 'Județ', 'Brașov', 'Poziție joc', 'Dreapta ▶',
    'CLASAMENTE PE CATEGORII', '#4', 'Masculin 1', '9 turnee', '2100 pts', '#40', 'Masculin 2', '1 turneu', '300 pts',
    'TITLURI', '2', 'AUR', '1', 'ARGINT', '0', 'BRONZ', 'Open X', 'Masculin 1',
    'Formă recentă', 'Tendință ultimele 10 meciuri', '3–2', 'V', 'Î', 'V', 'V', 'Î', '🎯', 'Set win rate', 'Procent seturi câștigate', '58%', '70–51 seturi',
  ].join('\n');
  const prof = P.parseProfileText(profileText, 'Ion Popa — jucător de padel, Masculin 1, locul 4 | Padel Tour');
  eq(
    [prof.name, prof.points, prof.level, prof.tier, prof.tournaments, prof.wins, prof.winsWo, prof.losses, prof.lossesWo, prof.winRate],
    ['Ion Popa', 5432, 8.4, 'Grand Master', 12, 30, 2, 20, 0, 60],
    'profile: name, points, PT level + tier, record (walkovers after the wins), win rate'
  );
  eq([prof.age, prof.nationality, prof.country, prof.county, prof.side, prof.club], [35, 'România', 'RO', 'Brașov', 'Dreapta', 'Club Test Brașov'], 'profile: age, nationality + flag, county, side, club');
  eq(prof.rankings, [{ rank: 4, category: 'Masculin 1', tournaments: 9, points: 2100 }, { rank: 40, category: 'Masculin 2', tournaments: 1, points: 300 }], 'profile: category ranks ("1 turneu" too)');
  eq([prof.titles, prof.form, prof.setWinRate, prof.setsWon, prof.setsLost], [{ gold: 2, silver: 1, bronze: 0 }, ['W', 'L', 'W', 'W', 'L'], 58, 70, 51], 'profile: titles, recent form, sets');
  const bare = P.parseProfileText('Înregistrare\nINFORMAȚII\nNaționalitate\nRomânia', 'X Y — jucător');
  eq([bare.age, bare.nationality, bare.points, bare.rankings.length, bare.form.length], [null, 'România', null, 0, 0], 'profile: hidden fields stay empty');

  // readProfiles with a stand-in browser
  const fakeEdge = {
    async load(url, isReady) { isReady('<h2>Informații</h2>'); return '<h2>Informații</h2>'; },
    async evaluate() { return JSON.stringify({ text: profileText, title: 'Ion Popa — x', photo: 'https://x.supabase.co/storage/v1/object/public/avatars/1/avatar.jpg' }); },
    async close() {},
  };
  const pr = await P.readProfiles(['https://www.padeltour.ro/ion-popa-1a2b3c'], { session: fakeEdge });
  eq([pr[0].ok, pr[0].data.points, pr[0].photoUrl.endsWith('/avatar.jpg')], [true, 5432, true], 'readProfiles: data + photo link from the rendered page');
  const empty = { ...fakeEdge, async evaluate() { return JSON.stringify({ text: 'nimic', title: '' }); } };
  eq((await P.readProfiles(['https://www.padeltour.ro/x'], { session: empty }))[0].ok, false, 'readProfiles: a page without profile data is an error');

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed ? 1 : 0);
})();

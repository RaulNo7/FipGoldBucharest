'use strict';

/* Tests for the regional event roster (src/regions.js). Names are made up. */

const R = require('../src/regions');

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
function throws(fn, re, msg) {
  try {
    fn();
    assert(false, msg + ' (did not throw)');
  } catch (err) {
    assert(re.test(err.message), `${msg} (threw "${err.message}")`);
  }
}

console.log('\nRunning regional event tests…\n');

// ---- new roster ----
const roster = R.newRegionalRoster('Echipa Națională 2027 — Etapa I, Brașov');
eq(roster.format, 'regions', 'format');
eq(roster.shortName, 'Echipa Națională 2027', 'short name before the dash');
eq(roster.regions.length, 8, '8 default regions');
assert(R.isRegional(roster) && !R.isRegional({ teams: [] }), 'isRegional');
assert(!('counties' in roster.regions[0]), 'counties are not copied into the roster');

// ---- parsing pasted lines ----
const parsed = R.parsePlayerLines(
  [
    '1. Ion Popescu, https://www.padeltour.ro/ion-popescu-1a2b',
    'Dan Marin\tM\tRO',
    'Vlad Rusu; MD',
    'padeltour.ro/andrei-ene-9z',
    '  ',
    'Ana Pop, F',
    '42.',
  ].join('\n'),
  'M'
);
eq(parsed.players.map((p) => p.name), ['Ion Popescu', 'Dan Marin', 'Vlad Rusu', 'Andrei Ene', 'Ana Pop'], 'names');
eq(parsed.players[0].profile, '/ion-popescu-1a2b', 'profile link kept as a path');
eq(parsed.players[2].country, 'MD', 'country code');
eq(parsed.players[1].country, 'RO', 'default country RO');
assert(parsed.players[3].nameFromLink === true, 'name from a bare link is marked');
eq(parsed.players[4].gender, 'F', 'gender per line wins over the form');
eq(parsed.players[0].gender, 'M', 'form gender as default');
eq(parsed.skipped, ['42.'], 'unreadable line reported');
eq(R.parsePlayerLines('Ion Pop', '').players[0].gender, '', 'no gender when neither line nor form says');

// ---- adding players ----
const men = R.parsePlayerLines('Ion Popescu\nDan Marin\nRadu Ene\nMihai Tudor', 'M').players;
let r = R.addPlayers(roster, 'C', men);
eq(r.added, 4, 'four men added to Centru');
r = R.addPlayers(roster, 'C', R.parsePlayerLines('ion popescu\nAna Pop\nIoana Rus', 'F').players);
eq(r.duplicates, ['ion popescu'], 'same name (any case) is a duplicate');
eq(r.added, 2, 'two women added');
r = R.addPlayers(roster, 'NE', R.parsePlayerLines('Paul Stan\nCristi Lupu\nMaria Ene, F', 'M').players);
eq(r.added, 3, 'Nord-Est players');
eq(R.addPlayers(roster, 'NE', [{ name: 'Fara Gen', gender: '' }]).noGender, ['Fara Gen'], 'player without gender refused');
throws(() => R.addPlayers(roster, 'XX', men), /unknown region/, 'unknown region');

const id = (name) => roster.players.find((p) => p.name === name).id;

// ---- pairs ----
const pair = R.makePair(roster, [id('Ion Popescu'), id('Dan Marin')]);
eq(pair.id, 'C-M-01', 'pair id: region-gender-number');
eq(pair.division, 'Centru', 'division = region name');
eq(pair.category, 'men', 'category');
eq(pair.players.map((p) => p.name), ['Ion Popescu', 'Dan Marin'], 'pair players copied from the pool');
assert(R.makePair(roster, [id('Dan Marin'), id('Ion Popescu')]) === pair, 'same two players = the same pair');
eq(R.makePair(roster, [id('Radu Ene'), id('Ion Popescu')]).id, 'C-M-02', 'a player can be in more than one pair');
throws(() => R.makePair(roster, [id('Ion Popescu'), id('Ana Pop')]), /men or both women/, 'mixed gender refused');
throws(() => R.makePair(roster, [id('Ion Popescu'), id('Paul Stan')]), /same region/, 'two regions refused');
throws(() => R.makePair(roster, [id('Ion Popescu'), id('Ion Popescu')]), /two different/, 'same player twice refused');

// ---- pool changes reach the pairs ----
R.updatePlayer(roster, id('Dan Marin'), { name: 'Dan  Marinescu ', country: 'md' });
eq(pair.players[1].name, 'Dan Marinescu', 'rename reaches the pair');
eq(pair.players[1].country, 'MD', 'country reaches the pair');
R.updatePlayer(roster, id('Ion Popescu'), { profile: '/ion-popescu-1a2b' });
eq(pair.players[0].profile, '/ion-popescu-1a2b', 'profile link reaches the pair');
R.updateRegions(roster, [{ id: 'C', name: 'Centru (BV)', short: 'cen', color: '#123abc' }]);
eq(pair.division, 'Centru (BV)', 'region rename reaches the pair');
eq(R.regionBadge(roster, 'C'), { id: 'C', name: 'Centru (BV)', short: 'CEN', color: '#123ABC' }, 'badge');
eq(R.regionBadge(roster, 'nope'), null, 'no badge for an unknown region');

R.updatePlayer(roster, id('Radu Ene'), { gender: 'F' });
eq(roster.teams.map((t) => t.id), ['C-M-01'], 'gender change drops that player\'s pairs');
R.updatePlayer(roster, id('Radu Ene'), { gender: 'M', available: false });
eq(roster.players.find((p) => p.name === 'Radu Ene').available, false, 'availability');
R.updatePlayer(roster, id('Dan Marinescu'), { remove: true });
eq(roster.teams.length, 0, 'removing a player removes their pairs');
eq(roster.players.length, 8, 'player removed from the pool');

const p2 = R.makePair(roster, [id('Paul Stan'), id('Cristi Lupu')]);
assert(R.removePair(roster, p2.id) && !R.removePair(roster, p2.id), 'removePair');

// ---- county check (eligibility hint) ----
eq(R.countyInRegion('Brașov', 'C'), true, 'Brașov is in Centru');
eq(R.countyInRegion('Brasov', 'C'), true, 'without diacritics');
eq(R.countyInRegion('Județul Cluj', 'NV'), true, 'county with a prefix');
eq(R.countyInRegion('Cluj', 'C'), false, 'Cluj is not in Centru');
eq(R.countyInRegion('Sector 3', 'BI'), true, 'Bucharest sector');
eq(R.countyInRegion('Municipiul București', 'BI'), true, 'Bucharest');
eq(R.countyInRegion('Ilfov', 'BI'), false, 'Ilfov is not in the Bucharest region');
eq(R.countyInRegion('Ilfov', 'SM'), true, 'Ilfov is in Sud-Muntenia');
eq(R.regionById(R.newRegionalRoster('x'), 'BI').name, 'București', 'Bucharest region on its own');

// an event started with the old "București-Ilfov" region is renamed (only when never edited)
const old = R.newRegionalRoster('x');
Object.assign(R.regionById(old, 'BI'), { name: 'București-Ilfov', short: 'BIF' });
R.addPlayers(old, 'BI', R.parsePlayerLines('Ana One\nAna Two', 'F').players);
const oldPair = R.makePair(old, old.players.map((p) => p.id));
R.migrateRoster(old);
eq([R.regionById(old, 'BI').name, R.regionById(old, 'BI').short, oldPair.division], ['București', 'BUC', 'București'], 'old region renamed, pairs follow');
const edited = R.newRegionalRoster('x');
Object.assign(R.regionById(edited, 'BI'), { name: 'Capitala', short: 'CAP' });
R.migrateRoster(edited);
eq(R.regionById(edited, 'BI').name, 'Capitala', 'an edited name is kept');
eq(R.countyInRegion('Dolj', 'SV'), true, 'Dolj in Sud-Vest');
eq(R.countyInRegion('Dolj', 'SM'), false, 'Dolj not in Sud-Muntenia');
eq(R.countyInRegion('', 'C'), null, 'no county: unknown');
eq(R.nameFromSlug('/andrei-ene-9z'), 'Andrei Ene', 'name from slug');

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed ? 1 : 0);

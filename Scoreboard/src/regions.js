'use strict';

/*
 * Regional event (e.g. "Echipa Națională 2027 — Etapa I"): the roster is a
 * pool of players per region and gender, and the pairs that play are built
 * from that pool (and can be rebuilt before every game).
 *
 * roster.json with format "regions":
 *   regions: [{ id, name, short, color }]
 *   players: [{ id, name, gender: 'M'|'F', region, country, profile?, available, nameFromLink? }]
 *   teams:   [{ id, format: 'regions', category, division, section, position, active,
 *               region, gender, playerIds: [a, b], players: [{ name, country, profile?, playerId }] }]
 *
 * `teams` keeps the same shape as an imported padeltour.ro roster (a pair with
 * two players), so the scoring, pickers, profile cards and overlays work on
 * it unchanged. The pairs' `players` are copies of the pool entries, kept in
 * sync by syncPairs() after every change to the pool.
 *
 * Everything here is pure (no I/O): server.js saves the roster.
 */

/**
 * The federation's 8 regions, with their counties (for the eligibility hint).
 * Unlike the statistical development regions, Bucharest is a region on its own
 * and Ilfov belongs to Sud-Muntenia.
 */
const DEFAULT_REGIONS = [
  { id: 'NE', name: 'Nord-Est', short: 'NE', color: '#E63946', counties: ['Bacău', 'Botoșani', 'Iași', 'Neamț', 'Suceava', 'Vaslui'] },
  { id: 'SE', name: 'Sud-Est', short: 'SE', color: '#00B4D8', counties: ['Brăila', 'Buzău', 'Constanța', 'Galați', 'Tulcea', 'Vrancea'] },
  { id: 'SM', name: 'Sud-Muntenia', short: 'SM', color: '#F4A261', counties: ['Argeș', 'Călărași', 'Dâmbovița', 'Giurgiu', 'Ialomița', 'Ilfov', 'Prahova', 'Teleorman'] },
  { id: 'SV', name: 'Sud-Vest Oltenia', short: 'SVO', color: '#9B5DE5', counties: ['Dolj', 'Gorj', 'Mehedinți', 'Olt', 'Vâlcea'] },
  { id: 'V', name: 'Vest', short: 'VEST', color: '#2A9D8F', counties: ['Arad', 'Caraș-Severin', 'Hunedoara', 'Timiș'] },
  { id: 'NV', name: 'Nord-Vest', short: 'NV', color: '#90BE6D', counties: ['Bihor', 'Bistrița-Năsăud', 'Cluj', 'Maramureș', 'Satu Mare', 'Sălaj'] },
  { id: 'C', name: 'Centru', short: 'CEN', color: '#F9C74F', counties: ['Alba', 'Brașov', 'Covasna', 'Harghita', 'Mureș', 'Sibiu'] },
  { id: 'BI', name: 'București', short: 'BUC', color: '#F15BB5', counties: ['București'] },
];

/** Events started before the fix had "București-Ilfov" / BIF: rename it when it was never edited. */
function migrateRoster(roster) {
  const b = regionById(roster, 'BI');
  if (b && b.name === 'București-Ilfov' && b.short === 'BIF') {
    b.name = 'București';
    b.short = 'BUC';
    syncPairs(roster);
  }
  return roster;
}

const GENDERS = { M: { category: 'men', label: 'Masculin' }, F: { category: 'women', label: 'Feminin' } };

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isRegional(roster) {
  return !!roster && roster.format === 'regions';
}

/** A fresh regional roster (no players yet) with the 8 default regions. */
function newRegionalRoster(name) {
  const tournament = String(name || '').trim() || 'Regional event';
  return {
    format: 'regions',
    tournament,
    shortName: tournament.split(/\s+[—–]\s+/)[0].trim(),
    source: { kind: 'regional', createdAt: new Date().toISOString() },
    regions: DEFAULT_REGIONS.map((r) => ({ id: r.id, name: r.name, short: r.short, color: r.color })),
    players: [],
    teams: [],
  };
}

function regionById(roster, id) {
  return ((roster && roster.regions) || []).find((r) => r.id === id) || null;
}

/** What the scorebug needs about a region (null when the roster is not regional). */
function regionBadge(roster, id) {
  const r = regionById(roster, id);
  return r ? { id: r.id, name: r.name, short: r.short || r.name.slice(0, 3).toUpperCase(), color: r.color || '' } : null;
}

/**
 * Whether a profile's county ("Județ" on padeltour.ro) lies in the region:
 * true / false, or null when it cannot be told (no county, renamed region).
 */
function countyInRegion(county, regionId) {
  const c = norm(county);
  if (!c) return null;
  const def = DEFAULT_REGIONS.find((r) => r.id === regionId);
  if (!def) return null;
  if (regionId === 'BI' && /\b(bucuresti|sector \d)\b/.test(c)) return true;
  return def.counties.some((name) => {
    const n = norm(name);
    return (' ' + c + ' ').includes(' ' + n + ' '); // "Județul Brașov" matches Brașov; "Olt" never matches "Dolj"
  });
}

const URL_RE = /(?:https?:\/\/)?(?:www\.)?padeltour\.ro\/[a-z0-9][a-z0-9-]{0,80}\/?/i;
const GENDER_TOKEN = {
  m: 'M', masculin: 'M', male: 'M', men: 'M', man: 'M', b: 'M', barbat: 'M', baieti: 'M',
  f: 'F', feminin: 'F', female: 'F', women: 'F', woman: 'F', femeie: 'F', fete: 'F',
};

/** "ion-popescu-1a2b" -> "Ion Popescu" (a name to show until the profile is read). */
function nameFromSlug(slug) {
  return String(slug || '')
    .replace(/^\//, '')
    .split('-')
    .filter((w) => w && !/\d/.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Pasted players, one per line, in any order of: name, M/F, a 2-3 letter
 * country code, a padeltour.ro profile link — separated by tabs, commas,
 * semicolons or "|" (a link may also just follow the name). Leading "1." /
 * "1)" numbers are dropped. Returns { players: [{ name, gender, country, profile, nameFromLink }], skipped: [line] }.
 */
function parsePlayerLines(text, defaultGender) {
  const players = [];
  const skipped = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let profile = '';
    const m = line.match(URL_RE);
    if (m) {
      profile = '/' + m[0].replace(/^(?:https?:\/\/)?(?:www\.)?padeltour\.ro\//i, '').replace(/\/$/, '').toLowerCase();
      line = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).trim();
    }
    line = line.replace(/^\d+\s*[.)]\s*/, '');
    let gender = '';
    let country = '';
    const nameParts = [];
    for (const tok of line.split(/[\t,;|]+/).map((t) => t.trim()).filter(Boolean)) {
      const g = GENDER_TOKEN[norm(tok)];
      if (g && !gender) gender = g;
      else if (/^[A-Z]{2,3}$/.test(tok) && !country) country = tok;
      else nameParts.push(tok);
    }
    let name = nameParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    let nameFromLink = false;
    if (!name && profile) {
      name = nameFromSlug(profile);
      nameFromLink = true;
    }
    if (!name) {
      skipped.push(raw.trim());
      continue;
    }
    players.push({ name, gender: gender || defaultGender || '', country: country || 'RO', profile, nameFromLink });
  }
  return { players, skipped };
}

function newId(prefix, taken) {
  let id;
  do id = prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
  while (taken.has(id));
  return id;
}

/**
 * Adds parsed players to a region. A player already in the pool (same name, or
 * same profile link) is skipped. Returns { added, duplicates: [name], noGender: [name] }.
 */
function addPlayers(roster, regionId, list) {
  if (!regionById(roster, regionId)) throw new Error('unknown region');
  roster.players = roster.players || [];
  const ids = new Set(roster.players.map((p) => p.id));
  const out = { added: 0, duplicates: [], noGender: [] };
  for (const p of list) {
    if (!GENDERS[p.gender]) {
      out.noGender.push(p.name);
      continue;
    }
    const dup = roster.players.find((q) => norm(q.name) === norm(p.name) || (p.profile && q.profile === p.profile));
    if (dup) {
      out.duplicates.push(p.name);
      continue;
    }
    const id = newId('P', ids);
    ids.add(id);
    roster.players.push({
      id,
      name: p.name,
      gender: p.gender,
      region: regionId,
      country: p.country || 'RO',
      ...(p.profile ? { profile: p.profile } : {}),
      ...(p.nameFromLink ? { nameFromLink: true } : {}),
      available: true,
    });
    out.added++;
  }
  return out;
}

/** Changes a pool player (name, country, profile, available, region, gender) or removes it (patch.remove). */
function updatePlayer(roster, id, patch) {
  const players = roster.players || [];
  const p = players.find((q) => q.id === id);
  if (!p) throw new Error('unknown player');
  if (patch.remove) {
    roster.players = players.filter((q) => q !== p);
    roster.teams = (roster.teams || []).filter((t) => !(t.playerIds || []).includes(id));
    return;
  }
  if (typeof patch.name === 'string') {
    const name = patch.name.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (name) {
      p.name = name;
      delete p.nameFromLink;
    }
  }
  if (typeof patch.country === 'string' && /^[A-Za-z]{2,3}$/.test(patch.country.trim())) p.country = patch.country.trim().toUpperCase();
  if (typeof patch.profile === 'string') {
    if (patch.profile) p.profile = patch.profile;
    else delete p.profile;
  }
  if (typeof patch.available === 'boolean') p.available = patch.available;
  const moved = (patch.region && patch.region !== p.region && regionById(roster, patch.region)) || (GENDERS[patch.gender] && patch.gender !== p.gender);
  if (moved) {
    if (patch.region && regionById(roster, patch.region)) p.region = patch.region;
    if (GENDERS[patch.gender]) p.gender = patch.gender;
    // a pair must be two players of one region and gender
    roster.teams = (roster.teams || []).filter((t) => !(t.playerIds || []).includes(id));
  }
  syncPairs(roster);
}

/** Copies the pool data (name, country, profile) and the region name into every pair. */
function syncPairs(roster) {
  const byId = new Map((roster.players || []).map((p) => [p.id, p]));
  roster.teams = (roster.teams || []).filter((t) => (t.playerIds || []).every((id) => byId.has(id)));
  for (const t of roster.teams) {
    const region = regionById(roster, t.region);
    t.division = region ? region.name : t.region;
    t.players = t.playerIds.map((id) => {
      const p = byId.get(id);
      return { name: p.name, country: p.country || '', ...(p.profile ? { profile: p.profile } : {}), playerId: p.id };
    });
  }
}

/**
 * The pair of these two players (same region and gender): the existing one, or a new one.
 * Returns the pair record.
 */
function makePair(roster, playerIds) {
  const ids = (playerIds || []).filter(Boolean);
  if (ids.length !== 2 || ids[0] === ids[1]) throw new Error('pick two different players');
  const ps = ids.map((id) => (roster.players || []).find((p) => p.id === id));
  if (ps.some((p) => !p)) throw new Error('unknown player');
  if (ps[0].region !== ps[1].region) throw new Error('both players must be from the same region');
  if (ps[0].gender !== ps[1].gender) throw new Error('both players must be men or both women');
  roster.teams = roster.teams || [];
  const key = [...ids].sort().join('+');
  const existing = roster.teams.find((t) => [...(t.playerIds || [])].sort().join('+') === key);
  if (existing) return existing;
  const region = ps[0].region;
  const gender = ps[0].gender;
  const same = roster.teams.filter((t) => t.region === region && t.gender === gender);
  const position = same.reduce((n, t) => Math.max(n, t.position || 0), 0) + 1;
  let id = `${region}-${gender}-${String(position).padStart(2, '0')}`;
  for (let n = 2; roster.teams.some((t) => t.id === id); n++) id = `${region}-${gender}-${String(position).padStart(2, '0')}-${n}`;
  const team = {
    id,
    format: 'regions',
    category: GENDERS[gender].category,
    division: '',
    section: 'main_draw',
    position,
    seed: null,
    wildcard: false,
    active: true,
    teamPoints: null,
    region,
    gender,
    playerIds: ids,
    players: [],
  };
  roster.teams.push(team);
  syncPairs(roster);
  return team;
}

function removePair(roster, teamId) {
  const before = (roster.teams || []).length;
  roster.teams = (roster.teams || []).filter((t) => t.id !== teamId);
  return roster.teams.length !== before;
}

/** Renames / recolours regions (ids stay). Each entry: { id, name?, short?, color? }. */
function updateRegions(roster, list) {
  for (const patch of list || []) {
    const r = regionById(roster, patch && patch.id);
    if (!r) continue;
    const name = String(patch.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const short = String(patch.short || '').replace(/\s+/g, '').trim().toUpperCase().slice(0, 5);
    if (name) r.name = name;
    if (short) r.short = short;
    if (/^#[0-9a-f]{6}$/i.test(String(patch.color || ''))) r.color = patch.color.toUpperCase();
  }
  syncPairs(roster);
}

module.exports = {
  DEFAULT_REGIONS,
  GENDERS,
  isRegional,
  newRegionalRoster,
  migrateRoster,
  regionById,
  regionBadge,
  countyInRegion,
  nameFromSlug,
  parsePlayerLines,
  addPlayers,
  updatePlayer,
  syncPairs,
  makePair,
  removePair,
  updateRegions,
};

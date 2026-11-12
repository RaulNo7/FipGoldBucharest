/* Country-code helpers shared by the overlay / mobile / admin / teams pages.
   Country codes are either ISO-3166 alpha-2 ("RO", as padeltour.ro imports
   them) or the FIP/IOC 3-letter codes of the older entry lists ("ROU").
   Flag files are alpha-2 SVGs bundled at /flags/{iso2}.svg (works offline in OBS). */
(function (global) {
  'use strict';

  var ISO3_TO_ISO2 = {
    ALG: 'dz', ARG: 'ar', AUT: 'at', BRA: 'br', COD: 'cd', CRO: 'hr',
    CZE: 'cz', DEN: 'dk', ESP: 'es', FIN: 'fi', FRA: 'fr', GBR: 'gb',
    GER: 'de', GRE: 'gr', ITA: 'it', MDA: 'md', MEX: 'mx', NED: 'nl',
    OMA: 'om', PAR: 'py', POL: 'pl', POR: 'pt', QAT: 'qa', ROU: 'ro',
    SLO: 'si', SVK: 'sk', SWE: 'se', UAE: 'ae', UKR: 'ua', USA: 'us',
  };

  function flagUrl(code) {
    var c = String(code || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) return '/flags/' + c.toLowerCase() + '.svg';
    var iso2 = ISO3_TO_ISO2[c];
    return iso2 ? '/flags/' + iso2 + '.svg' : null;
  }

  /**
   * Groups of the roster for the Teams page and the match pickers, in order.
   * Imported pairs carry a `division` ("Masculin 1") and a section
   * ("main_draw" = accepted, "waiting_list"); the older entry-list pairs only
   * have category men/women + section main_draw/qualifying.
   * Returns [{ card, label, teams }] - `card` is the Teams-page card title.
   */
  function rosterGroups(teams) {
    var groups = [];
    var byKey = {};
    var SECTION_LABEL = { main_draw: 'Main draw', qualifying: 'Qualifying', waiting_list: 'Waiting list' };
    var CATEGORY_LABEL = { men: 'Men', women: 'Women', mixed: 'Mixed' };
    // Cards appear in the order the roster lists them (the import writes one
    // division after another; the old entry list is men first, then women).
    (teams || []).forEach(function (t) {
      var card = t.division || CATEGORY_LABEL[t.category] || 'Teams';
      var section = t.section || 'main_draw';
      var key = card + '|' + section;
      if (!byKey[key]) {
        var sectionLabel = SECTION_LABEL[section] || section;
        byKey[key] = {
          card: card,
          section: section,
          sectionLabel: sectionLabel,
          label: t.division ? (section === 'main_draw' ? card : card + ' — ' + sectionLabel) : card + ' — ' + sectionLabel,
          teams: [],
        };
        groups.push(byKey[key]);
      }
      byKey[key].teams.push(t);
    });
    // Accepted before waiting list inside each card; cards keep their first-seen order.
    var cardOrder = [];
    groups.forEach(function (g) {
      if (cardOrder.indexOf(g.card) < 0) cardOrder.push(g.card);
    });
    var SECTION_ORDER = { main_draw: 0, qualifying: 1, waiting_list: 2 };
    groups.sort(function (a, b) {
      var c = cardOrder.indexOf(a.card) - cardOrder.indexOf(b.card);
      return c || (SECTION_ORDER[a.section] || 0) - (SECTION_ORDER[b.section] || 0);
    });
    groups.forEach(function (g) {
      g.teams.sort(function (a, b) {
        return (a.position || 0) - (b.position || 0);
      });
    });
    return groups;
  }

  /** "Enzo Jensen Sirvent" -> "E. Jensen Sirvent" (first-name initial + surname block). */
  function shortName(full) {
    var parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || '';
    return parts[0][0] + '. ' + parts.slice(1).join(' ');
  }

  /** Player entry from state ({name,country} object, or a legacy plain string). */
  function playerName(p) {
    if (!p) return '';
    return typeof p === 'string' ? p : p.name || '';
  }

  function playerCountry(p) {
    return p && typeof p === 'object' ? p.country || '' : '';
  }

  global.PadelCountries = {
    ISO3_TO_ISO2: ISO3_TO_ISO2,
    flagUrl: flagUrl,
    rosterGroups: rosterGroups,
    shortName: shortName,
    playerName: playerName,
    playerCountry: playerCountry,
  };
})(window);

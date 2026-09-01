/* Country-code helpers shared by the overlay / mobile / admin / teams pages.
   The FIP entry lists print FIP/IOC 3-letter codes; flag files are ISO-3166
   alpha-2 SVGs bundled at /flags/{iso2}.svg (works offline in OBS). */
(function (global) {
  'use strict';

  var ISO3_TO_ISO2 = {
    ALG: 'dz', ARG: 'ar', AUT: 'at', BRA: 'br', COD: 'cd', CRO: 'hr',
    CZE: 'cz', DEN: 'dk', ESP: 'es', FIN: 'fi', FRA: 'fr', GBR: 'gb',
    GER: 'de', GRE: 'gr', ITA: 'it', MDA: 'md', MEX: 'mx', NED: 'nl',
    OMA: 'om', PAR: 'py', POL: 'pl', POR: 'pt', QAT: 'qa', ROU: 'ro',
    SLO: 'si', SVK: 'sk', SWE: 'se', UAE: 'ae', UKR: 'ua', USA: 'us',
  };

  function flagUrl(iso3) {
    var iso2 = ISO3_TO_ISO2[String(iso3 || '').toUpperCase()];
    return iso2 ? '/flags/' + iso2 + '.svg' : null;
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
    shortName: shortName,
    playerName: playerName,
    playerCountry: playerCountry,
  };
})(window);

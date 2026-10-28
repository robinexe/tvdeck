/*
 * Sorts installed apps into rows by name, falling back to the categories
 * Tizen reports for the app. Rules are checked in order, so "YouTube Music"
 * lands in Music before the Video rule sees "YouTube".
 */
var Categories = (function () {
  'use strict';

  var ORDER = ['Streaming', 'Video', 'Music', 'Sports', 'Kids', 'Games', 'News', 'Lifestyle', 'Utilities', 'Other'];

  // Row titles in Portuguese; rule keys stay in English (stored in settings).
  var LABELS = {
    Streaming: 'Streaming', Video: 'Vídeo', Music: 'Música', Sports: 'Esportes', Kids: 'Infantil',
    Games: 'Jogos', News: 'Notícias', Lifestyle: 'Estilo de vida', Utilities: 'Utilitários', Other: 'Outros'
  };

  function label(name) { return LABELS[name] || name; }

  var RULES = [
    ['Music', /spotify|deezer|anghami|tidal|apple music|youtube music|soundcloud|amazon music|tunein|radio|iheart|pandora|napster|qobuz|audible|podcast/i],
    ['Kids', /youtubekids|youtube kids|gloob|discovery kids|kids|junior|cartoon|nick|baby|disney ?jr|pbs/i],
    ['Sports', /dazn|cazé|caze|sportv|bein|espn|nba|nfl|nhl|mlb|formula|\bf1\b|uefa|fifa|sky sports|eurosport|fubo|ssc|sport|golf|tennis|ufc|wwe/i],
    ['Games', /game|xbox|geforce|steam|luna|blacknut|antstream|playstation|utomik|boosteroid|arcade/i],
    ['News', /news|cnn|bbc|al ?jazeera|france ?24|euronews|bloomberg|cnbc|reuters|dw\b|sharq|\u0627\u0644\u0634\u0631\u0642/i],
    ['Streaming', /netflix|prime video|amazon|disney|hulu|hbo|\bmax\b|apple tv|paramount|peacock|starz|showtime|plex|jellyfin|emby|stremio|kodi|shahid|osn|crunchyroll|mubi|rakuten|viu|watch ?it|canal|molotov|pluto|tubi|tv plus|filmin|tod\b|mbc|stc tv|yango|discovery|tf1|iptv|smarters|globoplay|mercado ?play|telecine|vix|sbt|record|band\b|claro|sky\b|premiere|looke|univer|starplus|star\+/i],
    ['Video', /youtube|tizentube|twitch|vimeo|dailymotion|tiktok|facebook|kick\b|ted\b/i],
    ['Lifestyle', /fitness|yoga|peloton|workout|cook|recipe|travel|calm|headspace|meditat|art store|ambient/i],
    ['Utilities', /internet|browser|smartthings|store|^apps$|settings|gallery|media|usb|e-manual|manual|help|guide|bixby|alexa|assistant|mirror|remote|file|camera|health|weather|workspace|office|zoom|teams|security/i]
  ];

  // Tizen ApplicationInformation.categories are URIs or plain words.
  var TIZEN_HINTS = [
    ['Games', /game/i],
    ['Music', /music|audio/i],
    ['Video', /video/i],
    ['News', /news/i],
    ['Kids', /kid/i]
  ];

  function categorize(app) {
    var name = app.name || '';
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][1].test(name)) return RULES[i][0];
    }
    var hints = (app.categories || []).join(' ');
    for (var j = 0; j < TIZEN_HINTS.length; j++) {
      if (TIZEN_HINTS[j][1].test(hints)) return TIZEN_HINTS[j][0];
    }
    return 'Other';
  }

  // Returns [{ name, apps }] in display order, skipping empty groups.
  function group(apps) {
    var buckets = {};
    apps.forEach(function (app) {
      var cat = categorize(app);
      (buckets[cat] = buckets[cat] || []).push(app);
    });
    return ORDER.filter(function (name) { return buckets[name]; }).map(function (name) {
      return { name: name, apps: buckets[name] };
    });
  }

  return { categorize: categorize, group: group, label: label };
})();

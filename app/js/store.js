/*
 * Persistent launcher settings and layout, kept in localStorage.
 * localStorage on the TV is scoped to the TizenBrew origin (127.0.0.1:8081),
 * so it survives restarts but is shared with other modules served from it.
 */
var Store = (function () {
  'use strict';

  var KEY = 'tvdeck:v1';

  var DEFAULTS = {
    favorites: [],          // item keys, e.g. "app:3201907018807", "mod:npm/foo", "web:0"
    hiddenApps: [],         // app ids
    recent: [],             // item keys, most recent first
    openedAt: {},           // item key -> last opened (ms), for the shelf
    appsCache: null,        // last app list, so the home screen draws instantly
    sounds: true,           // synthesized UI sounds
    soundStyle: 'soft',     // soft | glass | wood
    showRecent: true,
    groupApps: true,        // one row per app category
    ambient: true,          // ambient screen after a few idle minutes
    webLinks: [
      { name: 'g1', url: 'https://g1.globo.com' },
      { name: 'Climatempo', url: 'https://www.climatempo.com.br' }
    ],
    city: 'Arraial do Cabo',
    userName: 'Matheus',
    use24h: true,
    showWeather: true
  };

  var state = load();

  function load() {
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) { /* storage unavailable or corrupt */ }
    // Settings saved by the original English TVDeck: swap its sample city and
    // sample links for this build's defaults.
    if (saved.city === 'Tunis') delete saved.city;
    if (saved.webLinks && saved.webLinks.length === 2 && /wikipedia/.test(saved.webLinks[0].url) &&
        /ycombinator/.test(saved.webLinks[1].url)) delete saved.webLinks;
    var merged = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      merged[k] = saved.hasOwnProperty(k) ? saved[k] : JSON.parse(JSON.stringify(DEFAULTS[k]));
    });
    return merged;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { /* storage unavailable */ }
  }

  function get(key) { return state[key]; }

  function set(key, value) {
    state[key] = value;
    save();
  }

  function toggleIn(key, value) {
    var list = state[key].slice();
    var i = list.indexOf(value);
    if (i === -1) list.push(value); else list.splice(i, 1);
    set(key, list);
    return i === -1;
  }

  function reset() {
    state = JSON.parse(JSON.stringify(DEFAULTS));
    save();
  }

  return { get: get, set: set, toggleIn: toggleIn, reset: reset };
})();

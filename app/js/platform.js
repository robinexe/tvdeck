/*
 * Platform layer: talks to the TV through the TVDeck service and TizenBrew.
 * Falls back to mock data when opened in a desktop browser, so the UI can be
 * developed without a TV.
 *
 * TizenBrew serves modules over http, and the TV does not expose the `tizen`
 * API to such pages. So on the TV, app listing, launching, links and exit go
 * through the TVDeck service (service/service.js), which does have `tizen`.
 * Direct `tizen` calls are kept for when it is present.
 *
 * Keep to ES5 (older Tizen engines): no optional chaining, no `??`.
 */
var Platform = (function () {
  'use strict';

  var HAS_TIZEN = typeof tizen !== 'undefined' && !!tizen.application;
  var IS_TV = HAS_TIZEN || /Tizen|SMART-TV/i.test(navigator.userAgent);
  var SELF_PACKAGE = 'tvdeck';
  var TB_SOCKET = 'ws://localhost:8081';
  var TB_EVENTS = { GetModules: 4, LaunchModule: 5, ModuleAction: 10 };

  // A Samsung TV reports ~370 apps, mostly system components. Store apps
  // have ids like "IkWsFHtOY9.Stremio" (10-character package + name); the
  // few built-ins people actually open are listed by id.
  var STORE_APP_ID = /^[A-Za-z0-9]{10}\.[A-Za-z0-9_-]+$/;
  var BUILT_IN_APPS = {
    'org.tizen.netflix-app': true,
    'com.samsung.tv.cobalt-yt': true,       // YouTube on 2021+ Samsung TVs (Cobalt), reported with show=false
    'org.tizen.primevideo': true,
    'org.tizen.browser': true,
    'com.samsung.tv.store': true,
    'com.samsung.tv.gallery': true
  };
  var NEVER_SHOW = { 'xvvl3S1bvH.TizenBrewStandalone': true }; // TizenBrew itself

  // Desktop-only stand-ins for app artwork so the UI can be judged off the TV.
  function mockArt(bg, fg, text, size) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240">' +
      '<rect width="400" height="240" fill="' + bg + '"/>' +
      '<text x="200" y="138" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" ' +
      'font-weight="700" font-size="' + (size || 44) + '" fill="' + fg + '">' + text + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var MOCK_APPS = [
    { id: '3201907018807', name: 'Netflix', icon: mockArt('#000', '#e50914', 'NETFLIX', 52) },
    { id: '111299001912', name: 'YouTube', icon: mockArt('#fff', '#ff0000', 'YouTube') },
    { id: '3201910019365', name: 'Prime Video', icon: mockArt('#0f171e', '#00a8e1', 'prime video') },
    { id: '3201901017640', name: 'Disney+', icon: mockArt('#0b1a4a', '#fff', 'Disney+', 50) },
    { id: '3201606009684', name: 'Spotify', icon: mockArt('#1db954', '#000', 'Spotify') },
    { id: '3202010022079', name: 'Stremio', icon: mockArt('#2a1a5e', '#fff', 'Stremio') },
    { id: '3201807016597', name: 'Apple TV', icon: mockArt('#1c1c1e', '#fff', 'tv', 64) },
    { id: 'com.samsung.tv.store', name: 'Apps' },
    { id: 'org.tizen.browser', name: 'Internet' },
    { id: 'mock.anghami', name: 'Anghami', icon: mockArt('#7c1fd1', '#fff', 'anghami') },
    { id: 'mock.dazn', name: 'DAZN', icon: mockArt('#0c161c', '#f8fc00', 'DAZN', 64) },
    { id: 'mock.bein', name: 'beIN SPORTS', icon: mockArt('#5c2d91', '#fff', 'beIN', 60) },
    { id: 'mock.twitch', name: 'Twitch', icon: mockArt('#9146ff', '#fff', 'twitch') },
    { id: 'mock.geforce', name: 'GeForce NOW', icon: mockArt('#111', '#76b900', 'GEFORCE NOW', 34) },
    { id: 'mock.aljazeera', name: 'Al Jazeera', icon: mockArt('#fff', '#c48a1f', 'Al Jazeera', 40) },
    { id: 'mock.smartthings', name: 'SmartThings' },
    { id: 'mock.gallery', name: 'Gallery' }
  ];

  var MOCK_MODULES = [
    { fullName: 'npm/@foxreis/tizentube', appName: 'TizenTube', appPath: '#', keys: [], packageType: 'mods' },
    { fullName: 'npm/@gforceweb/smarttv-twitch-hls', appName: 'Twitch', appPath: '#', keys: [], packageType: 'app' }
  ];

  function isUserApp(info) {
    if (NEVER_SHOW[info.id]) return false;
    if (BUILT_IN_APPS[info.id]) return true;  // listed on purpose, even when Tizen hides it
    if (info.show === false) return false;
    return STORE_APP_ID.test(info.id);
  }

  // "Spotify - Music and Podcasts" -> "Spotify", "TF1+ : Streaming…" -> "TF1+"
  function shortName(name) {
    if (/^youtube$/i.test(name)) return 'YouTube';
    return name.split(/\s+[-:\u2013|]\s+/)[0].trim();
  }

  var appsError = null;   // why the app list is empty on the TV, if it is

  function tidyApps(infos) {
    return infos
      .filter(function (info) { return info.name && isUserApp(info); })
      .map(function (info) {
        return { id: info.id, name: shortName(info.name), icon: info.iconPath || info.icon || '', categories: info.categories || [] };
      })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function listApps() {
    if (!IS_TV) return Promise.resolve(MOCK_APPS.slice());
    if (HAS_TIZEN) {
      return new Promise(function (resolve) {
        tizen.application.getAppsInfo(function (infos) { appsError = null; resolve(tidyApps(infos)); },
          function () { resolve([]); });
      });
    }
    return service('/api/apps').then(function (res) {
      appsError = null;
      return tidyApps(res.apps);
    }, function () {
      appsError = 'service';
      return [];
    });
  }

  // Some built-ins answer to another id than the one getAppsInfo reports:
  // try these in order when the first launch is refused.
  var LAUNCH_FALLBACKS = {
    'com.samsung.tv.cobalt-yt': ['111299001912', '9Ur5IzDKqV.TizenYouTube']
  };

  function launchApp(id) {
    var rest = LAUNCH_FALLBACKS[id] || [];
    return launchOne(id).catch(function retry(err) {
      if (!rest.length) throw err;
      return launchOne(rest.shift()).catch(retry);
    });
  }

  function launchOne(id) {
    if (!IS_TV) {
      console.log('[mock] launch app', id);
      return Promise.resolve();
    }
    if (HAS_TIZEN) {
      return new Promise(function (resolve, reject) {
        tizen.application.launch(id, resolve, reject);
      });
    }
    return service('/api/launch', { id: id });
  }

  // TizenBrew's service answers GetModules with null until it has fetched
  // every module's package.json, so retry until we get a list.
  function listModules() {
    if (!IS_TV) return Promise.resolve(MOCK_MODULES.slice());
    return new Promise(function (resolve) {
      var socket;
      var settled = false;
      function finish(modules) {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (e) { /* already closed */ }
        resolve(modules);
      }
      try {
        socket = new WebSocket(TB_SOCKET);
      } catch (e) {
        return resolve([]);
      }
      socket.onopen = function () {
        socket.send(JSON.stringify({ type: TB_EVENTS.GetModules }));
      };
      socket.onmessage = function (event) {
        var data = JSON.parse(event.data);
        if (data.type !== TB_EVENTS.GetModules) return;
        if (data.payload === null) {
          setTimeout(function () {
            if (!settled) socket.send(JSON.stringify({ type: TB_EVENTS.GetModules }));
          }, 500);
          return;
        }
        finish(data.payload.filter(function (mod) {
          return mod.appPath && mod.fullName.indexOf(SELF_PACKAGE) === -1;
        }));
      };
      socket.onerror = function () { finish([]); };
      setTimeout(function () { finish([]); }, 8000);
    });
  }

  // Mirrors TizenBrew's own Modules.jsx launch flow.
  function launchModule(mod) {
    if (!IS_TV) {
      console.log('[mock] launch module', mod.fullName);
      return;
    }
    registerKeys(mod.keys || []);
    var socket = new WebSocket(TB_SOCKET);
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: TB_EVENTS.LaunchModule, payload: mod }));
      if (!mod.evaluateScriptOnDocumentStart) location.href = mod.appPath;
    };
  }

  function openUrl(url) {
    location.href = url;
  }

  // Opens a URL in the TV's own browser app.
  function openInBrowser(url) {
    if (!IS_TV) {
      window.open(url, '_blank');
      return Promise.resolve();
    }
    if (HAS_TIZEN) {
      return new Promise(function (resolve, reject) {
        var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
        tizen.application.launchAppControl(control, 'org.tizen.browser', resolve, reject);
      });
    }
    return service('/api/open', { url: url });
  }

  /* ---------- TVDeck service (service/service.js) ---------- */

  var SERVICE = 'http://127.0.0.1:8085';
  var serviceUp = false;

  function service(path, body) {
    var options = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoids a CORS preflight
      body: JSON.stringify(body)
    };
    return fetch(SERVICE + path, options).then(function (res) {
      serviceUp = true;
      return res.json().then(function (json) {
        if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
        return json;
      });
    }, function (err) {
      serviceUp = false;
      throw err;
    });
  }

  function sendKey(key) {
    return service('/api/key', { key: key });
  }

  function iconUrl(path) {
    if (!path) return '';
    if (path.indexOf('/') !== 0) return path;
    // On the TV, icons can only be read by the service (file:// is blocked).
    return IS_TV || serviceUp ? SERVICE + '/api/icon?path=' + encodeURIComponent(path) : 'file://' + path;
  }

  /* ---------- TizenBrew auto-launch ---------- */

  // e.g. "npm/tvdeck" or "gh/user/tvdeck", from /module/<encoded name>/app/index.html
  function selfModuleName() {
    var match = /\/module\/([^/]+)\//.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : 'npm/' + SELF_PACKAGE;
  }

  function tizenbrewAction(action, module) {
    if (!IS_TV) {
      console.log('[mock] TizenBrew', action, module);
      return;
    }
    var socket = new WebSocket(TB_SOCKET);
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: TB_EVENTS.ModuleAction, payload: { action: action, module: module } }));
      setTimeout(function () { socket.close(); }, 500);
    };
  }

  function setAutoLaunch(enabled) {
    tizenbrewAction('autolaunch', enabled ? selfModuleName() : '');
  }

  // TizenBrew matches services by module name without the "npm/" prefix,
  // and the action replaces the whole list.
  function setServiceAutoLaunch(enabled, currentList) {
    var name = serviceModuleName();
    var list = (currentList || []).filter(function (n) { return n !== name; });
    if (enabled) list.push(name);
    tizenbrewAction('autolaunchService', list);
  }

  function serviceModuleName() {
    var self = selfModuleName();
    return self.slice(self.indexOf('/') + 1);
  }

  // Only possible with the tizen API. TizenBrew registers the keys listed in
  // package.json before it opens the module, so the page still gets them.
  function registerKeys(keys) {
    if (!HAS_TIZEN || !tizen.tvinputdevice) return;
    keys.forEach(function (key) {
      try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* unsupported key */ }
    });
  }

  // Closes TVDeck (and TizenBrew) and returns to what the TV was showing.
  // window.close() works from the module page, tested on a Tizen 6 TV; the
  // service's Home key is only a fallback in case the window stays open.
  function exit() {
    if (HAS_TIZEN) {
      tizen.application.getCurrentApplication().exit();
      return Promise.resolve();
    }
    if (!IS_TV) return Promise.resolve();
    window.close();
    return new Promise(function (resolve) { setTimeout(resolve, 600); }).then(function () {
      return service('/api/exit', {});
    });
  }

  return {
    isTV: IS_TV,
    appsError: function () { return appsError; },
    listApps: listApps,
    launchApp: launchApp,
    listModules: listModules,
    launchModule: launchModule,
    openUrl: openUrl,
    openInBrowser: openInBrowser,
    service: service,
    sendKey: sendKey,
    iconUrl: iconUrl,
    setAutoLaunch: setAutoLaunch,
    setServiceAutoLaunch: setServiceAutoLaunch,
    selfModuleName: selfModuleName,
    serviceModuleName: serviceModuleName,
    registerKeys: registerKeys,
    exit: exit
  };
})();

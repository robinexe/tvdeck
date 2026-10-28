/*
 * TVDeck background service.
 *
 * TizenBrew runs this file with Node.js inside a vm sandbox on the TV. Its
 * runtime is bundled, so only Node built-ins can be required (no node-fetch,
 * no ws): this file brings its own small HTTP and WebSocket clients. The
 * sandbox also exposes `tizen`, which the launcher page itself does not get,
 * so app listing, launching, links and exit go through here. The TV's Node
 * can be old (v4 on Tizen 3), so this file is plain ES5.
 *
 * It can also run on a computer for development:
 *   TV_HOST=192.168.1.10 node service/service.js
 *
 * Listens on PORT (0.0.0.0):
 *   Phone (needs the PIN shown on the TV):
 *     GET  /                     phone companion page
 *     POST /api/send             { pin, url } or { pin, text }
 *     GET  /api/settings?pin=    widget settings (token masked)
 *     POST /api/settings         { pin, ...settings }
 *   Launcher (localhost only):
 *     GET  /api/info             { ip, port, pin, phoneUrl }
 *     GET  /api/inbox            queued phone messages (clears them)
 *     POST /api/key              { key: "KEY_HDMI1" } -> TV remote key
 *     GET  /api/icon?path=       app icon file from the TV filesystem
 *     GET  /api/inputs           configured input tiles
 *     GET  /api/calendar         upcoming events from the ICS feed
 *     GET  /api/ha/states        configured Home Assistant entities
 *     POST /api/ha/action        { entity_id }
 *     GET  /api/tizenbrew        TizenBrew auto-launch config
 *     GET  /api/apps             installed apps (via tizen.application)
 *     POST /api/launch           { id } launch an app
 *     POST /api/open             { url } open a link in the TV browser
 *     POST /api/exit             leave to the Samsung home screen
 *     GET  /api/status           runtime info for troubleshooting
 */
function tvdeckService() {
  'use strict';

  var http = require('http');
  var https = require('https');
  var tls = require('tls');
  var crypto = require('crypto');
  var urlLib = require('url');
  var fs = require('fs');
  var pathLib = require('path');

  var HAS_TIZEN = typeof tizen !== 'undefined' && !!tizen.application;

  var PORT = 8085;
  var TV_HOST = (typeof process !== 'undefined' && process.env && process.env.TV_HOST) || '127.0.0.1';
  var ON_TV = TV_HOST === '127.0.0.1';
  var SHARE_DIR = '/home/owner/share';
  var CONFIG_FILE = fs.existsSync(SHARE_DIR) ? SHARE_DIR + '/tvdeck.json' : pathLib.resolve('.tvdeck.json');
  var TIZENBREW_CONFIG = SHARE_DIR + '/tizenbrewConfig.json';
  var ICON_ROOTS = ['/opt/', '/usr/'];
  var ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  var MAX_BODY = 64 * 1024;

  // Old Node lacks Buffer.from/alloc.
  function bufFrom(data, encoding) {
    return Buffer.from ? Buffer.from(data, encoding) : new Buffer(data, encoding);
  }

  function bufAlloc(size) {
    return Buffer.alloc ? Buffer.alloc(size) : new Buffer(size).fill(0);
  }

  var pin = String(1000 + Math.floor(Math.random() * 9000));
  var pinFailures = { count: 0, lockedUntil: 0 };
  var inbox = [];
  var deviceIP = null;
  var config = readConfig();

  /* ---------- Config ---------- */

  function defaultConfig() {
    return {
      remoteToken: '',
      calendarUrl: '',
      haUrl: '',
      haToken: '',
      haEntities: '',
      inputs: 'HDMI 1=KEY_HDMI1\nHDMI 2=KEY_HDMI2\nHDMI 3=KEY_HDMI3\nTV ao vivo=KEY_TV'
    };
  }

  function readConfig() {
    var cfg = defaultConfig();
    try {
      var saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.keys(cfg).forEach(function (k) { if (typeof saved[k] === 'string') cfg[k] = saved[k]; });
    } catch (e) { /* first run */ }
    // The English default's "Live TV" line becomes "TV ao vivo".
    cfg.inputs = cfg.inputs.replace(/^Live TV=KEY_TV$/m, 'TV ao vivo=KEY_TV');
    return cfg;
  }

  function writeConfig() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
      console.log('[tvdeck] could not save config: ' + e.message);
    }
  }

  function publicSettings() {
    return {
      calendarUrl: config.calendarUrl,
      haUrl: config.haUrl,
      haTokenSet: !!config.haToken,
      haEntities: config.haEntities,
      inputs: config.inputs
    };
  }

  function parseInputs() {
    return config.inputs.split('\n').map(function (line) {
      var parts = line.split('=');
      var name = (parts[0] || '').trim();
      var key = (parts[1] || '').trim().toUpperCase();
      return name && /^KEY_[A-Z0-9_]+$/.test(key) ? { name: name, key: key } : null;
    }).filter(Boolean);
  }

  /* ---------- HTTP client (built-ins only) ---------- */

  // Minimal fetch: follows redirects, resolves { ok, status, text(), json() }.
  // Certificates are only relaxed for the TV itself (self-signed on :8002).
  function fetchFn(url, options, redirects) {
    options = options || {};
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      var parsed = urlLib.parse(url);
      var lib = parsed.protocol === 'https:' ? https : http;
      var req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method: options.method || 'GET',
        headers: options.headers || {},
        rejectUnauthorized: parsed.hostname !== '127.0.0.1' && parsed.hostname !== TV_HOST
      }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          var next = urlLib.resolve(url, res.headers.location);
          var keep = res.statusCode === 307 || res.statusCode === 308;
          resolve(fetchFn(next, keep ? options : { headers: options.headers }, redirects + 1));
          return;
        }
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          var body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: function () { return Promise.resolve(body); },
            json: function () {
              return new Promise(function (ok, fail) {
                try { ok(JSON.parse(body)); } catch (e) { fail(e); }
              });
            }
          });
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, function () {
        req.abort();
        reject(new Error('Request timed out'));
      });
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  /* ---------- Device IP ---------- */

  function localInterfaceIP() {
    var nets = require('os').networkInterfaces();
    Object.keys(nets).forEach(function (name) {
      nets[name].forEach(function (net) {
        if (!deviceIP && (net.family === 'IPv4' || net.family === 4) && !net.internal) deviceIP = net.address;
      });
    });
  }

  // On the TV, ask the TV's own REST API; in development, use this machine's IP.
  function loadDeviceIP() {
    if (!ON_TV) return localInterfaceIP();
    fetchFn('http://127.0.0.1:8001/api/v2/')
      .then(function (res) { return res.json(); })
      .then(function (json) { deviceIP = json.device.ip; })
      .catch(localInterfaceIP);
  }

  /* ---------- TV remote keys (wss://:8002) ---------- */

  // Minimal RFC 6455 client over TLS, enough for the TV's remote channel:
  // text frames, close, ping/pong. handlers: open, message(text), close.
  function wsConnect(url, handlers) {
    var parsed = urlLib.parse(url);
    var key = crypto.randomBytes(16).toString('base64');
    var buffer = bufAlloc(0);
    var upgraded = false;
    var socket = tls.connect({ host: parsed.hostname, port: +parsed.port || 443, rejectUnauthorized: false }, function () {
      socket.write('GET ' + parsed.path + ' HTTP/1.1\r\n' +
        'Host: ' + parsed.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });

    function frame(payload, opcode) {
      var len = payload.length;
      var header;
      if (len < 126) {
        header = bufAlloc(2);
        header[1] = 0x80 | len;
      } else if (len < 65536) {
        header = bufAlloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = bufAlloc(10);
        header[1] = 0x80 | 127;
        header.writeUInt32BE(len, 6);
      }
      header[0] = 0x80 | opcode;
      var mask = crypto.randomBytes(4);
      var body = bufAlloc(len);
      for (var i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, body]));
    }

    function readFrames() {
      while (buffer.length >= 2) {
        var len = buffer[1] & 127;
        var offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = buffer.readUInt32BE(6);
          offset = 10;
        }
        if (buffer[1] & 128) offset += 4; // servers don't mask, but be safe
        if (buffer.length < offset + len) return;
        var opcode = buffer[0] & 15;
        var payload = buffer.slice(offset, offset + len);
        buffer = buffer.slice(offset + len);
        if (opcode === 1 && handlers.message) handlers.message(payload.toString('utf8'));
        else if (opcode === 8) socket.end();
        else if (opcode === 9) frame(payload, 10);
      }
    }

    socket.on('data', function (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        var end = buffer.toString('binary').indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!/^HTTP\/1\.1 101/.test(buffer.slice(0, end).toString())) return socket.destroy();
        upgraded = true;
        buffer = buffer.slice(end + 4);
        if (handlers.open) handlers.open();
      }
      readFrames();
    });
    socket.on('close', function () { if (handlers.close) handlers.close(); });
    socket.on('error', function () { /* close follows */ });

    return {
      send: function (text) { frame(bufFrom(String(text), 'utf8'), 1); },
      close: function () { socket.end(); }
    };
  }

  var remote = { socket: null, ready: false, queue: [] };

  function remoteUrl() {
    var name = bufFrom('TVDeck').toString('base64');
    var url = 'wss://' + TV_HOST + ':8002/api/v2/channels/samsung.remote.control?name=' + name;
    return config.remoteToken ? url + '&token=' + config.remoteToken : url;
  }

  // Connects lazily (on the first key), so the TV's "Allow TVDeck?" prompt
  // only appears when the user actually uses an input or Exit.
  function connectRemote() {
    if (remote.socket) return;
    remote.socket = wsConnect(remoteUrl(), {
      message: function (raw) {
        var msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (msg.event === 'ms.channel.connect') {
          if (msg.data && msg.data.token && String(msg.data.token) !== config.remoteToken) {
            config.remoteToken = String(msg.data.token);
            writeConfig();
          }
          remote.ready = true;
          flushKeys();
        } else if (msg.event === 'ms.channel.unauthorized') {
          remote.socket.close();
        }
      },
      close: function () {
        remote.socket = null;
        remote.ready = false;
      }
    });
  }

  function flushKeys() {
    while (remote.ready && remote.queue.length) {
      remote.socket.send(JSON.stringify({
        method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: remote.queue.shift(), Option: 'false', TypeOfRemote: 'SendRemoteKey' }
      }));
    }
  }

  function sendKey(key) {
    remote.queue.push(key);
    if (remote.ready) flushKeys(); else connectRemote();
  }

  /* ---------- Calendar (ICS) ---------- */

  function unfoldIcs(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  }

  function parseIcsDate(value, params) {
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (!m[4]) return { date: new Date(y, mo, d), allDay: true };
    var date = m[7]
      ? new Date(Date.UTC(y, mo, d, +m[4], +m[5], +m[6]))
      : new Date(y, mo, d, +m[4], +m[5], +m[6]); // TZID times treated as TV local time
    return { date: date, allDay: /VALUE=DATE(?!-)/.test(params) };
  }

  function parseIcs(text) {
    var events = [];
    var current = null;
    unfoldIcs(text).forEach(function (line) {
      if (line === 'BEGIN:VEVENT') { current = { exdates: [] }; return; }
      if (line === 'END:VEVENT') { if (current && current.start) events.push(current); current = null; return; }
      if (!current) return;
      var colon = line.indexOf(':');
      if (colon === -1) return;
      var head = line.slice(0, colon);
      var value = line.slice(colon + 1);
      var name = head.split(';')[0];
      if (name === 'SUMMARY') current.title = value.replace(/\\,/g, ',').replace(/\\n/g, ' ');
      else if (name === 'DTSTART') current.start = parseIcsDate(value, head);
      else if (name === 'RRULE') current.rrule = value;
      else if (name === 'EXDATE') {
        value.split(',').forEach(function (v) {
          var ex = parseIcsDate(v, head);
          if (ex) current.exdates.push(ex.date.getTime());
        });
      }
    });
    return events;
  }

  // Expands DAILY / WEEKLY (with BYDAY) / MONTHLY / YEARLY rules inside [from, to).
  function occurrences(event, from, to) {
    var start = event.start.date;
    if (!event.rrule) return start >= from && start < to ? [start] : [];
    var rule = {};
    event.rrule.split(';').forEach(function (part) {
      var kv = part.split('=');
      rule[kv[0]] = kv[1];
    });
    var interval = +(rule.INTERVAL || 1);
    var until = rule.UNTIL ? parseIcsDate(rule.UNTIL, '') : null;
    var count = rule.COUNT ? +rule.COUNT : Infinity;
    var dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    var byDay = rule.BYDAY ? rule.BYDAY.split(',').map(function (d) { return dayCodes.indexOf(d.slice(-2)); }) : null;
    var out = [];
    var n = 0;
    var cursor = new Date(start.getTime());
    for (var guard = 0; guard < 3000 && cursor < to && n < count; guard++) {
      if (until && cursor > until.date) break;
      var candidates = [];
      if (rule.FREQ === 'WEEKLY' && byDay) {
        var weekStart = new Date(cursor.getTime());
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        byDay.forEach(function (dow) {
          var c = new Date(weekStart.getTime());
          c.setDate(c.getDate() + dow);
          if (c >= start) candidates.push(c);
        });
        candidates.sort(function (a, b) { return a - b; });
      } else {
        candidates.push(new Date(cursor.getTime()));
      }
      for (var i = 0; i < candidates.length && n < count; i++) {
        var occ = candidates[i];
        if (until && occ > until.date) break;
        n++;
        if (occ >= from && occ < to && event.exdates.indexOf(occ.getTime()) === -1) out.push(occ);
      }
      if (rule.FREQ === 'DAILY') cursor.setDate(cursor.getDate() + interval);
      else if (rule.FREQ === 'WEEKLY') cursor.setDate(cursor.getDate() + 7 * interval);
      else if (rule.FREQ === 'MONTHLY') cursor.setMonth(cursor.getMonth() + interval);
      else if (rule.FREQ === 'YEARLY') cursor.setFullYear(cursor.getFullYear() + interval);
      else break;
    }
    return out;
  }

  var calendarCache = { at: 0, url: '', events: [] };

  function upcomingEvents() {
    if (!config.calendarUrl) return Promise.resolve([]);
    var url = config.calendarUrl.replace(/^webcal:/, 'https:');
    if (calendarCache.url === url && Date.now() - calendarCache.at < 10 * 60 * 1000) {
      return Promise.resolve(calendarCache.events);
    }
    return fetchFn(url).then(function (res) { return res.text(); }).then(function (text) {
      var now = new Date();
      var from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var to = new Date(from.getTime() + 7 * 86400000);
      var list = [];
      parseIcs(text).forEach(function (event) {
        occurrences(event, from, to).forEach(function (date) {
          if (!event.start.allDay && date < now) return;
          list.push({ title: event.title || '(no title)', start: date.getTime(), allDay: event.start.allDay });
        });
      });
      list.sort(function (a, b) { return a.start - b.start; });
      calendarCache = { at: Date.now(), url: url, events: list.slice(0, 6) };
      return calendarCache.events;
    });
  }

  /* ---------- Home Assistant ---------- */

  function haRequest(path, body) {
    var base = config.haUrl.replace(/\/+$/, '');
    return fetchFn(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + config.haToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('Home Assistant HTTP ' + res.status);
      return res.json();
    });
  }

  function haEntityIds() {
    return config.haEntities.split(/[\s,]+/).filter(function (id) { return /^[a-z_]+\.[a-z0-9_]+$/.test(id); });
  }

  function haStates() {
    if (!config.haUrl || !config.haToken) return Promise.resolve([]);
    var ids = haEntityIds();
    return haRequest('/api/states').then(function (states) {
      return states.filter(function (s) { return ids.indexOf(s.entity_id) !== -1; }).map(function (s) {
        var a = s.attributes || {};
        return {
          id: s.entity_id,
          domain: s.entity_id.split('.')[0],
          name: a.friendly_name || s.entity_id,
          state: s.state,
          unit: a.unit_of_measurement || '',
          mediaTitle: a.media_title || '',
          mediaArtist: a.media_artist || a.media_album_name || ''
        };
      }).sort(function (x, y) { return ids.indexOf(x.id) - ids.indexOf(y.id); });
    });
  }

  function haAction(entityId) {
    if (haEntityIds().indexOf(entityId) === -1) return Promise.reject(new Error('Unknown entity'));
    var domain = entityId.split('.')[0];
    var service = {
      media_player: 'media_player/media_play_pause',
      scene: 'scene/turn_on',
      script: 'script/turn_on',
      button: 'button/press'
    }[domain] || 'homeassistant/toggle';
    return haRequest('/api/services/' + service, { entity_id: entityId });
  }

  /* ---------- TV apps (tizen API, available to the service only) ---------- */

  // getAppsInfo takes ~5 s on a TV (it returns ~370 entries), so the list is
  // cached in memory and on disk, served instantly, and refreshed behind.
  var APPS_FILE = fs.existsSync(SHARE_DIR) ? SHARE_DIR + '/tvdeck-apps.json' : pathLib.resolve('.tvdeck-apps.json');
  var appsCache = { at: 0, apps: null, pending: null };
  var APPS_MAX_AGE = 60 * 1000;

  try {
    appsCache.apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  } catch (e) { /* first run */ }

  function refreshApps() {
    if (appsCache.pending) return appsCache.pending;
    appsCache.pending = fetchApps().then(function (apps) {
      appsCache = { at: Date.now(), apps: apps, pending: null };
      try { fs.writeFileSync(APPS_FILE, JSON.stringify(apps)); } catch (e) { /* read-only */ }
      return apps;
    }, function (err) {
      appsCache.pending = null;
      throw err;
    });
    return appsCache.pending;
  }

  function listApps() {
    if (appsCache.apps) {
      if (Date.now() - appsCache.at > APPS_MAX_AGE) refreshApps().catch(function () {});
      return Promise.resolve(appsCache.apps);
    }
    return refreshApps();
  }

  function fetchApps() {
    if (!HAS_TIZEN) return Promise.reject(new Error('Tizen API unavailable'));
    return new Promise(function (resolve, reject) {
      tizen.application.getAppsInfo(function (infos) {
        resolve(infos.map(function (info) {
          return {
            id: info.id,
            name: info.name,
            icon: info.iconPath || '',
            categories: info.categories || [],
            show: info.show !== false
          };
        }));
      }, reject);
    });
  }

  function launchApp(id) {
    if (!HAS_TIZEN) return Promise.reject(new Error('Tizen API unavailable'));
    return new Promise(function (resolve, reject) {
      tizen.application.launch(id, resolve, reject);
    });
  }

  function openUrl(url) {
    if (!HAS_TIZEN) return Promise.reject(new Error('Tizen API unavailable'));
    return new Promise(function (resolve, reject) {
      var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
      tizen.application.launchAppControl(control, 'org.tizen.browser', resolve, function () {
        // Fall back to whichever app handles web links.
        tizen.application.launchAppControl(control, null, resolve, reject);
      });
    });
  }

  /* ---------- TizenBrew config ---------- */

  function tizenbrewConfig() {
    try {
      var cfg = JSON.parse(fs.readFileSync(TIZENBREW_CONFIG, 'utf8'));
      return { autoLaunchModule: cfg.autoLaunchModule || '', autoLaunchServiceList: cfg.autoLaunchServiceList || [] };
    } catch (e) {
      return { autoLaunchModule: '', autoLaunchServiceList: [] };
    }
  }

  /* ---------- HTTP ---------- */

  function isLocal(req) {
    var addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  function send(res, status, body, type) {
    var isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': type || (isJson ? 'application/json' : 'text/html; charset=utf-8'),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req) {
    return new Promise(function (resolve, reject) {
      var chunks = [];
      var size = 0;
      req.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
      });
    });
  }

  // 4-digit PIN: lock out for a minute after 10 wrong guesses.
  function checkPin(value) {
    if (Date.now() < pinFailures.lockedUntil) return false;
    if (value === pin) { pinFailures.count = 0; return true; }
    if (++pinFailures.count >= 10) {
      pinFailures.count = 0;
      pinFailures.lockedUntil = Date.now() + 60000;
    }
    return false;
  }

  function phoneUrl() {
    return deviceIP ? 'http://' + deviceIP + ':' + PORT + '/?pin=' + pin : '';
  }

  function serveIcon(res, iconPath) {
    var resolved = pathLib.normalize(iconPath || '');
    var type = ICON_TYPES[pathLib.extname(resolved).toLowerCase()];
    var allowed = ICON_ROOTS.some(function (root) { return resolved.indexOf(root) === 0; });
    if (!type || !allowed) return send(res, 400, { error: 'Not an icon' });
    fs.readFile(resolved, function (err, data) {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    });
  }

  function fail(res) {
    return function (err) { send(res, 502, { error: err.message }); };
  }

  function handle(req, res) {
    var url = require('url').parse(req.url, true);
    var route = req.method + ' ' + url.pathname;
    var local = isLocal(req);

    if (req.method === 'OPTIONS') return send(res, 204, '');

    // Phone routes
    if (route === 'GET /') return send(res, 200, PHONE_PAGE);
    if (route === 'GET /favicon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' });
      return res.end(Buffer.from ? Buffer.from(FAVICON_PNG, 'base64') : new Buffer(FAVICON_PNG, 'base64'));
    }
    if (route === 'GET /icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' });
      return res.end(Buffer.from ? Buffer.from(ICON_PNG, 'base64') : new Buffer(ICON_PNG, 'base64'));
    }
    if (route === 'POST /api/send') {
      return readBody(req).then(function (body) {
        if (!checkPin(body.pin)) return send(res, 403, { error: 'PIN incorreto' });
        var item = body.url ? { type: 'url', value: String(body.url).slice(0, 2000) }
          : body.text ? { type: 'text', value: String(body.text).slice(0, 500) } : null;
        if (!item) return send(res, 400, { error: 'Nada para enviar' });
        item.at = Date.now();
        inbox.push(item);
        if (inbox.length > 10) inbox.shift();
        send(res, 200, { ok: true });
      }).catch(fail(res));
    }
    if (route === 'GET /api/settings') {
      if (!checkPin(url.query.pin)) return send(res, 403, { error: 'PIN incorreto' });
      return send(res, 200, publicSettings());
    }
    if (route === 'POST /api/settings') {
      return readBody(req).then(function (body) {
        if (!checkPin(body.pin)) return send(res, 403, { error: 'PIN incorreto' });
        ['calendarUrl', 'haUrl', 'haEntities', 'inputs'].forEach(function (k) {
          if (typeof body[k] === 'string') config[k] = body[k].trim();
        });
        if (typeof body.haToken === 'string' && body.haToken.trim()) config.haToken = body.haToken.trim();
        if (body.clearHaToken) config.haToken = '';
        calendarCache.at = 0;
        writeConfig();
        send(res, 200, publicSettings());
      }).catch(fail(res));
    }

    // Launcher routes: same device only
    if (!local) return send(res, 404, { error: 'Not found' });

    if (route === 'GET /api/info') {
      return send(res, 200, { ip: deviceIP, port: PORT, pin: pin, phoneUrl: phoneUrl() });
    }
    if (route === 'GET /api/inbox') {
      var items = inbox;
      inbox = [];
      return send(res, 200, { items: items });
    }
    if (route === 'POST /api/key') {
      return readBody(req).then(function (body) {
        if (!/^KEY_[A-Z0-9_]+$/.test(body.key || '')) return send(res, 400, { error: 'Bad key' });
        sendKey(body.key);
        send(res, 200, { ok: true });
      }).catch(fail(res));
    }
    if (route === 'GET /api/icon') return serveIcon(res, url.query.path);
    if (route === 'GET /api/inputs') return send(res, 200, { inputs: parseInputs() });
    if (route === 'GET /api/calendar') {
      return upcomingEvents().then(function (events) {
        send(res, 200, { configured: !!config.calendarUrl, events: events });
      }).catch(fail(res));
    }
    if (route === 'GET /api/ha/states') {
      return haStates().then(function (entities) {
        send(res, 200, { configured: !!(config.haUrl && config.haToken), entities: entities });
      }).catch(fail(res));
    }
    if (route === 'POST /api/ha/action') {
      return readBody(req).then(function (body) {
        return haAction(String(body.entity_id || '')).then(function () { send(res, 200, { ok: true }); });
      }).catch(fail(res));
    }
    if (route === 'GET /api/tizenbrew') return send(res, 200, tizenbrewConfig());
    if (route === 'GET /api/status') {
      return send(res, 200, {
        node: typeof process !== 'undefined' ? process.version : null,
        tizen: HAS_TIZEN,
        remote: remote.ready,
        ip: deviceIP
      });
    }
    if (route === 'GET /api/apps') {
      return listApps().then(function (apps) { send(res, 200, { apps: apps }); }).catch(fail(res));
    }
    if (route === 'POST /api/launch') {
      return readBody(req).then(function (body) {
        return launchApp(String(body.id || '')).then(function () { send(res, 200, { ok: true }); });
      }).catch(fail(res));
    }
    if (route === 'POST /api/open') {
      return readBody(req).then(function (body) {
        if (!/^https?:\/\//.test(body.url || '')) return send(res, 400, { error: 'Bad URL' });
        return openUrl(body.url).then(function () { send(res, 200, { ok: true }); });
      }).catch(fail(res));
    }
    if (route === 'POST /api/exit') {
      // Pressing Home leaves TizenBrew (and TVDeck) for the Samsung home screen.
      sendKey('KEY_HOME');
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  }

  /* ---------- Phone page ---------- */

  // TVDeck app icon (180x180 PNG), embedded because TizenBrew loads this
  // service as a single file. Used as the phone page's favicon and
  // home-screen icon. Regenerate from assets/brand/tvdeck-icon-1024.png.
  // Transparent mark (64x64 PNG) for the browser tab.
  var FAVICON_PNG = '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';
  var ICON_PNG = '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';

  var PHONE_PAGE = [
    '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>TVDeck</title>',
    '<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/icon.png">',
    '<meta name="apple-mobile-web-app-title" content="TVDeck"><style>',
    ':root{color-scheme:dark}body{margin:0;font:17px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:radial-gradient(120% 60% at 50% -10%,#0b3b4a 0%,#04121a 45%,#000 100%) fixed;color:#fff}',
    'main{max-width:560px;margin:0 auto;padding:28px 16px 48px}h1{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:8px 4px 4px}',
    'h2{font-size:13px;font-weight:400;color:rgba(235,235,245,.6);text-transform:uppercase;letter-spacing:.02em;margin:28px 16px 8px}',
    '.group{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:16px;padding:4px 16px 16px}',
    'label{display:block;font-size:13px;color:rgba(235,235,245,.6);margin:12px 0 6px}',
    'input,textarea{width:100%;box-sizing:border-box;padding:11px 12px;border:0;border-radius:10px;background:rgba(255,255,255,.08);color:inherit;font:inherit}',
    'input:focus,textarea:focus{outline:2px solid #2dd4bf;outline-offset:0}textarea{min-height:96px}',
    'button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:14px;background:linear-gradient(135deg,#14b8a6,#0ea5e9);color:#fff;font:600 17px -apple-system,system-ui,sans-serif}',
    'button:active{opacity:.7}.msg{min-height:20px;margin:8px 4px 0;font-size:14px;color:rgba(235,235,245,.6)}',
    '.hint{font-size:13px;color:rgba(235,235,245,.6);margin:8px 0 0}',
    '.brand{display:flex;align-items:center;gap:12px;margin:4px 4px 0}.brand img{width:44px;height:44px;border-radius:10px}.brand h1{margin:0}</style></head><body><main>',
    '<header class="brand"><img src="/icon.png" alt=""><h1>TVDeck</h1></header>',
    '<h2>Enviar para a TV</h2><div class="group">',
    '<label for="link">Link ou texto</label><input id="link" placeholder="Cole um link ou digite uma mensagem" autocomplete="off">',
    '<button id="send">Enviar para a TV</button></div><div class="msg" id="send-msg"></div>',
    '<h2>Entradas</h2><div class="group">',
    '<label for="inputs">Uma por linha: Nome=TECLA</label><textarea id="inputs"></textarea>',
    '<p class="hint">Teclas: KEY_HDMI1-4, KEY_TV, KEY_SOURCE. Exemplo: PlayStation=KEY_HDMI2</p></div>',
    '<h2>Agenda</h2><div class="group">',
    '<label for="calendarUrl">Endereço secreto iCal (.ics)</label><input id="calendarUrl" placeholder="https://calendar.google.com/calendar/ical/...">',
    '<p class="hint">Google Agenda: Configurações, sua agenda, Integrar agenda, Endereço secreto no formato iCal.</p></div>',
    '<h2>Home Assistant</h2><div class="group">',
    '<label for="haUrl">URL</label><input id="haUrl" placeholder="http://homeassistant.local:8123">',
    '<label for="haToken">Token de acesso de longa duração</label><input id="haToken" type="password" placeholder="Deixe vazio para manter o token salvo">',
    '<label for="haEntities">Entidades (separadas por vírgula ou linha)</label><textarea id="haEntities" placeholder="light.living_room, media_player.spotify"></textarea>',
    '</div><button id="save">Salvar ajustes</button><div class="msg" id="save-msg"></div>',
    '</main><script>',
    'var pin=new URLSearchParams(location.search).get("pin")||prompt("PIN mostrado na TV")||"";',
    'function $(id){return document.getElementById(id)}',
    'function post(path,body){body.pin=pin;return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})})}',
    'function fill(s){["calendarUrl","haUrl","haEntities","inputs"].forEach(function(k){$(k).value=s[k]||""});$("haToken").placeholder=s.haTokenSet?"Salvo. Deixe vazio para manter":"Cole o token"}',
    'fetch("/api/settings?pin="+encodeURIComponent(pin)).then(function(r){return r.json()}).then(function(s){if(s.error){$("save-msg").textContent=s.error}else fill(s)});',
    '$("send").onclick=function(){var v=$("link").value.trim();if(!v)return;var isUrl=/^(https?:\\/\\/|www\\.)/i.test(v);',
    'post("/api/send",isUrl?{url:/^www\\./i.test(v)?"https://"+v:v}:{text:v}).then(function(){$("send-msg").textContent="Enviado";$("link").value=""}).catch(function(e){$("send-msg").textContent=e.message})};',
    '$("save").onclick=function(){post("/api/settings",{calendarUrl:$("calendarUrl").value,haUrl:$("haUrl").value,haToken:$("haToken").value,haEntities:$("haEntities").value,inputs:$("inputs").value})',
    '.then(function(s){fill(s);$("haToken").value="";$("save-msg").textContent="Salvo"}).catch(function(e){$("save-msg").textContent=e.message})};',
    '</script></body></html>'
  ].join('\n');

  /* ---------- Start ---------- */

  loadDeviceIP();
  if (HAS_TIZEN) refreshApps().catch(function () {}); // warm the app cache
  http.createServer(function (req, res) {
    try { handle(req, res); } catch (e) { send(res, 500, { error: e.message }); }
  }).listen(PORT, '0.0.0.0', function () {
    console.log('[tvdeck] service listening on :' + PORT + ' (PIN ' + pin + ')');
  });
}

/*
 * Self-update. TizenBrew fetches this file through jsDelivr, whose cached
 * branch can trail GitHub by hours. So on start, look up the newest commit,
 * fetch this file from that exact commit (an immutable URL) and run it in
 * place of this copy. If anything fails, run this copy. Skipped in
 * development (TV_HOST set) and inside the fetched copy itself.
 */
(function () {
  var REPO = 'robinexe/tvdeck'; // this fork: self-update must fetch this repo's service
  var dev = typeof process !== 'undefined' && process.env && process.env.TV_HOST;
  if (dev || typeof TVDECK_SERVICE_FRESH !== 'undefined') return tvdeckService();

  var https = require('https');
  var started = false;
  function runLocal() {
    if (started) return;
    started = true;
    tvdeckService();
  }
  function get(url, headers) {
    return new Promise(function (resolve, reject) {
      var req = https.get(url, { headers: headers || {} }, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200) resolve(body); else reject(new Error('HTTP ' + res.statusCode));
        });
      });
      req.on('error', reject);
      req.setTimeout(6000, function () { req.abort(); reject(new Error('timeout')); });
    });
  }

  setTimeout(runLocal, 10000); // never stay down because GitHub is slow
  get('https://api.github.com/repos/' + REPO + '/commits/main',
    { 'User-Agent': 'TVDeck', Accept: 'application/vnd.github.sha' })
    .then(function (sha) {
      sha = sha.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('bad sha');
      return get('https://cdn.jsdelivr.net/gh/' + REPO + '@' + sha + '/service/service.js');
    })
    .then(function (code) {
      if (started) return;
      started = true;
      TVDECK_SERVICE_FRESH = true; // the fresh copy sees this and runs directly
      // Function() runs in this sandbox's global scope, so `tizen` resolves
      // as it does for this copy; `require` is passed in (it is module-scoped
      // in plain Node).
      try {
        Function('require', code)(require);
      } catch (e) {
        started = false;
        runLocal();
      }
    })
    .catch(runLocal);
})();

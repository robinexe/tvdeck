/*
 * TVDeck launcher: rows of tiles driven by the TV remote.
 *
 * Remote keys (desktop keyboard equivalents in brackets):
 *   Arrows / Enter        move / open
 *   Back       [Esc]      close panel, cancel move
 *   Red        [R]        pin / unpin to Favorites
 *   Green      [G]        settings
 *   Yellow     [Y]        reorder (in Favorites) or hide app
 *   Blue       [B]        refresh everything
 *   CH+ / CH-  [PgUp/Dn]  jump between rows
 */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    CH_UP: 427, CH_DOWN: 428, PG_UP: 33, PG_DOWN: 34,
    IME_DONE: 65376, IME_CANCEL: 65385
  };
  var DESKTOP_ALIASES = { 82: KEY.RED, 71: KEY.GREEN, 89: KEY.YELLOW, 66: KEY.BLUE, 27: KEY.BACK, 33: KEY.CH_UP, 34: KEY.CH_DOWN };

  var MAX_RECENT = 10;
  var PINNABLE = { app: true, mod: true, web: true, key: true };
  var HA_ACTIONABLE = ['light', 'switch', 'fan', 'input_boolean', 'scene', 'script', 'button', 'media_player', 'cover', 'lock'];
  var DESKTOP_INPUTS = [
    { name: 'HDMI 1', key: 'KEY_HDMI1' }, { name: 'HDMI 2', key: 'KEY_HDMI2' },
    { name: 'HDMI 3', key: 'KEY_HDMI3' }, { name: 'TV ao vivo', key: 'KEY_TV' }
  ];


  var els = {
    rows: document.getElementById('rows'),
    clock: document.getElementById('clock'),
    date: document.getElementById('date'),
    page: document.getElementById('page'),
    weather: document.getElementById('weather'),
    weatherTemp: document.getElementById('weather-temp'),
    weatherLabel: document.getElementById('weather-label'),
    weatherGlyph: document.getElementById('weather-glyph'),
    weatherRange: document.getElementById('weather-range'),
    hello: document.getElementById('hello'),
    helloSub: document.getElementById('hello-sub'),
    hints: document.getElementById('hints'),
    toast: document.getElementById('toast'),
    settings: document.getElementById('settings'),
    settingsList: document.getElementById('settings-list'),
    overlay: document.getElementById('overlay'),
    overlayCard: document.getElementById('overlay-card'),
    ticker: document.getElementById('ticker'),
    ambient: document.getElementById('ambient'),
    ambientClock: document.getElementById('ambient-clock'),
    ambientDate: document.getElementById('ambient-date'),
    ambientLine: document.getElementById('ambient-line'),
    shelfInfo: document.querySelector('.shelf-info'),
    shelfKind: document.getElementById('shelf-kind'),
    shelfTitle: document.getElementById('shelf-title'),
    shelfMeta: document.getElementById('shelf-meta'),
    washes: document.querySelectorAll('.wash'),
    settingsGlyph: document.getElementById('settings-glyph'),
    settingsTitle: document.getElementById('settings-title'),
    settingsSubtitle: document.getElementById('settings-subtitle'),
    settingsSide: document.querySelector('.settings-side'),
    navButtons: Array.prototype.slice.call(document.querySelectorAll('.nav-btn')),
    settingsPanel: document.querySelector('.settings-panel')
  };

  var data = { apps: [], modules: [], inputs: [], calendar: null, ha: [], tizenbrew: null };
  var rows = [];            // [{ id, title, items, col, el, trackEl }]
  var rowIndex = 0;
  var scrollY = 0;
  var loaded = false;       // first app/module list received
  var moving = false;       // reordering a favorite
  var mode = 'home';        // 'home' | 'settings' | 'overlay'
  var overlay = null;       // { type: 'phone' } | { type: 'message', item }
  var messages = [];        // queued phone messages
  var settingsItems = [];
  var settingsIndex = 0;
  var toastTimer = null;
  var navFocus = false;     // focus is in the top bar
  var navIndex = 0;
  var NAV_ITEMS = [
    { key: 'nav:settings', kind: 'tool', name: 'Ajustes', ref: 'settings' },
    { key: 'nav:phone', kind: 'tool', name: 'Enviar do celular', ref: 'phone' }
  ];
  var glanceSignature = '';
  var IDLE_MS = 2500;               // focused tile starts its idle shimmer
  var CALM_MS = 6000;               // remote-key hints step aside
  var REPEAT_MS = 190;              // arrows closer than this = holding the key
  var AMBIENT_MS = 5 * 60 * 1000;   // whole screen goes ambient
  if (!Platform.isTV && /[?&]ambient\b/.test(location.search)) AMBIENT_MS = 4000; // desktop preview

  /* ---------- Items ---------- */

  function catalog() {
    var items = {};
    data.apps.forEach(function (app) {
      items['app:' + app.id] = { key: 'app:' + app.id, kind: 'app', name: app.name, icon: app.icon, ref: app,
        category: Categories.categorize(app) };
    });
    data.modules.forEach(function (mod) {
      items['mod:' + mod.fullName] = { key: 'mod:' + mod.fullName, kind: 'mod', name: mod.appName || mod.name, badge: 'Módulo', ref: mod };
    });
    Store.get('webLinks').forEach(function (link) {
      items['web:' + link.url] = { key: 'web:' + link.url, kind: 'web', name: link.name, badge: 'Web', ref: link };
    });
    data.inputs.forEach(function (input) {
      items['key:' + input.key] = { key: 'key:' + input.key, kind: 'key', name: input.name, badge: 'Entrada', ref: input };
    });
    // TV ao vivo is always available as a shortcut, even before the service lists inputs.
    if (!items['key:KEY_TV']) {
      var live = { name: 'TV ao vivo', key: 'KEY_TV' };
      items['key:KEY_TV'] = { key: 'key:KEY_TV', kind: 'key', name: live.name, badge: 'Entrada', ref: live };
    }
    return items;
  }

  function glanceItems() {
    var list = [];
    if (data.calendar && data.calendar.configured) {
      list.push({ key: 'glance:calendar', kind: 'calendar', name: 'Agenda', events: data.calendar.events });
    }
    data.ha.forEach(function (entity) {
      var media = entity.domain === 'media_player';
      if (media && (entity.state === 'off' || entity.state === 'unavailable')) return;
      list.push({ key: 'ha:' + entity.id, kind: media ? 'media' : 'ha', name: entity.name, ref: entity });
    });
    return list;
  }

  function buildRows() {
    var items = catalog();
    var hidden = Store.get('hiddenApps');
    function lookup(keys) {
      return keys.map(function (key) { return items[key]; }).filter(Boolean);
    }

    var next = [
      { id: 'favorites', title: 'Favoritos', featured: true, items: lookup(Store.get('favorites')),
        empty: 'Aperte o VERMELHO em qualquer bloco para fixar aqui' },
      { id: 'glance', title: 'Resumo', glance: true, items: glanceItems() },
      { id: 'recent', title: 'Recentes', items: Store.get('showRecent') ? lookup(Store.get('recent')) : [] },
      { id: 'inputs', title: 'Entradas', items: Store.get('showInputs') ? data.inputs.map(function (input) { return items['key:' + input.key]; }) : [] },
    ].concat(appRows(items, hidden), [
      { id: 'modules', title: 'Módulos TizenBrew', items: data.modules
          .map(function (mod) { return items['mod:' + mod.fullName]; }) },
      { id: 'web', title: 'Sites', items: Store.get('webLinks')
          .map(function (link) { return items['web:' + link.url]; }) }
    ]).filter(function (row) { return row.items.length || row.empty; });

    // Keep each row's horizontal position across rebuilds.
    var old = {};
    rows.forEach(function (row) { old[row.id] = row; });
    next.forEach(function (row) {
      var prev = old[row.id] || {};
      row.col = Math.min(prev.col || 0, Math.max(0, row.items.length - 1));
      row.shift = prev.shift || 0;
    });

    var activeId = rows[rowIndex] ? rows[rowIndex].id : null;
    rows = next;
    rowIndex = 0;
    rows.forEach(function (row, i) { if (row.id === activeId) rowIndex = i; });
    if (!rows[rowIndex].items.length) rowIndex = firstFocusableRow(rowIndex, 1);
  }

  // One row per category, or a single "Apps" row when grouping is off.
  // If the TV's app list couldn't load, say how to get it rather than hide it.
  function appRows(items, hidden) {
    if (!data.apps.length && Platform.appsError()) {
      return [{ id: 'apps', title: 'Apps', apps: true, items: [],
        empty: 'Seus apps aparecem quando o serviço do TVDeck estiver rodando. Abra o TVDeck pelo TizenBrew de novo.' }];
    }
    var visible = data.apps.filter(function (app) { return hidden.indexOf(app.id) === -1; });
    function toItems(apps) {
      return apps.map(function (app) { return items['app:' + app.id]; });
    }
    if (!Store.get('groupApps')) return [{ id: 'apps', title: 'Apps', apps: true, items: toItems(visible) }];
    return Categories.group(visible).map(function (group) {
      return { id: 'cat:' + group.name, title: Categories.label(group.name), apps: true, items: toItems(group.apps) };
    });
  }

  function firstFocusableRow(from, step) {
    for (var i = from; i >= 0 && i < rows.length; i += step) {
      if (rows[i].items.length) return i;
    }
    return rowIndex;
  }

  /* ---------- Rendering ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Icons seen before skip the fade, so re-rendering rows never flickers.
  var seenIcons = {};

  // App art when there is an icon (caption shows on focus, like tvOS);
  // otherwise a line icon with the name inside the tile.
  function renderTile(item) {
    var tile = el('div', 'tile');
    var art = el('div', 'tile-art');
    tile.appendChild(art);

    function showGlyph() {
      tile.classList.remove('has-art');
      art.innerHTML = '<div class="tile-glyph">' + Icons.svg(Icons.glyphFor(item)) + '</div>';
      art.appendChild(el('div', 'tile-label', item.name));
    }

    var src = Platform.iconUrl(item.icon);
    if (src) {
      tile.classList.add('has-art');
      var img = el('img', seenIcons[src] ? 'tile-icon loaded' : 'tile-icon');
      img.alt = '';
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        seenIcons[src] = true;
        img.classList.add('loaded');
        var color = Icons.sample(img);
        item.img = img;
        item.color = color;
        if (color && color.fullBleed) tile.classList.add('full-bleed');
        else if (color) art.style.backgroundColor = Icons.tileBackground(color);
        if (currentItem() === item) updateShelf();
      };
      img.onerror = function () {
        item.iconFailed = true;
        showGlyph();
        if (currentItem() === item) updateShelf();
      };
      img.src = src;
      art.appendChild(img);
    } else {
      showGlyph();
    }

    art.appendChild(el('div', 'tile-shine'));
    tile.appendChild(el('div', 'tile-caption', item.name));
    return tile;
  }

  var DAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  function eventWhen(event) {
    var d = new Date(event.start);
    var today = new Date();
    var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    var day = d.toDateString() === today.toDateString() ? 'Hoje'
      : d.toDateString() === tomorrow.toDateString() ? 'Amanhã' : DAY_SHORT[d.getDay()];
    return event.allDay ? day : day + ' ' + formatTime(d);
  }

  function renderGlance(item) {
    var card = el('div', 'tile glance-card glance-' + item.kind);
    if (item.kind === 'calendar') {
      card.appendChild(el('div', 'glance-title', 'Próximos 7 dias'));
      var list = el('div', 'glance-events');
      if (!item.events.length) list.appendChild(el('div', 'glance-dim', 'Nada nos próximos 7 dias'));
      item.events.slice(0, 3).forEach(function (event) {
        var line = el('div', 'glance-event');
        line.appendChild(el('span', 'glance-when', eventWhen(event)));
        line.appendChild(el('span', 'glance-what', event.title));
        list.appendChild(line);
      });
      card.appendChild(list);
    } else if (item.kind === 'media') {
      var entity = item.ref;
      card.appendChild(el('div', 'glance-title', (entity.state === 'playing' ? 'Tocando · ' : 'Pausado · ') + entity.name));
      card.appendChild(el('div', 'glance-big', entity.mediaTitle || entity.state));
      card.appendChild(el('div', 'glance-dim', entity.mediaArtist));
    } else {
      var e = item.ref;
      var on = e.state === 'on' || e.state === 'open' || e.state === 'unlocked';
      card.classList.toggle('is-on', on);
      card.appendChild(el('div', 'glance-title', e.name));
      card.appendChild(el('div', 'glance-big', e.state + (e.unit ? ' ' + e.unit : '')));
      if (HA_ACTIONABLE.indexOf(e.domain) !== -1) card.appendChild(el('div', 'glance-dim', 'OK para alternar'));
    }
    return card;
  }

  function render() {
    var inner = document.createDocumentFragment();

    rows.forEach(function (row, r) {
      var rowEl = el('section', 'row' + (row.featured ? ' dock' : '') + (row.glance ? ' glance' : ''));
      rowEl.style.setProperty('--r', Math.min(r, 4));
      if (!row.featured) rowEl.appendChild(el('h2', 'row-title', row.title));

      row.trackEl = null;
      if (!row.items.length) {
        rowEl.appendChild(el('div', 'row-empty', row.empty));
      } else {
        var track = el('div', 'row-track');
        row.items.forEach(function (item, i) {
          var tile = row.glance ? renderGlance(item) : renderTile(item);
          tile.style.setProperty('--i', Math.min(i, 6));
          tile.addEventListener('click', function () { clickTile(row, i); });
          track.appendChild(tile);
        });
        rowEl.appendChild(track);
        row.trackEl = track;
      }

      row.el = rowEl;
      inner.appendChild(rowEl);
    });

    els.rows.innerHTML = '';
    els.rows.appendChild(inner);
    els.rendered = true;
    updateFocus();
  }

  function updateFocus() {
    els.navButtons.forEach(function (btn, i) {
      btn.classList.toggle('focused', navFocus && mode === 'home' && i === navIndex);
    });
    rows.forEach(function (row, r) {
      var active = r === rowIndex && mode === 'home' && !navFocus;
      row.el.classList.toggle('active', active);
      if (!row.trackEl) return;
      var tiles = row.trackEl.children;
      for (var i = 0; i < tiles.length; i++) {
        tiles[i].classList.toggle('focused', active && i === row.col);
        tiles[i].classList.toggle('moving', active && moving && i === row.col);
      }
      // Slide the row only when the focused tile would leave the screen.
      var focusedTile = tiles[row.col];
      if (focusedTile) {
        var visible = row.trackEl.clientWidth - 2 * parseFloat(getComputedStyle(row.trackEl).paddingLeft);
        var left = focusedTile.offsetLeft - tiles[0].offsetLeft;
        var right = left + focusedTile.offsetWidth;
        row.shift = row.shift || 0;
        if (left < row.shift) row.shift = left;
        else if (right > row.shift + visible) row.shift = right - visible;
        row.trackEl.style.transform = 'translateX(' + (-row.shift) + 'px)';
      }
    });

    // The dock row shows the whole Top Shelf; further rows scroll it away,
    // in whole rows, only as far as needed to show the active row.
    var activeRow = rows[rowIndex];
    if (activeRow && els.rendered) {
      var pageTop = els.page.getBoundingClientRect().top;
      var topOf = function (r) { return rows[r].el.getBoundingClientRect().top - pageTop; };
      // Leave room for the fixed top bar above and the hints below.
      var margin = window.innerWidth * 0.07;
      var viewH = window.innerHeight - window.innerWidth * 0.045;
      var rowTop = topOf(rowIndex);
      var rowBottom = rowTop + activeRow.el.offsetHeight;
      if (rowIndex === 0 || navFocus) {
        scrollY = 0;
      } else if (rowTop - margin < scrollY) {
        scrollY = rowTop - margin;
      } else if (rowBottom > scrollY + viewH) {
        for (var r = 1; r <= rowIndex; r++) {
          var top = topOf(r) - margin;
          if (rowBottom - top <= viewH) { scrollY = top; break; }
        }
      }
      els.page.style.transform = 'translateY(' + (-scrollY) + 'px)';
      document.body.classList.toggle('scrolled', scrollY > 0);
    }
    updateShelf();
    renderHints();
  }

  /* ---------- Top Shelf ---------- */

  function hostOf(url) {
    return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }

  function timeAgo(ms) {
    var min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return 'há ' + min + ' min';
    var h = Math.round(min / 60);
    if (h < 24) return 'há ' + h + (h === 1 ? ' hora' : ' horas');
    var d = Math.round(h / 24);
    return d === 1 ? 'ontem' : 'há ' + d + ' dias';
  }

  function withOpened(item, text) {
    var at = Store.get('openedAt')[item.key];
    return at ? text + ' · Aberto ' + timeAgo(at) : text;
  }

  function describe(item) {
    switch (item.kind) {
      case 'app': return withOpened(item, item.category === 'Other' ? 'App' : Categories.label(item.category));
      case 'mod': return withOpened(item, 'Módulo TizenBrew');
      case 'web': return withOpened(item, hostOf(item.ref.url));
      case 'key': return withOpened(item, item.ref.key === 'KEY_TV' ? 'TV aberta' : 'Entrada · ' + item.ref.key.replace('KEY_', ''));
      case 'tool': return item.ref === 'phone' ? 'Escaneie o código para mandar links do celular' : 'Início, widgets e layout';
      case 'calendar': return 'Sua agenda';
      case 'media': return item.ref.mediaTitle ? item.ref.mediaTitle + (item.ref.mediaArtist ? ' · ' + item.ref.mediaArtist : '') : item.ref.state;
      case 'ha': return item.ref.state + (item.ref.unit ? ' ' + item.ref.unit : '');
    }
    return '';
  }

  var washIndex = 0;
  var washKey = null;

  // Paints a gradient from the focused art's average color into a 16x9
  // canvas; upscaled to full screen it is a soft wash for almost no GPU cost.
  function setWash(item) {
    // Art still loading: keep the current wash rather than flashing to black.
    if (item && !item.color && item.icon && !item.iconFailed) return;
    var key = item && item.color ? item.key : null;
    if (key === washKey) return;
    washKey = key;
    var next = els.washes[1 - washIndex];
    var ctx = next.getContext('2d');
    ctx.clearRect(0, 0, 16, 9);
    if (key) {
      // Dimmed, so white or pale logos tint the sea instead of washing it grey.
      var src = item.color;
      var light = (src.r + src.g + src.b) / 3;
      var k = light > 170 ? 0.32 : 0.55;
      var c = { r: Math.round(src.r * k), g: Math.round(src.g * k), b: Math.round(src.b * k) };
      var gradient = ctx.createLinearGradient(0, 0, 16, 9);
      gradient.addColorStop(0, 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')');
      gradient.addColorStop(0.55, Icons.tileBackground(c));
      gradient.addColorStop(1, Icons.shiftHue(c, 38, 0.5));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 16, 9);
    }
    next.style.opacity = key ? '1' : '0';
    els.washes[washIndex].style.opacity = '0';
    washIndex = 1 - washIndex;
  }

  /* ---------- Motion helpers ---------- */

  // Restarts a CSS animation class on an element.
  function replay(node, className) {
    node.classList.remove(className);
    void node.offsetWidth; // force reflow so the animation starts over
    node.classList.add(className);
  }

  // Shows a layer, then lets its CSS transition run from the .is-out state.
  function animateIn(node) {
    clearTimeout(node.outTimer);
    node.hidden = false;
    node.classList.add('is-out');
    void node.offsetWidth;
    node.classList.remove('is-out');
  }

  function animateOut(node, ms) {
    node.classList.add('is-out');
    clearTimeout(node.outTimer);
    node.outTimer = setTimeout(function () {
      node.hidden = true;
      node.classList.remove('is-out');
    }, ms || 320);
  }

  function focusedTile() {
    var row = rows[rowIndex];
    return row && row.trackEl ? row.trackEl.children[row.col] : null;
  }

  // Focus arriving from a direction carries a little momentum; hitting the
  // end of a row or the top/bottom bumps against it.
  var MOTION_CLASSES = ['nudge-left', 'nudge-right', 'nudge-up', 'nudge-down',
    'bump-left', 'bump-right', 'bump-up', 'bump-down'];

  function playMotion(name) {
    var tile = focusedTile();
    if (!tile) return;
    MOTION_CLASSES.forEach(function (c) { tile.classList.remove(c); });
    replay(tile, name);
  }

  function nudge(dir) { playMotion('nudge-' + dir); Sounds.play('move'); }
  function bump(dir) { playMotion('bump-' + dir); Sounds.play('edge'); }

  // Pointer: the first click focuses a tile, clicking it again opens it.
  function clickTile(row, col) {
    if (mode !== 'home' || moving) return;
    var r = rows.indexOf(row);
    if (r !== rowIndex || row.col !== col) {
      rowIndex = r;
      row.col = col;
      updateFocus();
      Sounds.play('move');
      return;
    }
    var item = currentItem();
    if (!item) return;
    pressFocused();
    Sounds.play('select');
    setTimeout(function () { open(item); }, 140);
  }

  function pressFocused() {
    var tile = focusedTile();
    if (!tile) return;
    tile.classList.add('pressed');
    setTimeout(function () { tile.classList.remove('pressed'); }, 120);
  }

  function updateShelf() {
    if (mode !== 'home' || document.body.classList.contains('ambient-on')) return;
    var row = rows[rowIndex];
    var item = currentItem();
    var title = item ? item.name : 'TVDeck';
    if (els.shelfTitle.textContent !== title) replay(els.shelfInfo, 'swap');
    els.shelfKind.textContent = navFocus ? 'TVDeck' : row ? row.title : '';
    els.shelfTitle.textContent = title;
    els.shelfMeta.textContent = item ? describe(item) : 'Aperte o VERMELHO em qualquer bloco para fixar nos Favoritos';
    setWash(item);
  }

  function hint(color, text) {
    return '<span class="hint"><span class="key ' + color + '"></span>' + text + '</span>';
  }

  function plainHint(text) {
    return '<span class="hint">' + text + '</span>';
  }

  function renderHints() {
    var row = rows[rowIndex];
    var item = currentItem();
    var parts = [];
    if (mode === 'settings') {
      var current = settingsItems[settingsIndex];
      parts.push(plainHint(settingsPage === 'root' ? 'OK para abrir · Voltar para fechar'
        : current && current.type === 'choice' ? 'Esquerda e direita para escolher · Voltar para retornar'
        : 'OK para alterar · Voltar para retornar'));
    } else if (mode === 'overlay') {
      parts.push(plainHint('Voltar para fechar'));
    } else if (navFocus) {
      parts.push(plainHint('OK para abrir · Baixo para seus apps'));
    } else if (moving) {
      parts.push(plainHint('Esquerda e direita para mover · OK para soltar'));
    } else {
      if (item && PINNABLE[item.kind]) {
        var pinned = Store.get('favorites').indexOf(item.key) !== -1;
        parts.push(hint('red', pinned ? 'Desafixar' : 'Fixar nos Favoritos'));
      }
      parts.push(hint('green', 'Ajustes'));
      if (row && row.id === 'favorites' && row.items.length > 1) parts.push(hint('yellow', 'Reordenar'));
      if (row && row.apps && item) parts.push(hint('yellow', 'Ocultar app'));
      parts.push(hint('blue', 'Atualizar'));
    }
    els.hints.innerHTML = parts.join('');
  }

  function currentItem() {
    if (navFocus) return NAV_ITEMS[navIndex];
    var row = rows[rowIndex];
    return row && row.items.length ? row.items[row.col] : null;
  }

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 2400);
  }

  /* ---------- Actions ---------- */

  var rowsDirty = false;      // Recent changed while an app was opening

  function rememberRecent(item) {
    var recent = Store.get('recent').filter(function (key) { return key !== item.key; });
    recent.unshift(item.key);
    Store.set('recent', recent.slice(0, MAX_RECENT));
    var openedAt = Store.get('openedAt');
    openedAt[item.key] = Date.now();
    Store.set('openedAt', openedAt);
    rowsDirty = true;
  }

  function rebuildIfDirty() {
    if (!rowsDirty || mode !== 'home') return;
    rowsDirty = false;
    buildRows();
    render();
  }

  function open(item) {
    if (PINNABLE[item.kind]) rememberRecent(item);
    switch (item.kind) {
      case 'app':
        Platform.launchApp(item.ref.id).catch(function () { toast('Não foi possível abrir ' + item.name); });
        break;
      case 'mod':
        Platform.launchModule(item.ref);
        break;
      case 'web':
        // TVDeck's page has no address bar or back button: use the TV browser.
        Platform.openInBrowser(item.ref.url).catch(function () { toast('Não foi possível abrir ' + item.name); });
        break;
      case 'key':
        Platform.sendKey(item.ref.key)
          .then(function () { toast('Mudando para ' + item.name); })
          .catch(function () {
            // Without the service, TV ao vivo can still open the TV's own viewer app.
            if (item.ref.key !== 'KEY_TV') return toast('Serviço do TVDeck não está rodando');
            Platform.launchApp('org.tizen.tv-viewer')
              .then(function () { toast('Abrindo ' + item.name); })
              .catch(function () { toast('Serviço do TVDeck não está rodando'); });
          });
        break;
      case 'ha':
      case 'media':
        if (HA_ACTIONABLE.indexOf(item.ref.domain) === -1) break;
        Platform.service('/api/ha/action', { entity_id: item.ref.id })
          .then(function () { setTimeout(loadGlance, 600); })
          .catch(function (err) { toast(err.message); });
        break;
      case 'tool':
        if (item.ref === 'phone') showOverlay({ type: 'phone' });
        else openSettings();
        break;
    }
    // Rebuilding now would flash the rows just as the app opens; do it once
    // we are visible again (or shortly after, when nothing actually left).
    if (PINNABLE[item.kind]) setTimeout(rebuildIfDirty, Platform.isTV ? 2500 : 700);
  }

  function togglePin(item) {
    if (!PINNABLE[item.kind]) return;
    var pinned = Store.toggleIn('favorites', item.key);
    toast(pinned ? item.name + ' fixado' : item.name + ' desafixado');
    buildRows();
    render();
  }

  function hideApp(item) {
    Store.toggleIn('hiddenApps', item.ref.id);
    toast(item.name + ' oculto · restaure em Ajustes');
    buildRows();
    render();
  }

  function moveFavorite(step) {
    var row = rows[rowIndex];
    var to = row.col + step;
    if (to < 0 || to >= row.items.length) return;
    var favorites = row.items.map(function (item) { return item.key; });
    var moved = favorites.splice(row.col, 1)[0];
    favorites.splice(to, 0, moved);
    Store.set('favorites', favorites);
    row.col = to;
    buildRows();
    render();
  }

  /* ---------- Data loading ---------- */

  function ignore() { return null; }

  function loadInputs() {
    return Platform.service('/api/inputs').then(function (res) {
      return res.inputs;
    }, function () {
      return Platform.isTV ? [] : DESKTOP_INPUTS;
    });
  }

  function loadGlance() {
    return Promise.all([
      Platform.service('/api/calendar').catch(ignore),
      Platform.service('/api/ha/states').catch(ignore)
    ]).then(function (results) {
      data.calendar = results[0];
      data.ha = results[1] ? results[1].entities : [];
      var signature = JSON.stringify([data.calendar, data.ha]);
      if (signature === glanceSignature) return;
      glanceSignature = signature;
      if (loaded && mode !== 'settings') {
        buildRows();
        render();
      }
    });
  }

  function markLoaded() {
    if (loaded) return;
    loaded = true;
    rowIndex = firstFocusableRow(0, 1);
    clearTimeout(loadingTimer);
    document.body.classList.remove('loading');
    setTimeout(function () { document.body.classList.remove('booting'); }, 1800);
  }

  // Draw the home screen straight away from the last known apps; refresh()
  // replaces them a moment later.
  function paintFromCache() {
    var cache = Store.get('appsCache');
    if (!Platform.isTV || !cache || !cache.apps || !cache.apps.length) return;
    data.apps = cache.apps;
    data.inputs = cache.inputs || [];
    buildRows();
    markLoaded();
    render();
  }

  function refresh(announce) {
    lastRefresh = Date.now();
    // TizenBrew can take seconds to list modules; don't hold the home
    // screen for it. That row fills in when the list arrives.
    Platform.listModules().then(function (modules) {
      data.modules = modules;
      if (loaded && mode === 'home') {
        buildRows();
        render();
      }
    });
    return Promise.all([
      Platform.listApps(),
      loadInputs(),
      Platform.service('/api/tizenbrew').catch(ignore)
    ]).then(function (results) {
      data.apps = results[0];
      data.inputs = results[1];
      data.tizenbrew = results[2];
      if (data.apps.length) Store.set('appsCache', { apps: data.apps, inputs: data.inputs });
      rowsDirty = false;
      buildRows();
      markLoaded();
      render();
      loadGlance();
      if (announce) toast('Atualizado');
    });
  }

  // Phone messages arrive through the service; poll slowly when it is down.
  function pollInbox() {
    Platform.service('/api/inbox').then(function (res) {
      res.items.forEach(function (item) { messages.push(item); });
      showNextMessage();
      setTimeout(pollInbox, 2000);
    }, function () {
      setTimeout(pollInbox, 15000);
    });
  }

  /* ---------- Overlays ---------- */

  // A shortcut sent from the phone page: saved on the TV and pinned to Favorites.
  function addShortcut(item) {
    var url = item.value;
    var name = item.name || hostOf(url);
    var links = Store.get('webLinks').filter(function (l) { return l.url !== url; });
    Store.set('webLinks', links.concat([{ name: name, url: url }]));
    var favs = Store.get('favorites').filter(function (k) { return k !== 'web:' + url; });
    Store.set('favorites', favs.concat(['web:' + url]));
    toast('Atalho ' + name + ' adicionado aos Favoritos');
    if (loaded) { buildRows(); render(); }
  }

  function showNextMessage() {
    while (messages.length && messages[0].type === 'shortcut') addShortcut(messages.shift());
    if (mode !== 'home' || !messages.length) return;
    showOverlay({ type: 'message', item: messages.shift() });
  }

  function qrSvg(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  function showOverlay(next) {
    overlay = next;
    mode = 'overlay';
    var card = els.overlayCard;
    card.innerHTML = '';

    if (next.type === 'phone') {
      card.appendChild(el('h2', '', 'Enviar do celular'));
      var body = el('div', 'phone-body');
      var qrBox = el('div', 'qr');
      var info = el('div', 'phone-info');
      body.appendChild(qrBox);
      body.appendChild(info);
      card.appendChild(body);
      info.appendChild(el('p', '', 'Conectando ao serviço do TVDeck…'));

      Platform.service('/api/info').then(function (svc) {
        info.innerHTML = '';
        if (!svc.phoneUrl) throw new Error('Sem endereço de rede ainda');
        qrBox.innerHTML = qrSvg(svc.phoneUrl);
        info.appendChild(el('p', '', 'Escaneie com a câmera do celular no mesmo Wi-Fi, ou abra'));
        info.appendChild(el('p', 'phone-url', svc.phoneUrl.replace(/^http:\/\//, '').replace(/\/?\?.*/, '')));
        info.appendChild(el('p', '', 'PIN'));
        info.appendChild(el('p', 'phone-pin', svc.pin));
        info.appendChild(el('p', '', 'Mande links para a TV, renomeie as entradas e configure a agenda e o Home Assistant.'));
      }).catch(function () {
        qrBox.hidden = true;
        info.innerHTML = '';
        info.appendChild(el('p', '', 'O serviço do TVDeck não está rodando.'));
        info.appendChild(el('p', '', 'Abra o TVDeck pelo TizenBrew de novo para iniciá-lo.'));
      });
      next.buttons = [{ label: 'Pronto', action: function () {} }];
    } else if (next.type === 'exit') {
      card.appendChild(el('h2', '', 'Sair do TVDeck?'));
      card.appendChild(el('p', 'overlay-text', 'Você pode voltar quando quiser pelo app TizenBrew.'));
      next.buttons = [
        { label: 'Ficar', action: function () {} },
        { label: 'Sair', action: function () {
          if (!Platform.isTV) return toast('Na TV isso volta para a tela inicial da Samsung');
          Platform.exit().catch(function () { toast('Aperte o botão Home para sair'); });
        } }
      ];
    } else {
      var item = next.item;
      card.appendChild(el('h2', '', item.type === 'url' ? 'Link do seu celular' : 'Mensagem do seu celular'));
      card.appendChild(el('p', item.type === 'url' ? 'message-url' : 'message-text', item.value));
      next.buttons = item.type === 'url' ? [
        { label: 'Abrir no navegador', action: function () {
          Platform.openInBrowser(item.value).catch(function () { toast('Não foi possível abrir o link'); });
        } },
        { label: 'Abrir aqui', action: function () { Platform.openUrl(item.value); } },
        { label: 'Dispensar', action: function () {} }
      ] : [{ label: 'Dispensar', action: function () {} }];
    }

    // tvOS-style buttons: Left/Right to choose, OK to confirm, Back cancels.
    next.index = 0;
    var actions = el('div', 'overlay-actions');
    next.buttonEls = next.buttons.map(function (btn, i) {
      var b = el('div', 'overlay-btn', btn.label);
      b.addEventListener('click', function () { next.index = i; runOverlayButton(); });
      actions.appendChild(b);
      return b;
    });
    card.appendChild(actions);
    focusOverlayButton();

    document.body.classList.add('sheet-on');
    animateIn(els.overlay);
    updateFocus();
  }

  function closeOverlay() {
    document.body.classList.remove('sheet-on');
    Sounds.play('back');
    animateOut(els.overlay, 260);
    overlay = null;
    mode = 'home';
    updateFocus();
    showNextMessage();
  }

  function focusOverlayButton() {
    overlay.buttonEls.forEach(function (b, i) { b.classList.toggle('focused', i === overlay.index); });
  }

  function runOverlayButton() {
    var action = overlay.buttons[overlay.index].action;
    Sounds.play('select');
    closeOverlay();
    action();
  }

  function handleOverlayKey(key) {
    if (key === KEY.LEFT || key === KEY.RIGHT) {
      var next = overlay.index + (key === KEY.LEFT ? -1 : 1);
      if (next < 0 || next >= overlay.buttons.length) return Sounds.play('edge');
      overlay.index = next;
      focusOverlayButton();
      Sounds.play('move');
    } else if (key === KEY.ENTER) {
      runOverlayButton();
    } else if (key === KEY.BACK) {
      closeOverlay();
    }
  }

  /* ---------- Settings ---------- */

  // Settings are a short menu of pages (like tvOS): OK opens a page,
  // Back returns to the menu, Back again closes.
  var PAGES = {
    root: { title: 'Ajustes', subtitle: 'TVDeck', glyph: 'brand' },
    general: { title: 'Geral', subtitle: 'Relógio, clima e som', glyph: 'settings' },
    startup: { title: 'Inicialização', subtitle: 'O que abre quando a TV liga', glyph: 'tv' },
    phone: { title: 'Celular e widgets', subtitle: 'Links, entradas, agenda, Home Assistant', glyph: 'phone' },
    web: { title: 'Atalhos de sites', subtitle: 'Sites na sua tela inicial', glyph: 'web' },
    layout: { title: 'Layout', subtitle: 'Fileiras, tela de descanso e redefinir', glyph: 'app' }
  };

  var settingsPage = 'root';
  var rootIndex = 0;          // where the menu focus was before opening a page
  var webDraft = { name: '', url: '' };
  var resetArmed = false;     // "Reset everything" needs a second OK

  // Rows that can't be used are shown disabled with the reason in place of
  // the value, and focus skips them, instead of failing with a toast.
  function settingRow(label, value, action, disabledReason) {
    return { type: 'row', label: label, value: disabledReason || value, action: action, disabled: !!disabledReason };
  }

  function choice(label, options, value, onChange, disabled) {
    return { type: 'choice', label: label, options: options, value: value, onChange: onChange, disabled: !!disabled };
  }

  function note(text) {
    return { type: 'note', label: text };
  }

  function serviceRunning() {
    return !!data.tizenbrew;
  }

  function validUrl(text) {
    return /^(https?:\/\/)?[^\s.\/]+\.[^\s]{2,}$/i.test(text.trim());
  }

  var SOUND_NAMES = { soft: 'Suave', glass: 'Vidro', wood: 'Madeira' };

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function onOff(key) {
    return Store.get(key) ? 'Ligado' : 'Desligado';
  }

  function toggle(label, key, after, disabledReason) {
    return settingRow(label, onOff(key), function () {
      Store.set(key, !Store.get(key));
      if (after) after();
    }, disabledReason);
  }

  function link(page, value) {
    return { type: 'link', label: PAGES[page].title, value: value, page: page };
  }

  function tizenbrewState() {
    var tb = data.tizenbrew;
    return {
      tb: tb,
      autoOpen: !!tb && tb.autoLaunchModule === Platform.selfModuleName(),
      autoService: !!tb && tb.autoLaunchServiceList.indexOf(Platform.serviceModuleName()) !== -1
    };
  }

  var PAGE_BUILDERS = {
    root: function () {
      var st = tizenbrewState();
      var links = Store.get('webLinks').length;
      return [
        link('general', (Store.get('use24h') ? '24 horas' : '12 horas') + ' · ' + Store.get('city')),
        link('startup', st.tb ? (st.autoOpen ? 'Abre com o TizenBrew' : 'Manual') : 'Serviço parado'),
        link('phone', serviceRunning() ? 'QR code' : 'Serviço parado'),
        link('web', links + (links === 1 ? ' site' : ' sites')),
        link('layout', Store.get('groupApps') ? 'Por categoria' : 'Uma fileira')
      ];
    },

    general: function () {
      return [
        { type: 'input', label: 'Seu nome', value: Store.get('userName') || '', placeholder: 'Para a saudação',
          onSave: function (value) { Store.set('userName', value); tickClock(); } },
        settingRow('Relógio', Store.get('use24h') ? '24 horas' : '12 horas', function () {
          Store.set('use24h', !Store.get('use24h'));
          tickClock();
        }),
        toggle('Clima', 'showWeather', loadWeather),
        { type: 'input', label: 'Cidade', value: Store.get('city'), disabled: !Store.get('showWeather'),
          onSave: function (value) {
            if (!value) return;
            Store.set('city', value);
            tickClock();
            loadWeather();
          } },
        toggle('Sons da interface', 'sounds', function () {
          Sounds.setEnabled(Store.get('sounds'));
          Sounds.play('select');
        }),
        // Left/Right picks a style and plays it, so you choose by ear.
        choice('Estilo de som', Sounds.styles.map(function (name) { return [name, SOUND_NAMES[name] || capitalize(name)]; }),
          Store.get('soundStyle'), function (next) {
            Store.set('soundStyle', next);
            Sounds.setStyle(next);
            setTimeout(function () { Sounds.play('select'); }, 60);
          }, !Store.get('sounds'))
      ];
    },

    startup: function () {
      var st = tizenbrewState();
      var off = st.tb ? null : 'Desligado';
      var items = [
        settingRow('Abrir o TVDeck com o TizenBrew', st.autoOpen ? 'Ligado' : 'Desligado', function () {
          Platform.setAutoLaunch(!st.autoOpen);
          st.tb.autoLaunchModule = st.autoOpen ? '' : Platform.selfModuleName();
        }, off),
        settingRow('Iniciar serviço do celular ao ligar', st.autoService ? 'Ligado' : 'Desligado', function () {
          Platform.setServiceAutoLaunch(!st.autoService, st.tb.autoLaunchServiceList);
          var name = Platform.serviceModuleName();
          st.tb.autoLaunchServiceList = st.tb.autoLaunchServiceList.filter(function (n) { return n !== name; });
          if (!st.autoService) st.tb.autoLaunchServiceList.push(name);
        }, off)
      ];
      if (!st.tb) items.push(note('Liberados quando o serviço do TVDeck estiver rodando. Abra o TVDeck pelo app TizenBrew para iniciá-lo.'));
      return items;
    },

    phone: function () {
      var items = [
        settingRow('Configurar pelo celular', 'Mostrar QR code', function () {
          closeSettings();
          showOverlay({ type: 'phone' });
          return true;
        }, serviceRunning() ? null : 'Indisponível')
      ];
      if (!serviceRunning()) items.push(note('A página do celular vem do serviço do TVDeck. Abra o TVDeck pelo app TizenBrew para iniciá-lo.'));
      return items;
    },

    web: function () {
      var items = Store.get('webLinks').map(function (site, i) {
        return settingRow(site.name, 'Remover', function () {
          var links = Store.get('webLinks').slice();
          links.splice(i, 1);
          Store.set('webLinks', links);
          Store.set('favorites', Store.get('favorites').filter(function (key) { return key !== 'web:' + site.url; }));
          toast(site.name + ' removido');
        });
      });
      items.push({ type: 'section', label: 'Adicionar um site' });
      items.push({ type: 'input', label: 'Nome', value: webDraft.name, placeholder: 'Opcional',
        onInput: function (v) { webDraft.name = v; } });
      items.push({ type: 'input', label: 'URL', value: webDraft.url, placeholder: 'example.com',
        onInput: function (v) { webDraft.url = v; refreshAddRow(); } });
      // Enabled only once the URL looks like a site; the hint says what's missing.
      items.push({ type: 'row', id: 'add-site', label: 'Adicionar atalho', value: '', action: function () {
        var url = webDraft.url.trim();
        if (!/^https?:\/\//.test(url)) url = 'https://' + url;
        var name = webDraft.name.trim() || hostOf(url);
        Store.set('webLinks', Store.get('webLinks').concat([{ name: name, url: url }]));
        webDraft = { name: '', url: '' };
        toast(name + ' adicionado');
      } });
      return items;
    },

    layout: function () {
      var hiddenCount = Store.get('hiddenApps').length;
      var recentCount = Store.get('recent').length;
      return [
        toggle('Agrupar apps por categoria', 'groupApps'),
        toggle('Fileira de recentes', 'showRecent'),
        toggle('Fileira de entradas (HDMI)', 'showInputs'),
        toggle('Tela de descanso quando parada', 'ambient', noteActivity),
        settingRow('Limpar recentes', recentCount + (recentCount === 1 ? ' item' : ' itens'), function () {
          Store.set('recent', []);
          toast('Recentes limpos');
        }, recentCount ? null : 'Nada para limpar'),
        settingRow('Mostrar apps ocultos', hiddenCount + (hiddenCount === 1 ? ' app' : ' apps'), function () {
          Store.set('hiddenApps', []);
          toast('Todos os apps visíveis');
        }, hiddenCount ? null : 'Nenhum oculto'),
        { type: 'section', label: '' },
        // Destructive: the first OK arms it (the row says so), the second resets.
        { type: 'row', id: 'reset', danger: true,
          label: resetArmed ? 'Aperte OK de novo para redefinir' : 'Redefinir tudo',
          value: resetArmed ? '' : 'Favoritos, atalhos, ajustes',
          action: function () {
            if (!resetArmed) {
              resetArmed = true;
              clearTimeout(els.settings.resetTimer);
              els.settings.resetTimer = setTimeout(function () {
                resetArmed = false;
                if (mode === 'settings' && settingsPage === 'layout') renderSettings();
              }, 4000);
              return;
            }
            resetArmed = false;
            Store.reset();
            Sounds.setEnabled(Store.get('sounds'));
            Sounds.setStyle(Store.get('soundStyle'));
            tickClock();
            loadWeather();
            toast('Ajustes redefinidos');
          } }
      ];
    }
  };

  function renderSettings() {
    var page = PAGES[settingsPage];
    // The menu shows the TVDeck mark; pages show their own line icon.
    var brand = page.glyph === 'brand';
    els.settingsGlyph.classList.toggle('is-brand', brand);
    els.settingsGlyph.innerHTML = brand ? '<img src="img/mark-256.png" alt="">' : Icons.svg(page.glyph);
    els.settingsTitle.textContent = page.title;
    els.settingsSubtitle.textContent = page.subtitle;

    settingsItems = PAGE_BUILDERS[settingsPage]();
    els.settingsList.innerHTML = '';
    settingsItems.forEach(function (item) {
      var node;
      if (item.type === 'section') {
        node = el('div', 'setting-section', item.label);
      } else if (item.type === 'note') {
        node = el('div', 'setting-note', item.label);
      } else {
        node = el('div', 'setting' + (item.type === 'link' ? ' setting-link' : '') +
          (item.type === 'choice' ? ' setting-choice' : '') + (item.danger ? ' setting-danger' : ''));
        node.style.setProperty('--i', Math.min(els.settingsList.children.length, 14));
        node.appendChild(el('span', '', item.label));
        if (item.type === 'input') {
          var input = document.createElement('input');
          input.type = item.label === 'URL' ? 'url' : 'text';
          input.value = item.value;
          input.placeholder = item.placeholder || '';
          input.disabled = !!item.disabled;
          input.addEventListener('change', function () { if (item.onSave) item.onSave(input.value.trim()); });
          input.addEventListener('input', function () { if (item.onInput) item.onInput(input.value); });
          node.appendChild(input);
          item.input = input;
        } else if (item.type === 'choice') {
          var group = el('span', 'choice-options');
          item.optionEls = item.options.map(function (opt) {
            var o = el('span', 'choice-option' + (opt[0] === item.value ? ' selected' : ''), opt[1]);
            group.appendChild(o);
            return o;
          });
          node.appendChild(group);
        } else {
          item.valueEl = el('span', 'setting-value', item.value || '');
          node.appendChild(item.valueEl);
        }
        node.classList.toggle('is-disabled', !!item.disabled);
      }
      item.el = node;
      els.settingsList.appendChild(node);
    });
    bindSettingsPointer();
    refreshAddRow();
    if (!isSelectable(settingsIndex)) settingsIndex = nextSelectable(-1, 1);
    focusSetting();
  }

  // Pointer (desktop preview, or remotes with a pointer): clicking a row
  // focuses and activates it; clicking a selector option picks it.
  function bindSettingsPointer() {
    settingsItems.forEach(function (item, i) {
      if (!item.el || item.type === 'section' || item.type === 'note') return;
      item.el.addEventListener('click', function (e) {
        if (!isSelectable(i)) return;
        settingsIndex = i;
        focusSetting();
        if (item.type === 'choice') {
          var opt = item.optionEls.indexOf(e.target);
          if (opt !== -1) selectChoice(opt);
          return;
        }
        if (item.type === 'input') return item.input.focus();
        Sounds.play('select');
        activateSetting();
      });
    });
  }

  // Live-enables "Add shortcut" as the URL is typed, with a hint until valid.
  function refreshAddRow() {
    var add = settingsItems.filter(function (item) { return item.id === 'add-site'; })[0];
    if (!add) return;
    var url = webDraft.url.trim();
    add.disabled = !validUrl(url);
    add.el.classList.toggle('is-disabled', add.disabled);
    add.valueEl.textContent = !url ? 'Digite um endereço acima' : add.disabled ? 'Endereço ainda inválido' : hostOf(/^https?:/.test(url) ? url : 'https://' + url);
  }

  function selectChoice(index) {
    var item = settingsItems[settingsIndex];
    if (!item || item.type !== 'choice' || item.disabled) return;
    var current = item.options.map(function (o) { return o[0]; }).indexOf(item.value);
    if (index !== current) changeChoice(index - current);
  }

  // Left/Right stop at the ends; OK wraps around.
  function changeChoice(step, wrap) {
    var item = settingsItems[settingsIndex];
    if (!item || item.type !== 'choice' || item.disabled) return false;
    var values = item.options.map(function (o) { return o[0]; });
    var next = values.indexOf(item.value) + step;
    if (wrap) next = (next + values.length) % values.length;
    if (next < 0 || next >= values.length) return false;
    item.value = values[next];
    item.optionEls.forEach(function (o, i) { o.classList.toggle('selected', i === next); });
    item.onChange(item.value);
    return true;
  }

  function goToPage(page, back) {
    settingsPage = page;
    renderSettings();
    replay(els.settingsPanel, back ? 'page-back' : 'page-forward');
    replay(els.settingsSide, 'page-swap');
    renderHints();
  }

  function isSelectable(i) {
    var item = settingsItems[i];
    return !!item && item.type !== 'section' && item.type !== 'note' && !item.disabled;
  }

  function nextSelectable(from, step) {
    for (var i = from + step; i >= 0 && i < settingsItems.length; i += step) {
      if (isSelectable(i)) return i;
    }
    return from;
  }

  function focusSetting() {
    settingsItems.forEach(function (item, i) {
      if (item.el) item.el.classList.toggle('focused', i === settingsIndex);
    });
    // Glide the list so the focused row sits in the middle band of the panel.
    var node = settingsItems[settingsIndex] && settingsItems[settingsIndex].el;
    var panelH = els.settingsPanel.clientHeight;
    var listH = els.settingsList.offsetHeight;
    var target = node ? node.offsetTop + node.offsetHeight / 2 - panelH / 2 : 0;
    // Short pages sit centered; long ones keep the focused row mid-panel.
    var offset = listH <= panelH ? (listH - panelH) / 2 : Math.max(0, Math.min(target, listH - panelH));
    els.settingsList.style.transform = 'translateY(' + (-offset) + 'px)';
    renderHints();
  }

  function openSettings() {
    mode = 'settings';
    settingsPage = 'root';
    settingsIndex = 0;
    document.body.classList.add('sheet-on');
    animateIn(els.settings);
    replay(els.settings, 'opening');
    clearTimeout(els.settings.openTimer);
    els.settings.openTimer = setTimeout(function () { els.settings.classList.remove('opening'); }, 1000);
    renderSettings();
    updateFocus();
  }

  function closeSettings() {
    mode = 'home';
    document.body.classList.remove('sheet-on');
    animateOut(els.settings, 260);
    buildRows();
    render();
    showNextMessage();
  }

  // Moving off an armed reset cancels it.
  function disarmReset() {
    if (!resetArmed) return;
    resetArmed = false;
    var reset = settingsItems.filter(function (item) { return item.id === 'reset'; })[0];
    if (reset) {
      reset.el.firstChild.textContent = 'Redefinir tudo';
      reset.valueEl.textContent = 'Favoritos, atalhos, ajustes';
    }
  }

  // Back: page -> menu (focus restored), menu -> close.
  function settingsBack() {
    disarmReset();
    if (settingsPage === 'root') return closeSettings();
    settingsIndex = rootIndex;
    goToPage('root', true);
  }

  function activateSetting() {
    var item = settingsItems[settingsIndex];
    if (!item || item.disabled) return;
    if (item.type === 'choice') {
      changeChoice(1, true);
      return;
    }
    if (item.type === 'input') {
      item.input.focus();
      return;
    }
    if (item.type === 'link') {
      rootIndex = settingsIndex;
      settingsIndex = 0;
      goToPage(item.page, false);
      return;
    }
    // An action returning true has left the settings panel.
    if (item.action() !== true) renderSettings();
  }

  /* ---------- Clock & weather ---------- */

  var DAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
    'setembro', 'outubro', 'novembro', 'dezembro'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatTime(date) {
    var h = date.getHours();
    if (Store.get('use24h')) return pad(h) + ':' + pad(date.getMinutes());
    return (h % 12 || 12) + ':' + pad(date.getMinutes()) + (h < 12 ? ' AM' : ' PM');
  }

  function tickClock() {
    var now = new Date();
    els.clock.textContent = formatTime(now);
    els.date.textContent = DAYS[now.getDay()] + ', ' + now.getDate() + ' de ' + MONTHS[now.getMonth()];
    if (els.hello) els.hello.textContent = greeting();
    if (els.helloSub) els.helloSub.textContent = Store.get('city') || '';
    els.ambientClock.textContent = els.clock.textContent;
    els.ambientDate.textContent = els.date.textContent;
  }

  function loadWeather() {
    if (!Store.get('showWeather')) {
      els.weather.hidden = true;
      return;
    }
    Weather.fetchCurrent(Store.get('city')).then(function (w) {
      els.weatherTemp.textContent = w.temp + '°';
      els.weatherLabel.textContent = ' ' + w.label;
      if (els.weatherGlyph) els.weatherGlyph.textContent = w.glyph || '';
      if (els.weatherRange) els.weatherRange.textContent = w.max != null ? '↑' + w.max + '° ↓' + w.min + '°' : '';
      data.weather = w;
      els.weather.hidden = false;
    }).catch(function () {
      els.weather.hidden = true;
    });
  }

  /* ---------- Living details: shelf ticker, idle shimmer, ambient ---------- */

  function greeting() {
    var h = new Date().getHours();
    var name = Store.get('userName');
    var hello = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    return name ? hello + ', ' + name : hello;
  }

  function tickerLines() {
    var lines = [];
    var next = data.calendar && data.calendar.events[0];
    if (next) lines.push(eventWhen(next) + ' · ' + next.title);
    data.ha.forEach(function (e) {
      if (e.domain === 'media_player' && e.state === 'playing' && e.mediaTitle) {
        lines.push('Tocando · ' + e.mediaTitle + (e.mediaArtist ? ' — ' + e.mediaArtist : ''));
      }
    });
    if (data.weather) lines.push(data.weather.place + ' · ' + data.weather.label +
      (data.weather.wind != null ? ' · vento ' + data.weather.wind + ' km/h' : ''));
    // The greeting already sits under the top bar; here only as a fallback.
    if (!lines.length) lines.push(greeting());
    return lines;
  }

  var tickerIndex = 0;

  // Cycles the small status line under the clock, cross-fading each change.
  function rotateTicker() {
    var lines = tickerLines();
    tickerIndex = (tickerIndex + 1) % lines.length;
    var text = lines[tickerIndex];
    if (els.ticker.textContent !== text) {
      els.ticker.textContent = text;
      replay(els.ticker, 'tick');
    }
    els.ambientLine.textContent = lines[0];
  }

  var idleTimer = null;
  var ambientTimer = null;

  var calmTimer = null;

  function noteActivity() {
    document.body.classList.remove('idle');
    document.body.classList.remove('calm');
    clearTimeout(idleTimer);
    clearTimeout(ambientTimer);
    clearTimeout(calmTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, IDLE_MS);
    calmTimer = setTimeout(function () { document.body.classList.add('calm'); }, CALM_MS);
    if (Store.get('ambient')) ambientTimer = setTimeout(enterAmbient, AMBIENT_MS);
  }

  // Ambient: hide the launcher, show a large clock, and let the wash drift
  // through the colors of the dock's apps.
  var ambientCycle = null;

  function enterAmbient() {
    if (mode !== 'home') return noteActivity();
    // Only art with real color makes a good wash; skip near-black/white logos.
    var colored = [];
    rows.forEach(function (row) {
      row.items.forEach(function (item) {
        var c = item.color;
        if (!c || colored.indexOf(item) !== -1) return;
        if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 40) colored.push(item);
      });
    });
    var i = 0;
    function nextColor() {
      if (colored.length) setWash(colored[i++ % colored.length]);
    }
    animateIn(els.ambient);
    document.body.classList.add('ambient-on');
    rotateTicker();
    nextColor();
    clearInterval(ambientCycle);
    ambientCycle = setInterval(nextColor, 10000);
  }

  function exitAmbient() {
    clearInterval(ambientCycle);
    document.body.classList.remove('ambient-on');
    animateOut(els.ambient, 460);
    updateShelf();
    noteActivity();
  }

  /* ---------- Hold-to-scroll ---------- */

  // Remotes repeat arrows while held (often without e.repeat), so time them.
  var lastArrow = { key: 0, at: 0 };
  var fastTimer = null;

  function trackRepeat(key) {
    if (key < KEY.LEFT || key > KEY.DOWN) return;
    var now = Date.now();
    if (key === lastArrow.key && now - lastArrow.at < REPEAT_MS) {
      document.body.classList.add('fast');
    }
    lastArrow = { key: key, at: now };
    clearTimeout(fastTimer);
    fastTimer = setTimeout(function () { document.body.classList.remove('fast'); }, REPEAT_MS + 80);
  }

  /* ---------- Input ---------- */

  function handleInputKey(e, key) {
    // Typing in a settings field: only intercept keys that leave the field.
    if (key === KEY.ENTER || key === KEY.BACK || key === KEY.IME_DONE || key === KEY.IME_CANCEL) {
      e.preventDefault();
      document.activeElement.blur();
      return true;
    }
    if (key === KEY.UP || key === KEY.DOWN) {
      document.activeElement.blur();
      return false;
    }
    return true;
  }

  function handleHomeKey(key) {
    var row = rows[rowIndex];
    var item = currentItem();

    if (moving) {
      if (key === KEY.LEFT) moveFavorite(-1);
      else if (key === KEY.RIGHT) moveFavorite(1);
      else if (key === KEY.ENTER || key === KEY.YELLOW || key === KEY.BACK) {
        moving = false;
        updateFocus();
      }
      return;
    }

    if (navFocus) return handleNavKey(key);

    var before = rowIndex;
    switch (key) {
      case KEY.BACK:
        // Back first returns to the start of the dock, then asks to leave.
        var first = firstFocusableRow(0, 1);
        if (rowIndex !== first || row.col !== 0) {
          rowIndex = first;
          rows[first].col = 0;
          updateFocus();
          nudge('up');
        } else {
          showOverlay({ type: 'exit' });
        }
        break;
      case KEY.LEFT:
        if (row.col > 0) { row.col--; updateFocus(); nudge('left'); } else bump('left');
        break;
      case KEY.RIGHT:
        if (row.col < row.items.length - 1) { row.col++; updateFocus(); nudge('right'); } else bump('right');
        break;
      case KEY.UP:
      case KEY.CH_UP:
        rowIndex = firstFocusableRow(rowIndex - 1, -1);
        if (rowIndex === before) {
          // Above the dock is the top bar.
          navFocus = true;
          updateFocus();
          Sounds.play('move');
          break;
        }
        updateFocus();
        nudge('up');
        break;
      case KEY.DOWN:
      case KEY.CH_DOWN:
        rowIndex = firstFocusableRow(rowIndex + 1, 1);
        if (rowIndex === before) { bump('down'); break; }
        updateFocus();
        nudge('down');
        break;
      case KEY.ENTER:
        if (item) {
          pressFocused();
          Sounds.play('select');
          setTimeout(function () { open(item); }, 140);
        }
        break;
      case KEY.RED:
        if (item) togglePin(item);
        break;
      case KEY.GREEN:
        openSettings();
        break;
      case KEY.YELLOW:
        if (row.id === 'favorites' && row.items.length > 1) {
          moving = true;
          updateFocus();
        } else if (row.apps && item) {
          hideApp(item);
        }
        break;
      case KEY.BLUE:
        refresh(true);
        break;
    }
  }

  function handleNavKey(key) {
    switch (key) {
      case KEY.LEFT:
      case KEY.RIGHT:
        var next = navIndex + (key === KEY.LEFT ? -1 : 1);
        if (next < 0 || next >= NAV_ITEMS.length) return Sounds.play('edge');
        navIndex = next;
        updateFocus();
        Sounds.play('move');
        break;
      case KEY.DOWN:
      case KEY.BACK:
        navFocus = false;
        updateFocus();
        nudge('down');
        break;
      case KEY.UP:
        Sounds.play('edge');
        break;
      case KEY.ENTER:
        Sounds.play('select');
        open(NAV_ITEMS[navIndex]);
        break;
      case KEY.GREEN:
        openSettings();
        break;
    }
  }

  function handleSettingsKey(key) {
    switch (key) {
      case KEY.UP:
      case KEY.DOWN:
        var moved = nextSelectable(settingsIndex, key === KEY.UP ? -1 : 1);
        if (moved === settingsIndex) break;
        settingsIndex = moved;
        disarmReset();
        focusSetting();
        Sounds.play('move');
        break;
      case KEY.LEFT:
      case KEY.RIGHT:
        if (!changeChoice(key === KEY.LEFT ? -1 : 1)) Sounds.play('edge');
        break;
      case KEY.ENTER:
        Sounds.play('select');
        activateSetting();
        break;
      case KEY.BACK:
        Sounds.play('back');
        settingsBack();
        break;
      case KEY.GREEN:
        Sounds.play('back');
        closeSettings();
        break;
    }
  }

  document.addEventListener('keydown', function (e) {
    // Any key wakes the ambient screen and is swallowed.
    if (document.body.classList.contains('ambient-on')) {
      e.preventDefault();
      exitAmbient();
      return;
    }
    noteActivity();
    var key = e.keyCode;
    trackRepeat(key);
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';

    if (typing) {
      if (key === KEY.ESC) key = KEY.BACK;
      if (handleInputKey(e, key)) return;
    } else if (!Platform.isTV && DESKTOP_ALIASES[key]) {
      key = DESKTOP_ALIASES[key];
    }

    if (key === KEY.BACK) e.preventDefault();
    if (mode === 'settings') handleSettingsKey(key);
    else if (mode === 'overlay') handleOverlayKey(key);
    else handleHomeKey(key);
  });

  els.overlay.addEventListener('click', function (e) {
    if (e.target === els.overlay && mode === 'overlay') closeOverlay();
  });
  els.settings.addEventListener('click', function (e) {
    if (mode === 'settings' && (e.target === els.settings || e.target === els.settingsSide)) settingsBack();
  });

  window.addEventListener('resize', function () {
    if (els.rendered) updateFocus();
  });

  // Pick up newly installed apps when coming back from another app,
  // at most every 15 s (visibility can flicker while the TV switches apps).
  var lastRefresh = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    tickClock();
    noteActivity();
    if (Date.now() - lastRefresh > 15000) refresh(false);
    else rebuildIfDirty();
  });

  /* ---------- Boot ---------- */

  els.settingsGlyph.innerHTML = Icons.svg('settings');
  els.navButtons.forEach(function (btn, i) {
    btn.querySelector('.nav-icon').innerHTML = Icons.svg(btn.querySelector('.nav-icon').getAttribute('data-icon'));
    btn.addEventListener('click', function () {
      if (mode !== 'home') return;
      navFocus = true;
      navIndex = i;
      updateFocus();
      Sounds.play('select');
      open(NAV_ITEMS[i]);
    });
  });
  Sounds.setEnabled(Store.get('sounds'));
  Sounds.setStyle(Store.get('soundStyle'));
  Platform.registerKeys(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown']);
  tickClock();
  setInterval(tickClock, 5000);
  loadWeather();
  setInterval(loadWeather, 30 * 60 * 1000);
  setInterval(loadGlance, 30 * 1000);
  setInterval(rotateTicker, 6000);
  noteActivity();
  // The loading mark only shows if the first load takes noticeably long.
  var loadingTimer = setTimeout(function () {
    if (!loaded) document.body.classList.add('loading');
  }, 350);

  paintFromCache();
  // Probe the service first so app icons can be served through it.
  Platform.service('/api/info').catch(ignore).then(function () {
    refresh(false).then(rotateTicker);
    pollInbox();
  });
})();

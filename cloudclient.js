/*!
 * CloudClient 2.0 - a mod client for EaglercraftX in the browser
 * github.com/CLoudyIceOceaN/1.20
 *
 * The game is one compiled WASM blob with no mod loader inside it, so every
 * mod here works from OUTSIDE, through the doors the client leaves open:
 *   devicePixelRatio (render scale), the options blob in localStorage,
 *   the resource-pack filesystem in IndexedDB, keyboard/page events,
 *   and the page around the canvas.
 *
 * 2.0 adds: a designed homescreen with a Mods button, a mod store with
 * install animations, and a tighter corner panel. Installed store mods
 * appear in the panel next to the built-ins.
 */
(function () {
  'use strict';

  if (window.CloudClient) { window.CloudClient.toggle(); return; }

  var VERSION = '3.2.0';
  var CFG_KEY = 'cloudclient.cfg';
  var MODS_KEY = 'cloudclient.mods';
  var PACK_NAME = 'CloudClient-NoAnim';

  /* ============================== storage ============================== */

  function load(key, fb) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fb : v; }
    catch (e) { return fb; }
  }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var cfg = load(CFG_KEY, {});
  if (!cfg.mods) cfg.mods = {};            // id -> {on, s:{}}
  if (!cfg.installed) cfg.installed = {};  // storeId -> true
  function saveCfg() { store(CFG_KEY, cfg); }

  var userMods = load(MODS_KEY, []);
  function saveUserMods() { store(MODS_KEY, userMods); }

  var needsReload = false;

  /* ===================== the game, from outside ======================== */

  // The canvas hides inside a shadow root, and this walk touches every
  // element on the page - far too expensive for the once-per-frame callers.
  // Cache the hit and only re-walk when the cached canvas left the document.
  var canvasCache = null;
  function findCanvasSlow(root) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].tagName === 'CANVAS') return all[i];
      if (all[i].shadowRoot) { var c = findCanvasSlow(all[i].shadowRoot); if (c) return c; }
    }
    return null;
  }
  function findCanvas() {
    if (canvasCache && canvasCache.isConnected) return canvasCache;
    canvasCache = findCanvasSlow(document);
    return canvasCache;
  }

  var dprGetter = null;
  try {
    var d = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') ||
            Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio');
    if (d && d.get) dprGetter = d.get;
  } catch (e) {}
  var frozenDPR = window.devicePixelRatio || 1;
  function realDPR() {
    if (dprGetter) { try { return dprGetter.call(window) || 1; } catch (e) {} }
    return frozenDPR;
  }

  // Lying to the runtime before it lays itself out breaks the canvas size, so
  // the hook stays truthful until the game canvas exists.
  var armed = false, scale = 1;
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: function () { return armed ? Math.max(0.05, realDPR() * scale) : realDPR(); }
    });
  } catch (e) { console.warn('[CloudClient] devicePixelRatio is locked', e); }

  function pokeResize() { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }
  function setScaleNow(v) { scale = v; if (armed) pokeResize(); }

  var armWait = 0;
  (function waitForCanvas() {
    var c = findCanvas();
    if (c && c.clientWidth > 0) { setTimeout(function () { armed = true; pokeResize(); }, 400); return; }
    if (armWait++ < 2400) setTimeout(waitForCanvas, 150);
  })();

  /* --------------------------- options blob --------------------------- */

  function optionsKey() {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^_/.test(k) && /\.g$/.test(k)) return k;
    }
    return null;
  }
  function b64ToBytes(b64) {
    var s = atob(b64), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function bytesToB64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function gunzip(b64) {
    return new Response(new Blob([b64ToBytes(b64)]).stream()
      .pipeThrough(new DecompressionStream('gzip'))).text();
  }
  function gzip(text) {
    return new Response(new Blob([text]).stream()
      .pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
      .then(function (buf) { return bytesToB64(new Uint8Array(buf)); });
  }

  // All writes go through one queue - parallel read-modify-writes on the same
  // key wiped each other out (2 of 15 settings survived) before this existed.
  var optQueue = Promise.resolve();
  function updateGameOptions(update) {
    optQueue = optQueue
      .then(function () { return getGameOptions(); })
      .then(function (cur) { return writeGameOptions(update(cur) || {}); })
      .catch(function (e) { console.warn('[CloudClient] options update failed', e); });
    return optQueue;
  }
  function setGameOptions(over) { return updateGameOptions(function () { return over; }); }

  function writeGameOptions(over) {
    if (!over || !Object.keys(over).length) return Promise.resolve(true);
    if (typeof CompressionStream === 'undefined') return Promise.resolve(false);
    var key = optionsKey();
    var read = key ? gunzip(localStorage.getItem(key)) : Promise.resolve('');
    return read.then(function (text) {
      var lines = text ? text.split('\n') : [];
      var seen = {};
      for (var i = 0; i < lines.length; i++) {
        var c = lines[i].indexOf(':');
        if (c < 0) continue;
        var name = lines[i].slice(0, c);
        if (over.hasOwnProperty(name)) { lines[i] = name + ':' + over[name]; seen[name] = true; }
      }
      for (var o in over) if (!seen[o]) lines.push(o + ':' + over[o]);
      return gzip(lines.filter(Boolean).join('\n') + '\n');
    }).then(function (b64) {
      localStorage.setItem(key || '_eaglymc.g', b64);
      needsReload = true;
      refreshStat();
      return true;
    }).catch(function (e) { console.warn('[CloudClient] options write failed', e); return false; });
  }

  function getGameOptions() {
    var key = optionsKey();
    if (!key) return Promise.resolve({});
    return gunzip(localStorage.getItem(key)).then(function (text) {
      var out = {};
      text.split('\n').forEach(function (l) {
        var c = l.indexOf(':');
        if (c > 0) out[l.slice(0, c)] = l.slice(c + 1);
      });
      return out;
    }).catch(function () { return {}; });
  }

  /* ------------------------ resource pack door ------------------------ */

  var PACK_DB = '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_resourcePacks';
  var ANIMATED = ['water_still', 'water_flow', 'lava_still', 'lava_flow', 'fire_layer_0',
    'fire_layer_1', 'portal', 'sea_lantern', 'command_block', 'prismarine_rough',
    'repeating_command_block', 'chain_command_block', 'fire_0', 'fire_1', 'soul_fire_0',
    'soul_fire_1', 'nether_portal', 'magma', 'prismarine', 'kelp', 'kelp_plant', 'seagrass',
    'tall_seagrass_top', 'tall_seagrass_bottom', 'campfire_fire', 'campfire_log_lit',
    'soul_campfire_fire', 'blast_furnace_front_on', 'smoker_front_on', 'stonecutter_saw',
    'conduit', 'respawn_anchor_top', 'sculk', 'sculk_vein', 'sculk_sensor_tendril_active',
    'calibrated_sculk_sensor_input_side', 'crimson_stem', 'warped_stem', 'lantern',
    'soul_lantern', 'sea_pickle'];

  function openPackDB() {
    return new Promise(function (res) {
      var q;
      try { q = indexedDB.open(PACK_DB, 1); } catch (e) { res(null); return; }
      q.onupgradeneeded = function () {
        var db = q.result;
        if (!db.objectStoreNames.contains('filesystem')) {
          db.createObjectStore('filesystem', { keyPath: ['path'] });
        }
      };
      q.onsuccess = function () {
        var db = q.result;
        if (!db.objectStoreNames.contains('filesystem')) { db.close(); res(null); return; }
        res(db);
      };
      q.onerror = function () { res(null); };
      q.onblocked = function () { res(null); };
    });
  }

  function installNoAnimPack() {
    return openPackDB().then(function (db) {
      if (!db) return false;
      var enc = new TextEncoder();
      var freeze = enc.encode(JSON.stringify({ animation: { frames: [0], frametime: 2147483647 } }));
      var files = [{
        path: 'resourcepacks/' + PACK_NAME + '/pack.mcmeta',
        data: enc.encode(JSON.stringify({ pack: { pack_format: 1, description: 'CloudClient - frozen animations' } }))
      }];
      ANIMATED.forEach(function (n) {
        files.push({
          path: 'resourcepacks/' + PACK_NAME + '/assets/minecraft/textures/blocks/' + n + '.png.mcmeta',
          data: freeze
        });
      });
      return new Promise(function (res) {
        var tx = db.transaction('filesystem', 'readwrite');
        var os = tx.objectStore('filesystem');
        var manReq = os.get(['resourcepacks/manifest.json']);
        manReq.onsuccess = function () {
          var man = { resourcePacks: [] };
          try { if (manReq.result) man = JSON.parse(new TextDecoder().decode(manReq.result.data)); } catch (e) {}
          if (!man.resourcePacks) man.resourcePacks = [];
          man.resourcePacks = man.resourcePacks.filter(function (p) { return p.name !== PACK_NAME; });
          man.resourcePacks.push({ timestamp: Date.now(), name: PACK_NAME, folder: PACK_NAME, domains: ['minecraft'] });
          files.forEach(function (f) {
            os.put({ path: f.path, data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) });
          });
          os.put({ path: 'resourcepacks/manifest.json', data: enc.encode(JSON.stringify(man)).buffer });
        };
        tx.oncomplete = function () { db.close(); res(true); };
        tx.onerror = function () { db.close(); res(false); };
      });
    });
  }

  function selectPack(on) {
    return updateGameOptions(function (opts) {
      var list = [];
      try { list = JSON.parse(opts.resourcePacks || '[]'); } catch (e) {}
      list = list.filter(function (n) { return n !== PACK_NAME; });
      if (on) list.push(PACK_NAME);
      return { resourcePacks: JSON.stringify(list) };
    });
  }

  /* ------------------------------ X-ray -------------------------------- */
  // A real X-ray, the resource-pack way: give the boring blocks EMPTY models
  // so the game simply doesn't draw them, leaving ores and caves visible.
  // The pack lives in the game's IndexedDB filesystem like NoAnim does; the
  // twist is that toggling rewrites the model files in place and then presses
  // F3+T (the game's own resource reload), so X works without a restart.
  var XRAY_PACK = 'CloudClient-XRay';
  var XRAY_MODELS = ['stone', 'granite', 'smooth_granite', 'diorite', 'smooth_diorite',
    'andesite', 'smooth_andesite', 'dirt', 'coarse_dirt', 'podzol', 'grass_normal',
    'gravel', 'sand', 'red_sand', 'cobblestone', 'netherrack', 'stone_slab',
    'sandstone', 'chiseled_sandstone', 'smooth_sandstone'];

  function xraySetFiles(see) {
    return openPackDB().then(function (db) {
      if (!db) return false;
      var enc = new TextEncoder();
      var empty = enc.encode(JSON.stringify({ elements: [] }));
      return new Promise(function (res) {
        var tx = db.transaction('filesystem', 'readwrite');
        var os = tx.objectStore('filesystem');
        var manReq = os.get(['resourcepacks/manifest.json']);
        manReq.onsuccess = function () {
          var man = { resourcePacks: [] };
          try { if (manReq.result) man = JSON.parse(new TextDecoder().decode(manReq.result.data)); } catch (e) {}
          if (!man.resourcePacks) man.resourcePacks = [];
          man.resourcePacks = man.resourcePacks.filter(function (pk) { return pk.name !== XRAY_PACK; });
          man.resourcePacks.push({ timestamp: Date.now(), name: XRAY_PACK, folder: XRAY_PACK, domains: ['minecraft'] });
          os.put({ path: 'resourcepacks/' + XRAY_PACK + '/pack.mcmeta',
            data: enc.encode(JSON.stringify({ pack: { pack_format: 1, description: 'CloudClient X-ray' } })).buffer });
          XRAY_MODELS.forEach(function (n) {
            var path = 'resourcepacks/' + XRAY_PACK + '/assets/minecraft/models/block/' + n + '.json';
            if (see) os.put({ path: path, data: empty.buffer.slice(0) });
            else os.delete([path]);
          });
          os.put({ path: 'resourcepacks/manifest.json', data: enc.encode(JSON.stringify(man)).buffer });
        };
        tx.oncomplete = function () { db.close(); res(true); };
        tx.onerror = function () { db.close(); res(false); };
      });
    });
  }

  function selectXrayPack(on) {
    return updateGameOptions(function (opts) {
      var list = [];
      try { list = JSON.parse(opts.resourcePacks || '[]'); } catch (e) {}
      list = list.filter(function (n) { return n !== XRAY_PACK; });
      if (on) list.push(XRAY_PACK);
      return { resourcePacks: JSON.stringify(list) };
    });
  }

  function pressReload() {                    // the game's own F3+T
    sendKey('keydown', 'F3', 'F3', 114);
    setTimeout(function () {
      sendKey('keydown', 'KeyT', 't', 84);
      setTimeout(function () {
        sendKey('keyup', 'KeyT', 't', 84);
        sendKey('keyup', 'F3', 'F3', 114);
        setTimeout(function () {              // undo the chord's debug flip
          sendKey('keydown', 'F3', 'F3', 114);
          setTimeout(function () { sendKey('keyup', 'F3', 'F3', 114); }, 90);
        }, 250);
      }, 110);
    }, 130);
  }

  var xraySeeing = false;
  var xrayBusy = false;
  function xrayApplyFiles(see, announce) {
    if (xrayBusy) return;
    xrayBusy = true;
    xraySetFiles(see).then(function (ok) {
      xrayBusy = false;
      if (!ok) { toast('X-ray could not write its pack'); return; }
      xraySeeing = see;
      if (findCanvas()) {
        pressReload();
        if (announce) toast(see ? '\u26CF X-ray ON \u2014 reloading textures\u2026' : 'X-ray off \u2014 reloading\u2026');
      } else if (announce) {
        toast(see ? '\u26CF X-ray ready \u2014 it shows once you restart' : 'X-ray off');
      }
    });
  }
  function xrayFlip() { xrayApplyFiles(!xraySeeing, true); }

  /* ============================ mod registry =========================== */

  var mods = [];
  var CATS = { perf: 'Perf', play: 'Gameplay', visual: 'HUD', util: 'Extras', user: 'My Mods' };

  function register(m) {
    mods.push(m);
    if (!cfg.mods[m.id]) cfg.mods[m.id] = { on: !!m.def, s: {} };
    return m;
  }
  function modById(id) {
    for (var i = 0; i < mods.length; i++) if (mods[i].id === id) return mods[i];
    return null;
  }
  function isOn(id) { return !!(cfg.mods[id] && cfg.mods[id].on); }
  function settingsOf(m) {
    var saved = (cfg.mods[m.id] && cfg.mods[m.id].s) || {};
    var out = {};
    (m.settings || []).forEach(function (s) { out[s.id] = saved[s.id] === undefined ? s.def : saved[s.id]; });
    return out;
  }
  function applyMod(m) {
    try { if (m.apply) m.apply(isOn(m.id), settingsOf(m)); }
    catch (e) { console.warn('[CloudClient] mod "' + m.id + '" failed', e); }
  }
  function setMod(id, on) {
    cfg.mods[id].on = on; saveCfg();
    var m = modById(id);
    if (m) {
      applyMod(m);
      if (m.reload) needsReload = true;
      if (m.onToggle) { try { m.onToggle(on); } catch (e) {} }
    }
    renderMenu();
  }
  function setSetting(id, key, value, redraw) {
    cfg.mods[id].s[key] = value; saveCfg();
    var m = modById(id);
    if (m) { applyMod(m); if (m.reload) needsReload = true; }
    if (redraw === false) refreshStat(); else renderMenu();
  }

  /** A mod from the store only shows in the panel once installed. */
  function visible(m) { return !m.storeOnly || cfg.installed[m.storeOnly]; }

  /* ============================ built-in mods ========================== */
  /* These four are the EaglerSodium package. */

  register({
    id: 'renderscale', name: 'Render Scale', cat: 'perf', def: true,
    desc: 'Draws the game smaller and stretches it back out. Half scale = a quarter of the pixels. The biggest FPS win in a browser.',
    settings: [
      { id: 'scale', type: 'slider', label: 'Resolution', min: 25, max: 100, step: 5, def: 60, unit: '%' },
      { id: 'smooth', type: 'toggle', label: 'Smooth the stretch', def: true }
    ],
    apply: function (on, s) {
      if (!isOn('sodiumish')) setScaleNow(on ? Math.max(0.25, Math.min(1, s.scale / 100)) : 1);
      var c = findCanvas();
      if (c) c.style.setProperty('image-rendering', (on && s.smooth) ? 'auto' : 'pixelated', 'important');
    }
  });

  var VIDEO_PRESETS = {
    balanced: { renderDistance: '4', particles: '1', mipmapLevels: '0', entityShadows: 'true',
      renderClouds: 'fast', fancyGraphics: 'false', ao: '1', fxaa: '2', shaders: 'false',
      enableDynamicLights: 'false', connectedTexturesOF: '0', customSkyOF: 'false',
      smartLeavesOF: 'true', chunkFix: 'true', fog: 'true' },
    fast: { renderDistance: '3', particles: '1', mipmapLevels: '0', entityShadows: 'false',
      renderClouds: 'false', fancyGraphics: 'false', ao: '0', fxaa: '2', shaders: 'false',
      enableDynamicLights: 'false', connectedTexturesOF: '0', customSkyOF: 'false',
      customItemsOF: 'false', betterGrassOF: '0', smartLeavesOF: 'true', chunkFix: 'true', fog: 'true' },
    potato: { renderDistance: '2', particles: '2', mipmapLevels: '0', entityShadows: 'false',
      renderClouds: 'false', fancyGraphics: 'false', ao: '0', fxaa: '2', shaders: 'false',
      enableDynamicLights: 'false', connectedTexturesOF: '0', customSkyOF: 'false',
      customItemsOF: 'false', betterGrassOF: '0', smartLeavesOF: 'true',
      allowBlockAlternatives: 'false', chunkFix: 'true', fog: 'true', bobView: 'false',
      enableFNAWSkins: 'false' }
  };

  register({
    id: 'videotweaks', name: 'Fast Video Settings', cat: 'perf', def: true, reload: true,
    desc: 'Writes the heavy video options into the game before it starts. Keys, skin and sound are left alone.',
    settings: [
      { id: 'preset', type: 'select', label: 'Preset', def: 'fast', options: [
        { v: 'balanced', label: 'Balanced' }, { v: 'fast', label: 'Fast' }, { v: 'potato', label: 'Potato' } ] },
      { id: 'distance', type: 'slider', label: 'Render distance', min: 0, max: 8, step: 1, def: 0, unit: ' chunks',
        hint: '0 = leave it to the preset' }
    ],
    apply: function (on, s) {
      if (!on) return;
      var over = {}, base = VIDEO_PRESETS[s.preset] || VIDEO_PRESETS.fast;
      for (var k in base) over[k] = base[k];
      if (s.distance > 0) over.renderDistance = String(s.distance);
      setGameOptions(over);
    }
  });

  register({
    id: 'noanim', name: 'Freeze Animated Textures', cat: 'perf', def: true, reload: true,
    desc: 'Installs a tiny pack so water, lava, fire and portals stop being re-uploaded to the graphics chip every frame.',
    apply: function (on) {
      if (on) installNoAnimPack().then(function (ok) { if (ok) selectPack(true); });
      else selectPack(false);
    }
  });

  register({
    id: 'fpslimit', name: 'Frame Limit', cat: 'perf', def: false, reload: true,
    desc: 'Caps the frame rate so a hot Chromebook stays steadier.',
    settings: [
      { id: 'max', type: 'select', label: 'Limit', def: '60', options: [
        { v: '30', label: '30 fps' }, { v: '45', label: '45 fps' }, { v: '60', label: '60 fps' },
        { v: '120', label: '120 fps' }, { v: '260', label: 'Unlimited' } ] }
    ],
    apply: function (on, s) { if (on) setGameOptions({ maxFps: s.max }); }
  });

  /* ------------------------- store-only mods -------------------------- */

  var sodiumishOn = false, dynScale = 0.6;

  register({
    id: 'sodiumish', name: 'Sodiumish', cat: 'perf', def: false, storeOnly: 'sodiumish',
    desc: 'Dynamic resolution. Watches your real FPS and moves the render scale up and down by itself to hold a target - sharp when the game is easy, fast when it gets busy.',
    settings: [
      { id: 'target', type: 'select', label: 'Hold', def: '45', options: [
        { v: '30', label: '30 fps' }, { v: '45', label: '45 fps' }, { v: '60', label: '60 fps' } ] },
      { id: 'floor', type: 'slider', label: 'Never below', min: 25, max: 60, step: 5, def: 35, unit: '%' }
    ],
    apply: function (on) { sodiumishOn = on; if (!on) applyMod(modById('renderscale')); }
  });

  var fbActive = false;
  var fbFilterStr = '';

  // Shadow lift, not gamma: these curves pin black at black and white at
  // white, and pull the dark end up hard. Caves get bright; a sunny day
  // barely changes, which is what a real fullbright feels like.
  var FB_LEVELS = {
    1: { table: '0 0.4 0.62 0.82 1', sat: 1.06 },
    2: { table: '0 0.58 0.78 0.9 1', sat: 1.12 },
    3: { table: '0 0.7 0.86 0.95 1', sat: 1.16 }
  };

  register({
    id: 'fullbright', name: 'Fullbright', cat: 'play', def: false, storeOnly: 'fullbright',
    desc: 'Caves lit like daytime, instantly. On as soon as you enable it; the key switches it on and off while you play.',
    settings: [
      { id: 'key', type: 'select', label: 'Toggle key', def: 'KeyF', options: [
        { v: 'KeyF', label: 'F' }, { v: 'KeyG', label: 'G' }, { v: 'KeyH', label: 'H' } ] },
      { id: 'strength', type: 'select', label: 'Strength', def: '2', options: [
        { v: '1', label: 'Brighter caves' },
        { v: '2', label: 'Night vision' },
        { v: '3', label: 'Maximum' } ] }
    ],
    apply: function (on) {
      // Enabling the mod IS turning it on - no second key press needed.
      // The key just toggles it while you play.
      fbActive = on;
      fbApply();
      // Old versions set the game's own gamma to 100 (restart-based). Put it
      // back once, so this filter is the only thing controlling brightness.
      updateGameOptions(function (cur) {
        return cur.gamma === '100.0' ? { gamma: '1.0' } : {};
      });
    }
  });

  function fbApply() {
    var c = findCanvas();
    if (fbActive && isOn('fullbright')) {
      var lv = FB_LEVELS[String(settingsOf(modById('fullbright')).strength || 2)] || FB_LEVELS[2];
      var svg = document.getElementById('ccgamma-svg');
      if (svg) {
        svg.querySelectorAll('feFuncR,feFuncG,feFuncB').forEach(function (f) {
          f.setAttribute('type', 'table');
          f.setAttribute('tableValues', lv.table);
        });
        fbFilterStr = 'url(#ccgamma) saturate(' + lv.sat + ')';
      } else fbFilterStr = 'brightness(1.7) saturate(1.2)';   // fallback
    } else {
      fbFilterStr = '';
    }
    if (c) c.style.filter = fbFilterStr;
  }
  function fbToggle() {
    fbActive = !fbActive;
    fbApply();
    toast(fbActive ? '\uD83D\uDD06 Fullbright ON' : 'Fullbright off');
  }

  register({
    id: 'zoom', name: 'Zoom', cat: 'play', def: false, storeOnly: 'zoom',
    desc: 'Hold a key to zoom in, like OptiFine. Zooms the picture the game already drew.',
    settings: [
      { id: 'key', type: 'select', label: 'Hold', def: 'KeyC', options: [
        { v: 'KeyC', label: 'C' }, { v: 'KeyZ', label: 'Z' }, { v: 'KeyX', label: 'X' } ] },
      { id: 'power', type: 'slider', label: 'Zoom', min: 2, max: 4, step: 1, def: 2, unit: '×' }
    ],
    apply: function () {}
  });

  register({
    id: 'keystrokes', name: 'Keystrokes', cat: 'visual', def: false, storeOnly: 'keystrokes',
    desc: 'Shows your WASD, space and mouse buttons on screen while you play.',
    apply: function (on) { keysEl.style.display = on ? 'block' : 'none'; }
  });

  register({
    id: 'cps', name: 'CPS Counter', cat: 'visual', def: false, storeOnly: 'cps',
    desc: 'Clicks per second, counted for each mouse button.',
    apply: function (on) { cpsEl.style.display = on ? 'block' : 'none'; }
  });

  register({
    id: 'tnttimer', name: 'TNT Countdown', cat: 'play', def: false, storeOnly: 'tnttimer',
    desc: 'A 4-second fuse timer with a BOOM at zero. Press the key the moment the TNT is lit. (The game doesn\'t let outside code see its TNT, so the key is the trigger.)',
    settings: [
      { id: 'key', type: 'select', label: 'Start key', def: 'KeyV', options: [
        { v: 'KeyV', label: 'V' }, { v: 'KeyB', label: 'B' }, { v: 'KeyG', label: 'G' } ] }
    ],
    apply: function () {},
    onToggle: function (on) {
      if (on) toast('🧨 Press V when the TNT is lit');
    }
  });

  // The game's hitbox flag can only be flipped from inside a world, and it
  // resets every time the page loads. We track what we believe the flag is
  // and push it to match the switch whenever you're actually playing
  // (= the game has captured the mouse).
  var hbGameOn = false;

  function hbSync(quiet) {
    var want = isOn('hitboxes');
    if (want === hbGameOn) return;
    if (!document.pointerLockElement) {
      if (!quiet) toast(want ? '\uD83D\uDCE6 Hitboxes will show when you\'re in a world' : 'Hitboxes off');
      return;
    }
    pressHitboxes();
    hbGameOn = want;
    if (!quiet) toast(want ? '\uD83D\uDCE6 Hitboxes ON' : 'Hitboxes off');
  }

  register({
    id: 'hitboxes', name: 'Hitboxes', cat: 'play', def: false, storeOnly: 'hitboxes',
    desc: 'Boxes around every mob and player - the game\'s own hitbox view. Turns itself on the moment you\'re in a world.',
    settings: [
      { id: 'go', type: 'button', label: 'Fix it (if boxes are opposite of the switch)' }
    ],
    apply: function () {},
    onToggle: function () { hbSync(false); }
  });

  register({
    id: 'xray', name: 'X-Ray', cat: 'play', def: false, storeOnly: 'xray',
    desc: 'See ores and caves through the ground: the boring blocks stop being drawn. Press the key to flip it while you play. Takes a few seconds each flip (the game reloads its textures), and expect fewer FPS while it\'s on.',
    settings: [
      { id: 'key', type: 'select', label: 'Toggle key', def: 'KeyX', options: [
        { v: 'KeyX', label: 'X' }, { v: 'KeyJ', label: 'J' }, { v: 'KeyK', label: 'K' } ] }
    ],
    apply: function () {},
    onToggle: function (on) {
      selectXrayPack(on);
      xrayApplyFiles(on, true);
    }
  });

  /* --------------------------- other built-ins ------------------------ */

  register({
    id: 'skipcountdown', name: 'Skip Launch Countdown', cat: 'util', def: true,
    desc: 'Presses "Skip Countdown" for you.',
    apply: function (on) {
      if (!on) return;
      var tries = 0;
      (function press() {
        var b = document.getElementById('skipCountdown');
        if (b) { b.click(); return; }
        if (tries++ < 120) setTimeout(press, 100);
      })();
    }
  });

  register({
    id: 'gamehud', name: 'Game HUD', cat: 'visual', def: true, reload: true,
    desc: 'The client\'s own corner readouts.',
    settings: [
      { id: 'fps', type: 'toggle', label: 'FPS + chunks', def: true },
      { id: 'coords', type: 'toggle', label: 'Coordinates', def: true },
      { id: 'stats', type: 'toggle', label: 'Player stats', def: false },
      { id: 'clock', type: 'toggle', label: '24h clock', def: false }
    ],
    apply: function (on, s) {
      if (!on) return;
      setGameOptions({ hudFps: String(!!s.fps), hudCoords: String(!!s.coords),
        hudStats: String(!!s.stats), hud24h: String(!!s.clock) });
    }
  });

  register({
    id: 'perfhud', name: 'CloudClient Overlay', cat: 'visual', def: false,
    desc: 'FPS and the true drawing resolution, top-right.',
    apply: function (on) { hudEl.style.display = on ? 'block' : 'none'; }
  });

  register({
    id: 'watermark', name: 'Watermark', cat: 'visual', def: true,
    desc: 'The CloudClient tag in the corner.',
    apply: function (on) { markEl.style.display = on ? 'block' : 'none'; }
  });

  register({
    id: 'keepawake', name: 'Keep Screen Awake', cat: 'util', def: false,
    desc: 'Stops the screen dimming while you play.',
    apply: function (on) { if (on) requestWakeLock(); else releaseWakeLock(); }
  });

  register({
    id: 'title', name: 'Rename The Tab', cat: 'util', def: true,
    desc: 'Calls the tab CloudClient.',
    apply: function (on) { if (on) document.title = 'CloudClient ' + VERSION; }
  });

  var wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }
  function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && isOn('keepawake') && !wakeLock) requestWakeLock();
  });
  document.addEventListener('fullscreenchange', function () { ensureMounted(); });

  /* ============================== the store ============================ */

  var STORE = [
    { id: 'eaglersodium', icon: '⚡', name: 'EaglerSodium', by: 'CloudClient', tag: 'perf pack',
      desc: 'The original four: Render Scale, Fast Video Settings, Freeze Animated Textures and Frame Limit. The backbone of the client.',
      mods: ['renderscale', 'videotweaks', 'noanim', 'fpslimit'], preinstalled: true },
    { id: 'sodiumish', icon: '🧪', name: 'Sodiumish', by: 'CloudClient', tag: 'perf',
      desc: 'Dynamic resolution: holds a target FPS by trading sharpness for speed automatically, second by second. Use it instead of setting Render Scale by hand.',
      mods: ['sodiumish'] },
    { id: 'potatopack', icon: '🥔', name: 'Potato Pack', by: 'CloudClient', tag: 'perf pack',
      desc: 'One press for the weakest laptops: Potato video settings, 40% resolution, frozen animations, 30 fps cap.',
      mods: [], run: function () {
        setMod('renderscale', true); setSetting('renderscale', 'scale', 40);
        setMod('videotweaks', true); setSetting('videotweaks', 'preset', 'potato');
        setMod('noanim', true);
        setMod('fpslimit', true); setSetting('fpslimit', 'max', '30');
      } },
    { id: 'smoothpack', icon: '🧈', name: 'Smooth Pack', by: 'CloudClient', tag: 'perf pack',
      desc: 'The balanced setup: Fast video settings, 60% resolution, frozen animations, 60 fps cap. What most Chromebooks want.',
      mods: [], run: function () {
        setMod('renderscale', true); setSetting('renderscale', 'scale', 60);
        setMod('videotweaks', true); setSetting('videotweaks', 'preset', 'fast');
        setMod('noanim', true);
        setMod('fpslimit', true); setSetting('fpslimit', 'max', '60');
      } },
    { id: 'fullbright', icon: '🔆', name: 'Fullbright', by: 'CloudClient', tag: 'gameplay',
      desc: 'Caves lit like noon, instantly. Press F in game to switch it on and off - no restart.',
      mods: ['fullbright'] },
    { id: 'zoom', icon: '🔍', name: 'Zoom', by: 'CloudClient', tag: 'gameplay',
      desc: 'Hold C to zoom, like OptiFine. Pick the key and the power in the panel.',
      mods: ['zoom'] },
    { id: 'hitboxes', icon: '📦', name: 'Hitboxes', by: 'CloudClient', tag: 'gameplay',
      desc: 'The game\'s own hitbox view (F3+B), on a button in the panel. Boxes around every entity.',
      mods: ['hitboxes'] },
    { id: 'tnttimer', icon: '🧨', name: 'TNT Countdown', by: 'CloudClient', tag: 'gameplay',
      desc: 'A 4-second fuse timer on screen. You press V when the TNT is lit - the game won\'t tell outside code about its TNT, so the timing is yours.',
      mods: ['tnttimer'] },
    { id: 'xray', icon: '⛏️', name: 'X-Ray', by: 'CloudClient', tag: 'gameplay',
      desc: 'The classic. Stone, dirt and friends stop being drawn so ores and caves show through. X to toggle in game.',
      mods: ['xray'] },
    { id: 'keystrokes', icon: '⌨️', name: 'Keystrokes', by: 'CloudClient', tag: 'HUD',
      desc: 'WASD, space and mouse buttons drawn on screen, like every PvP client since forever.',
      mods: ['keystrokes'] },
    { id: 'cps', icon: '🖱️', name: 'CPS Counter', by: 'CloudClient', tag: 'HUD',
      desc: 'Live clicks-per-second for both mouse buttons.',
      mods: ['cps'] }
  ];

  if (!cfg.installed.eaglersodium) { cfg.installed.eaglersodium = true; saveCfg(); }

  function installStore(item, btn) {
    if (btn) { btn.classList.add('busy'); }
    setTimeout(function () {                       // long enough to read as work
      cfg.installed[item.id] = true; saveCfg();
      (item.mods || []).forEach(function (id) { setMod(id, true); });
      if (item.run) item.run();
      if (btn) {
        btn.classList.remove('busy');
        btn.classList.add('done');
        btn.textContent = 'Installed ✓';
      }
      setTimeout(renderStore, 700);
      renderMenu();
    }, 700);
  }
  function uninstallStore(item) {
    delete cfg.installed[item.id]; saveCfg();
    (item.mods || []).forEach(function (id) { setMod(id, false); });
    renderStore();
    renderMenu();
  }

  /* =============================== UI =================================== */

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  root.innerHTML = [
    '<style>',
    ':host,*{box-sizing:border-box}',
    '@keyframes ccfade{from{opacity:0}to{opacity:1}}',
    '@keyframes ccpop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
    '@keyframes ccdrift{0%{background-position:0 0}100%{background-position:480px 480px}}',
    '@keyframes ccspin{to{transform:rotate(360deg)}}',
    '@keyframes ccpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}',
    '.pill{position:fixed;bottom:8px;right:52px;height:38px;border:0;border-radius:10px;padding:0 14px;',
    '  background:rgba(13,17,23,.78);color:#7dd3fc;font:600 13px system-ui;cursor:pointer;',
    '  box-shadow:0 2px 10px rgba(0,0,0,.5);transition:transform .12s ease,background .12s}',
    '.pill:hover{background:rgba(13,17,23,.96);transform:scale(1.05)}',
    '.hidewhilelocked.locked{display:none}',
    '.btn{position:fixed;bottom:8px;right:8px;width:38px;height:38px;border:0;border-radius:10px;',
    '  background:rgba(13,17,23,.78);color:#7dd3fc;font-size:18px;line-height:38px;text-align:center;',
    '  cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.5);padding:0;transition:transform .12s ease,background .12s}',
    '.btn:hover{background:rgba(13,17,23,.96);transform:scale(1.08)}',
    '.mark{position:fixed;left:8px;bottom:6px;font:600 12px system-ui,sans-serif;color:#7dd3fc;',
    '  text-shadow:0 1px 3px #000;pointer-events:none;letter-spacing:.3px}',
    '.hud{position:fixed;right:8px;top:6px;text-align:right;font:600 12px/1.5 ui-monospace,monospace;',
    '  color:#7dd3fc;text-shadow:0 1px 3px #000;pointer-events:none;display:none}',
    '.keys{position:fixed;left:12px;bottom:64px;display:none;pointer-events:none}',
    '.keys .kr{display:flex;gap:3px;justify-content:center;margin-top:3px}',
    '.keys .k{width:30px;height:30px;border-radius:6px;background:rgba(13,17,23,.6);color:#e6edf3;',
    '  font:600 12px system-ui;display:flex;align-items:center;justify-content:center;transition:background .08s}',
    '.keys .k.w{width:46px}.keys .k.down{background:#0ea5e9;color:#04202e}',
    '.cps{position:fixed;left:12px;bottom:34px;display:none;font:600 12px ui-monospace,monospace;',
    '  color:#7dd3fc;text-shadow:0 1px 3px #000;pointer-events:none}',
    '.tnt{position:fixed;top:18%;left:50%;transform:translateX(-50%);display:none;',
    '  font:700 34px ui-monospace,monospace;color:#f87171;text-shadow:0 2px 8px #000;pointer-events:none}',
    '.toast{position:fixed;bottom:76px;left:50%;transform:translate(-50%,8px);opacity:0;pointer-events:none;',
    '  background:rgba(13,17,23,.92);color:#e6edf3;font:600 13px system-ui;padding:8px 16px;border-radius:20px;',
    '  border:1px solid rgba(125,211,252,.3);transition:opacity .2s,transform .2s}',
    '.toast.on{opacity:1;transform:translate(-50%,0)}',
    '@keyframes cccloud1{0%{transform:translateX(-18vw)}100%{transform:translateX(112vw)}}',
    '@keyframes cccloud2{0%{transform:translateX(112vw)}100%{transform:translateX(-22vw)}}',
    '@keyframes ccsplash{0%,100%{transform:rotate(-14deg) scale(1)}50%{transform:rotate(-14deg) scale(1.08)}}',
    '@keyframes ccstars{0%{opacity:.5}50%{opacity:1}100%{opacity:.5}}',
    '.home{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;',
    '  gap:12px;overflow:hidden;z-index:5;animation:ccfade .4s ease;',
    '  background:linear-gradient(180deg,#050b14 0%,#0a1a2e 34%,#153a5c 68%,#1f5c86 100%)}',
    '.home::before{content:"";position:absolute;inset:0 0 55% 0;opacity:.7;pointer-events:none;',
    '  background-image:radial-gradient(#e6edf3 1px,transparent 1px),radial-gradient(#7dd3fc 1px,transparent 1px);',
    '  background-size:90px 70px,140px 110px;background-position:10px 10px,50px 40px;animation:ccstars 4s ease infinite}',
    '.cloud{position:absolute;pointer-events:none;filter:blur(1px);opacity:.5}',
    '.cloud i{position:absolute;background:#dbeafe;border-radius:4px}',
    '.c1{top:16%;left:0;animation:cccloud1 70s linear infinite}',
    '.c2{top:32%;left:0;animation:cccloud2 95s linear infinite;opacity:.35;transform:scale(.7)}',
    '.c3{top:8%;left:0;animation:cccloud1 120s linear infinite;opacity:.25;transform:scale(1.3)}',
    '.home.hide{transition:opacity .45s ease;opacity:0;pointer-events:none}',
    '.hwrap{position:relative;display:flex;flex-direction:column;align-items:center;gap:12px}',
    '.splash{position:absolute;right:-70px;top:8px;color:#ffe14d;font:700 15px system-ui;',
    '  text-shadow:2px 2px 0 #3f3400;animation:ccsplash 1.6s ease infinite;pointer-events:none;white-space:nowrap}',
    '.chips{display:flex;gap:8px;margin-top:4px;position:relative;flex-wrap:wrap;justify-content:center}',
    '.chip{background:rgba(13,17,23,.55);border:1px solid rgba(125,211,252,.25);color:#9fc9e8;',
    '  font:600 11.5px system-ui;padding:5px 12px;border-radius:20px}',
    '.chip b{color:#7dd3fc}',
    '.hlogo{font:700 clamp(34px,8vw,64px)/1.1 system-ui,sans-serif;color:#e6edf3;letter-spacing:-.5px;',
    '  text-shadow:0 4px 30px rgba(125,211,252,.35);animation:ccpop .5s ease;position:relative}',
    '.hlogo b{color:#7dd3fc}',
    '.hsub{color:#94a3b8;font:14px system-ui;margin-bottom:12px;animation:ccpop .6s ease;position:relative}',
    '.hbtns{display:flex;gap:12px;animation:ccpop .7s ease;position:relative}',
    '.hplay{padding:14px 44px;border:0;border-radius:12px;font:700 17px system-ui;cursor:pointer;',
    '  background:linear-gradient(90deg,#0ea5e9,#38bdf8);color:#04202e;box-shadow:0 8px 30px rgba(14,165,233,.4);',
    '  transition:transform .12s ease,box-shadow .12s;animation:ccpulse 2.4s ease infinite}',
    '.hplay:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(14,165,233,.55)}',
    '.hmods{padding:14px 30px;border:1px solid rgba(125,211,252,.4);border-radius:12px;font:600 15px system-ui;',
    '  cursor:pointer;background:rgba(125,211,252,.08);color:#7dd3fc;transition:background .12s,transform .12s}',
    '.hmods:hover{background:rgba(125,211,252,.18);transform:translateY(-2px)}',
    '.hfoot{position:absolute;bottom:14px;color:#475569;font:12px system-ui}',
    '.store{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:6;',
    '  background:rgba(4,8,12,.72)}',
    '.store.on{display:flex;animation:ccfade .2s ease}',
    '.swin{width:min(680px,94vw);max-height:88vh;display:flex;flex-direction:column;border-radius:16px;',
    '  overflow:hidden;background:#0d1117;border:1px solid rgba(125,211,252,.2);',
    '  box-shadow:0 20px 60px rgba(0,0,0,.7);animation:ccpop .25s ease}',
    '.shead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.shead h2{margin:0;font:700 17px system-ui;color:#e6edf3;flex:1}',
    '.shead h2 b{color:#7dd3fc}',
    '.sx{border:0;background:#21262d;color:#e6edf3;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:14px}',
    '.sx:hover{background:#30363d}',
    '.sgrid{overflow-y:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}',
    '.scard{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 13px;background:rgba(255,255,255,.02);',
    '  display:flex;flex-direction:column;gap:7px;transition:transform .12s ease,border-color .12s;animation:ccpop .3s ease both}',
    '.scard:hover{transform:translateY(-2px);border-color:rgba(125,211,252,.35)}',
    '.srow{display:flex;align-items:center;gap:9px}',
    '.sicon{width:34px;height:34px;border-radius:9px;background:rgba(125,211,252,.1);display:flex;',
    '  align-items:center;justify-content:center;font-size:17px;flex:none}',
    '.sname{font:600 14px system-ui;color:#e6edf3}',
    '.sby{font:11px system-ui;color:#64748b}',
    '.stag{margin-left:auto;font:600 9.5px system-ui;letter-spacing:.06em;text-transform:uppercase;',
    '  color:#7dd3fc;background:rgba(125,211,252,.1);padding:3px 7px;border-radius:20px;flex:none}',
    '.sdesc{font:12px/1.5 system-ui;color:#8b949e;flex:1}',
    '.sinstall{align-self:flex-start;padding:7px 18px;border:0;border-radius:8px;cursor:pointer;',
    '  font:700 12px system-ui;background:linear-gradient(90deg,#0ea5e9,#38bdf8);color:#04202e;',
    '  transition:transform .12s,filter .12s;position:relative;min-width:86px}',
    '.sinstall:hover{transform:scale(1.04);filter:brightness(1.08)}',
    '.sinstall.busy{pointer-events:none;color:transparent}',
    '.sinstall.busy::after{content:"";position:absolute;inset:0;margin:auto;width:14px;height:14px;',
    '  border:2px solid #04202e;border-top-color:transparent;border-radius:50%;animation:ccspin .6s linear infinite}',
    '.sinstall.done{background:#238636;color:#fff;pointer-events:none;animation:ccpop .3s ease}',
    '.sun{padding:6px 12px;border:1px solid rgba(255,255,255,.15);border-radius:8px;',
    '  background:transparent;color:#8b949e;font:600 11px system-ui;cursor:pointer}',
    '.sun:hover{color:#f87171;border-color:#f87171}',
    '.sdone-row{display:flex;gap:8px;align-items:center}',
    '.sbadge{font:700 12px system-ui;color:#3fb950}',
    '.panel{position:fixed;right:0;top:0;bottom:0;width:min(330px,92vw);display:flex;',
    '  flex-direction:column;border-radius:14px 0 0 14px;overflow:hidden;background:rgba(13,17,23,.97);',
    '  border:1px solid rgba(125,211,252,.18);border-right:0;box-shadow:-12px 0 40px rgba(0,0,0,.55);',
    '  color:#e6edf3;font:13px/1.45 system-ui,sans-serif;',
    '  transform:translateX(105%);transition:transform .28s cubic-bezier(.2,.8,.25,1);pointer-events:none}',
    '.panel.on{transform:none;pointer-events:auto}',
    '.head{padding:9px 12px 7px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.head .trow{display:flex;align-items:center;gap:8px}',
    '.head h1{margin:0;font-size:15px;flex:1}',
    '.head h1 b{color:#7dd3fc}',
    '.head .sub{font-size:10.5px;color:#8b949e;margin-top:1px}',
    '.storebtn{border:1px solid rgba(125,211,252,.4);background:rgba(125,211,252,.1);color:#7dd3fc;',
    '  border-radius:7px;padding:4px 10px;font:600 11px system-ui;cursor:pointer;transition:background .12s}',
    '.storebtn:hover{background:rgba(125,211,252,.22)}',
    '.turbo{display:block;width:100%;margin-top:7px;padding:6px 0;border:0;border-radius:8px;',
    '  background:linear-gradient(90deg,#0ea5e9,#38bdf8);color:#04202e;font:700 12px system-ui;cursor:pointer;',
    '  transition:filter .12s}',
    '.turbo:hover{filter:brightness(1.1)}',
    '.tabs{display:flex;gap:2px;padding:6px 8px 0}',
    '.tab{flex:1;padding:5px 0;border:0;border-radius:7px 7px 0 0;background:transparent;color:#8b949e;',
    '  font:600 10.5px system-ui;cursor:pointer;transition:color .1s}',
    '.tab.sel{background:rgba(125,211,252,.12);color:#7dd3fc}',
    '.body{overflow-y:auto;padding:6px 8px 10px;flex:1;min-height:100px}',
    '.mod{border:1px solid rgba(255,255,255,.06);border-radius:9px;margin-bottom:5px;',
    '  background:rgba(255,255,255,.02);overflow:hidden;transition:border-color .12s}',
    '.mod.on{border-color:rgba(125,211,252,.3)}',
    '.mrow{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer}',
    '.mrow:hover{background:rgba(255,255,255,.03)}',
    '.mname{font:600 12.5px system-ui;flex:1}',
    '.mcaret{color:#475569;font-size:10px;transition:transform .15s}',
    '.mod.open .mcaret{transform:rotate(90deg)}',
    '.mmore{display:none;padding:0 10px 9px}',
    '.mod.open .mmore{display:block;animation:ccfade .15s ease}',
    '.mdesc{font:11.5px/1.5 system-ui;color:#8b949e;margin-bottom:7px}',
    '.sw{position:relative;width:32px;height:18px;border-radius:18px;background:#30363d;border:0;cursor:pointer;',
    '  flex:none;transition:background .15s}',
    '.sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#8b949e;transition:.15s}',
    '.sw.on{background:#0ea5e9}.sw.on i{left:16px;background:#04202e}',
    '.set{margin-bottom:7px}',
    '.set label{display:block;font-size:11px;color:#c9d1d9;margin-bottom:2px}',
    '.set label b{color:#7dd3fc}',
    '.set input[type=range]{width:100%;accent-color:#38bdf8}',
    '.set select{width:100%;padding:4px;border-radius:6px;background:#161b22;color:#e6edf3;',
    '  border:1px solid rgba(255,255,255,.12);font-size:11.5px}',
    '.setbtn{width:100%;padding:6px 0;border-radius:7px;border:1px solid rgba(125,211,252,.4);',
    '  background:rgba(125,211,252,.1);color:#7dd3fc;font:600 11.5px system-ui;cursor:pointer}',
    '.setbtn:hover{background:rgba(125,211,252,.2)}',
    '.chk{display:flex;align-items:center;gap:6px;font-size:11px;color:#c9d1d9;cursor:pointer;margin-bottom:4px}',
    '.hint{font-size:10px;color:#6e7681;margin-top:1px}',
    '.foot{padding:6px 8px;border-top:1px solid rgba(255,255,255,.07);display:flex;gap:5px}',
    '.foot button{flex:1;padding:6px 0;border-radius:7px;border:1px solid rgba(255,255,255,.12);',
    '  background:#21262d;color:#e6edf3;font-size:11px;cursor:pointer}',
    '.foot button:hover{background:#30363d}',
    '.reload{background:#0ea5e9;border-color:#0ea5e9;color:#04202e;font-weight:700}',
    '.add{width:100%;padding:7px 0;border-radius:8px;border:1px dashed rgba(125,211,252,.4);',
    '  background:transparent;color:#7dd3fc;font-size:11.5px;cursor:pointer;margin-bottom:7px}',
    'textarea,input.txt{width:100%;background:#0d1117;color:#e6edf3;border:1px solid rgba(255,255,255,.12);',
    '  border-radius:8px;padding:7px;font:12px ui-monospace,monospace;margin-bottom:6px}',
    'textarea{height:110px;resize:vertical}',
    '.mini{padding:5px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:#21262d;',
    '  color:#e6edf3;font-size:11px;cursor:pointer}',
    '.err{color:#f85149;font-size:11px;margin:0 10px 8px}',
    '.doc{font-size:10.5px;color:#8b949e;background:rgba(255,255,255,.03);border-radius:8px;padding:7px;margin-bottom:7px}',
    '.doc code{color:#7dd3fc;font-family:ui-monospace,monospace}',
    '.row{display:flex;gap:6px;align-items:center}',
    '</style>',
    '<div class="home" id="home">',
    '  <div class="cloud c1"><i style="left:0;top:8px;width:70px;height:16px"></i><i style="left:14px;top:0;width:34px;height:16px"></i></div>',
    '  <div class="cloud c2"><i style="left:0;top:8px;width:90px;height:18px"></i><i style="left:22px;top:0;width:40px;height:16px"></i></div>',
    '  <div class="cloud c3"><i style="left:0;top:10px;width:60px;height:14px"></i><i style="left:10px;top:0;width:30px;height:14px"></i></div>',
    '  <div class="hwrap">',
    '    <div class="hlogo">&#9729; Cloud<b>Client</b><span class="splash" id="splash"></span></div>',
    '    <div class="hsub">v' + VERSION + ' &middot; EaglyMC 1.20</div>',
    '    <div class="hbtns">',
    '      <button class="hplay" id="hplay">&#9654;&nbsp; Play</button>',
    '      <button class="hmods" id="hmods">&#128230; Mods</button>',
    '    </div>',
    '    <div class="chips" id="chips"></div>',
    '  </div>',
    '  <div class="hfoot">right shift opens the mod menu in game &middot; your worlds are untouched</div>',
    '</div>',
    '<div class="store" id="store">',
    '  <div class="swin">',
    '    <div class="shead"><h2>&#128230; Cloud<b>Client</b> Mods</h2><button class="sx" id="sx">&#10005;</button></div>',
    '    <div class="sgrid" id="sgrid"></div>',
    '  </div>',
    '</div>',
    '<div class="mark">&#9729; CloudClient</div>',
    '<div class="hud" id="hud"></div>',
    '<div class="keys" id="keys">',
    '  <div class="kr"><div class="k" data-k="KeyW">W</div></div>',
    '  <div class="kr"><div class="k" data-k="KeyA">A</div><div class="k" data-k="KeyS">S</div><div class="k" data-k="KeyD">D</div></div>',
    '  <div class="kr"><div class="k w" data-k="M0">LMB</div><div class="k w" data-k="M2">RMB</div></div>',
    '  <div class="kr"><div class="k" data-k="Space" style="width:96px">&#9141;</div></div>',
    '</div>',
    '<div class="cps" id="cpsbox"></div>',
    '<div class="tnt" id="tnt"></div>',
    '<div class="toast" id="toast"></div>',
    '<button class="pill" id="pill" title="Mod store (Ctrl+Shift+M)">&#128230; Mods</button>',
    '<button class="btn" id="open" title="CloudClient (Ctrl+Shift+C)">&#9729;</button>',
    '<div class="panel" id="panel">',
    '  <div class="head">',
    '    <div class="trow"><h1>&#9729; <b>CloudClient</b></h1>',
    '      <button class="storebtn" id="storebtn">&#128230; Mods</button>',
    '      <button class="sx" id="closeside" title="Close">&#10005;</button></div>',
    '    <div class="sub" id="stat">&nbsp;</div>',
    '    <button class="turbo" id="turbo">&#9889; TURBO</button>',
    '  </div>',
    '  <div class="tabs" id="tabs"></div>',
    '  <div class="body" id="body"></div>',
    '  <div class="foot">',
    '    <button id="reload" class="reload">Restart game</button>',
    '    <button id="reset">Reset all</button>',
    '  </div>',
    '</div>'
  ].join('');

  function $(sel) { return root.querySelector(sel); }

  var panel = $('#panel'), hudEl = $('#hud'), markEl = $('.mark');
  var keysEl = $('#keys'), cpsEl = $('#cpsbox'), tntEl = $('#tnt'), toastEl = $('#toast');
  var open = false, tab = 'perf', view = 'list', expanded = {};

  /* ------------------------------ home -------------------------------- */

  var homeEl = $('#home');

  var SPLASHES = ['Also try water!', 'Unlaggy!', 'Chromebook approved!', '100% cloud!',
    'Now with mods!', 'F for fullbright!', 'ssshhh, in class!', 'Faster than the bus!',
    'Right Shift!', 'Made by Colin!'];
  $('#splash').textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];

  (function fillChips() {
    var installed = Object.keys(cfg.installed || {}).length;
    var sc = settingsOf(modById('renderscale')).scale;
    $('#chips').innerHTML =
      '<span class="chip"><b>' + installed + '</b> mods installed</span>' +
      '<span class="chip">resolution <b>' + (isOn('renderscale') ? sc + '%' : 'full') + '</b></span>' +
      '<span class="chip"><b>0</b> things to download</span>';
  })();

  $('#hplay').onclick = function () {
    homeEl.classList.add('hide');
    setTimeout(function () { homeEl.style.display = 'none'; }, 500);
  };
  $('#hmods').onclick = function () { openStore(); };

  /* ------------------------------ store ------------------------------- */

  var storeEl = $('#store');
  function openStore() { storeEl.classList.add('on'); renderStore(); }
  $('#sx').onclick = function () { storeEl.classList.remove('on'); };
  storeEl.addEventListener('click', function (e) { if (e.target === storeEl) storeEl.classList.remove('on'); });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderStore() {
    var grid = $('#sgrid');
    grid.innerHTML = '';
    STORE.forEach(function (item, i) {
      var card = document.createElement('div');
      card.className = 'scard';
      card.style.animationDelay = (i * 40) + 'ms';
      var installed = !!cfg.installed[item.id];

      var row = document.createElement('div');
      row.className = 'srow';
      row.innerHTML = '<div class="sicon">' + item.icon + '</div>' +
        '<div><div class="sname">' + esc(item.name) + '</div><div class="sby">by ' + esc(item.by) + '</div></div>' +
        '<div class="stag">' + esc(item.tag) + '</div>';
      card.appendChild(row);

      var desc = document.createElement('div');
      desc.className = 'sdesc';
      desc.textContent = item.desc;
      card.appendChild(desc);

      if (!installed) {
        var b = document.createElement('button');
        b.className = 'sinstall';
        b.textContent = 'Install';
        b.onclick = function () { installStore(item, b); };
        card.appendChild(b);
      } else {
        var doneRow = document.createElement('div');
        doneRow.className = 'sdone-row';
        doneRow.innerHTML = '<span class="sbadge">✓ Installed</span>';
        if (!item.preinstalled) {
          var un = document.createElement('button');
          un.className = 'sun';
          un.textContent = 'Remove';
          un.onclick = function () { uninstallStore(item); };
          doneRow.appendChild(un);
        }
        card.appendChild(doneRow);
      }
      grid.appendChild(card);
    });
  }

  /* ------------------------------ panel -------------------------------- */

  function toggle(force) {
    open = force === undefined ? !open : force;
    panel.classList.toggle('on', open);
    if (open) {
      if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) {} }
      renderMenu();
    }
  }

  function refreshStat() {
    if (!open) return;
    var c = findCanvas();
    $('#stat').textContent = c
      ? (fps + ' fps · drawing ' + c.width + '×' + c.height)
      : 'waiting for the game…';
    $('#reload').style.display = needsReload ? 'block' : 'none';
  }

  function renderMenu() {
    if (!open) return;
    refreshStat();

    var tabs = $('#tabs');
    tabs.innerHTML = '';
    Object.keys(CATS).forEach(function (k) {
      var b = document.createElement('button');
      b.className = 'tab' + (tab === k ? ' sel' : '');
      b.textContent = CATS[k];
      b.onclick = function () { tab = k; view = 'list'; renderMenu(); };
      tabs.appendChild(b);
    });

    if (view === 'editor') return;

    var body = $('#body');
    body.innerHTML = '';
    if (tab === 'user') { renderUserTab(body); return; }
    mods.filter(function (m) { return m.cat === tab && visible(m); }).forEach(function (m) {
      body.appendChild(renderMod(m));
    });
  }

  function renderMod(m) {
    var on = isOn(m.id), s = settingsOf(m);
    var box = document.createElement('div');
    box.className = 'mod' + (on ? ' on' : '') + (expanded[m.id] ? ' open' : '');

    var row = document.createElement('div');
    row.className = 'mrow';
    row.innerHTML = '<span class="mcaret">▶</span><div class="mname">' + esc(m.name) + '</div>';
    var sw = document.createElement('button');
    sw.className = 'sw' + (on ? ' on' : '');
    sw.innerHTML = '<i></i>';
    sw.onclick = function (e) { e.stopPropagation(); setMod(m.id, !isOn(m.id)); };
    row.appendChild(sw);
    row.onclick = function () { expanded[m.id] = !expanded[m.id]; renderMenu(); };
    box.appendChild(row);

    var more = document.createElement('div');
    more.className = 'mmore';
    var desc = document.createElement('div');
    desc.className = 'mdesc';
    desc.textContent = m.desc;
    more.appendChild(desc);
    (m.settings || []).forEach(function (def) { more.appendChild(renderSetting(m, def, s[def.id])); });
    box.appendChild(more);
    return box;
  }

  function renderSetting(m, def, value) {
    var wrap = document.createElement('div');
    wrap.className = 'set';
    if (def.type === 'toggle') {
      var lab = document.createElement('label');
      lab.className = 'chk';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!value;
      cb.onchange = function () { setSetting(m.id, def.id, cb.checked); };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + def.label));
      wrap.appendChild(lab);
      return wrap;
    }
    if (def.type === 'button') {
      var btn = document.createElement('button');
      btn.className = 'setbtn';
      btn.textContent = def.label;
      btn.onclick = function () {
        if (m.id === 'hitboxes') { hbGameOn = !hbGameOn; hbSync(false); }
      };
      wrap.appendChild(btn);
      return wrap;
    }
    var label = document.createElement('label');
    if (def.type === 'slider') {
      label.innerHTML = esc(def.label) + ': <b>' +
        (def.id === 'distance' && !value ? 'preset' : esc(value) + esc(def.unit || '')) + '</b>';
    } else label.textContent = def.label;
    wrap.appendChild(label);

    if (def.type === 'slider') {
      var r = document.createElement('input');
      r.type = 'range'; r.min = def.min; r.max = def.max; r.step = def.step; r.value = value;
      r.oninput = function () {
        var v = Number(r.value);
        label.innerHTML = esc(def.label) + ': <b>' +
          (def.id === 'distance' && !v ? 'preset' : esc(v) + esc(def.unit || '')) + '</b>';
        setSetting(m.id, def.id, v, false);
      };
      wrap.appendChild(r);
    } else if (def.type === 'select') {
      var sel = document.createElement('select');
      def.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.v; opt.textContent = o.label; opt.selected = String(value) === String(o.v);
        sel.appendChild(opt);
      });
      sel.onchange = function () { setSetting(m.id, def.id, sel.value); };
      wrap.appendChild(sel);
    }
    if (def.hint) {
      var h = document.createElement('div');
      h.className = 'hint'; h.textContent = def.hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  /* ------------------------------ user mods ----------------------------- */

  var frameHooks = [];
  var overlayCount = 0;
  var api = {
    version: VERSION,
    canvas: findCanvas,
    log: function () { console.log.apply(console, ['[CloudClient]'].concat([].slice.call(arguments))); },
    setOptions: setGameOptions,
    getOptions: getGameOptions,
    setRenderScale: function (pct) { setSetting('renderscale', 'scale', Math.max(25, Math.min(100, pct))); },
    onFrame: function (fn) { frameHooks.push(fn); },
    overlay: function (html) {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:8px;bottom:' + (26 + overlayCount++ * 18) + 'px;' +
        'z-index:2147483646;font:12px system-ui,sans-serif;color:#cbd5e1;text-shadow:0 1px 2px #000;pointer-events:none';
      box.innerHTML = html;
      root.appendChild(box);
      return box;
    }
  };

  function runUserMod(m) {
    if (!m.on) return;
    try { new Function('cc', m.code)(api); m.error = null; }
    catch (e) {
      m.error = String(e && e.message ? e.message : e);
      console.warn('[CloudClient] user mod "' + m.name + '" crashed', e);
    }
  }

  function renderUserTab(body) {
    // First: everything installed from the store, so "what have I added?" has
    // one answer. Toggle here, remove from the store card.
    var installedItems = STORE.filter(function (it) { return cfg.installed[it.id]; });
    if (installedItems.length) {
      var head1 = document.createElement('div');
      head1.className = 'doc';
      head1.textContent = 'From the mod store:';
      body.appendChild(head1);
      installedItems.forEach(function (it) {
        var box = document.createElement('div');
        var itemOn = (it.mods || []).some(isOn) || !it.mods.length;
        box.className = 'mod' + (itemOn ? ' on' : '');
        var row = document.createElement('div');
        row.className = 'mrow';
        row.innerHTML = '<div class="mname">' + it.icon + ' ' + esc(it.name) + '</div>';
        if (it.mods && it.mods.length) {
          var sw = document.createElement('button');
          sw.className = 'sw' + (itemOn ? ' on' : '');
          sw.innerHTML = '<i></i>';
          sw.onclick = function (e) {
            e.stopPropagation();
            var turnOn = !itemOn;
            it.mods.forEach(function (id) { setMod(id, turnOn); });
          };
          row.appendChild(sw);
        } else {
          var tagEl = document.createElement('span');
          tagEl.className = 'hint';
          tagEl.textContent = 'settings pack';
          row.appendChild(tagEl);
        }
        row.onclick = function () { openStore(); };
        box.appendChild(row);
        body.appendChild(box);
      });
    }

    var head2 = document.createElement('div');
    head2.className = 'doc';
    head2.textContent = 'Written by you:';
    body.appendChild(head2);

    var doc = document.createElement('div');
    doc.className = 'doc';
    doc.innerHTML = 'A mod is JavaScript that runs at launch, with a helper <code>cc</code>: ' +
      '<code>cc.log()</code>, <code>cc.canvas()</code>, <code>cc.setRenderScale(50)</code>, ' +
      '<code>cc.setOptions({...})</code>, <code>cc.overlay(html)</code>, <code>cc.onFrame(fn)</code>. ' +
      'Only paste code you trust.';
    body.appendChild(doc);

    var add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+ Add a mod';
    add.onclick = function () { showEditor(null); };
    body.appendChild(add);

    userMods.forEach(function (m, i) {
      var box = document.createElement('div');
      box.className = 'mod' + (m.on ? ' on' : '');
      var row = document.createElement('div');
      row.className = 'mrow';
      row.innerHTML = '<div class="mname">' + esc(m.name) + '</div>';
      var edit = document.createElement('button');
      edit.className = 'mini'; edit.textContent = 'Edit';
      edit.onclick = function (e) { e.stopPropagation(); showEditor(i); };
      row.appendChild(edit);
      var del = document.createElement('button');
      del.className = 'mini'; del.textContent = 'Del';
      del.onclick = function (e) {
        e.stopPropagation();
        userMods.splice(i, 1); saveUserMods(); needsReload = true; renderMenu();
      };
      row.appendChild(del);
      var sw = document.createElement('button');
      sw.className = 'sw' + (m.on ? ' on' : '');
      sw.innerHTML = '<i></i>';
      sw.onclick = function (e) {
        e.stopPropagation();
        m.on = !m.on; saveUserMods(); needsReload = true;
        if (m.on) runUserMod(m);
        renderMenu();
      };
      row.appendChild(sw);
      box.appendChild(row);
      if (m.error) {
        var err = document.createElement('div');
        err.className = 'err';
        err.textContent = 'Error: ' + m.error;
        box.appendChild(err);
      }
      body.appendChild(box);
    });
  }

  function showEditor(index) {
    view = 'editor';
    var editing = index != null ? userMods[index] : { name: '', code: '' };
    var body = $('#body');
    body.innerHTML = '';

    var name = document.createElement('input');
    name.className = 'txt'; name.placeholder = 'Mod name'; name.value = editing.name;
    body.appendChild(name);

    var code = document.createElement('textarea');
    code.placeholder = "cc.log('hello');\ncc.overlay('<b>my mod is on</b>');";
    code.value = editing.code;
    body.appendChild(code);

    var row = document.createElement('div');
    row.className = 'row';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'mini'; saveBtn.textContent = 'Save';
    saveBtn.onclick = function () {
      var rec = { id: 'u' + Date.now(), name: name.value.trim() || 'Untitled mod', code: code.value, on: true };
      if (index != null) { userMods[index].name = rec.name; userMods[index].code = rec.code; }
      else userMods.push(rec);
      saveUserMods(); needsReload = true; tab = 'user'; view = 'list'; renderMenu();
    };
    row.appendChild(saveBtn);
    var fileBtn = document.createElement('button');
    fileBtn.className = 'mini'; fileBtn.textContent = 'Load .js';
    fileBtn.onclick = function () {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.js,text/javascript';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        f.text().then(function (t) {
          code.value = t;
          if (!name.value) name.value = f.name.replace(/\.js$/i, '');
        });
      };
      inp.click();
    };
    row.appendChild(fileBtn);
    var cancel = document.createElement('button');
    cancel.className = 'mini'; cancel.textContent = 'Cancel';
    cancel.onclick = function () { tab = 'user'; view = 'list'; renderMenu(); };
    row.appendChild(cancel);
    body.appendChild(row);
  }

  /* ------------------------------ buttons ------------------------------- */

  $('#open').onclick = function (e) { e.stopPropagation(); toggle(); };
  $('#pill').onclick = function (e) { e.stopPropagation(); openStore(); };
  $('#closeside').onclick = function () { toggle(false); };
  $('#storebtn').onclick = function () { openStore(); };

  // While the game has the mouse captured you can't click buttons anyway, so
  // get them out of the way; they come back the moment a menu opens.
  ['#pill', '#open'].forEach(function (sel) { $(sel).classList.add('hidewhilelocked'); });
  document.addEventListener('pointerlockchange', function () {
    var locked = !!document.pointerLockElement;
    root.querySelectorAll('.hidewhilelocked').forEach(function (el) {
      el.classList.toggle('locked', locked);
    });
    markEl.style.opacity = locked ? .55 : 1;
    // just started (or resumed) playing - make the game match the switches
    if (locked) setTimeout(function () { hbSync(true); }, 600);
  });
  $('#reload').onclick = function () { location.reload(); };
  $('#turbo').onclick = function () {
    setMod('renderscale', true); setSetting('renderscale', 'scale', 50);
    setMod('videotweaks', true); setSetting('videotweaks', 'preset', 'potato');
    setMod('noanim', true);
    setMod('fpslimit', true);
    needsReload = true;
    renderMenu();
  };
  $('#reset').onclick = function () {
    cfg = { mods: {}, installed: { eaglersodium: true } };
    mods.forEach(function (m) { cfg.mods[m.id] = { on: !!m.def, s: {} }; });
    saveCfg();
    mods.forEach(applyMod);
    needsReload = true; view = 'list';
    renderMenu();
  };

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault(); e.stopPropagation(); toggle();
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      e.preventDefault(); e.stopPropagation(); openStore();
    }
    // Right Shift = the mod menu, the way Resent does it. Left Shift stays
    // the game's sneak key.
    if (!e.repeat && (e.code === 'ShiftRight' || (e.key === 'Shift' && e.location === 2))) {
      // only from gameplay (or to close it again) - typing a capital in chat
      // with the right shift must not pop the menu
      if (document.pointerLockElement || open) {
        e.preventDefault(); e.stopPropagation(); toggle();
      }
    }
  }, true);

  /* =================== gameplay mods: live machinery ==================== */

  var zoomHeld = false;
  function zoomApply() {
    var c = findCanvas();
    if (!c) return;
    if (zoomHeld && isOn('zoom')) {
      var p = settingsOf(modById('zoom')).power || 2;
      c.style.transform = 'scale(' + p + ')';
      c.style.transformOrigin = '50% 50%';
    } else {
      c.style.transform = '';
    }
  }

  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1400);
  }

  var tntUntil = 0;
  function tntStart() {
    tntUntil = performance.now() + 4000;
    tntEl.style.display = 'block';
    tntEl.style.color = '#f87171';
  }

  // Hitboxes: replay the game's own F3+B chord as synthetic key events.
  // Verified in-world: the pig gets its box. This build does NOT suppress the
  // debug-screen toggle while chording, so a plain F3 tap afterwards flips the
  // debug screen back to where it was.
  function sendKey(type, code, key, keyCode) {
    var c = findCanvas();
    [c, window, document].forEach(function (t) {
      if (!t) return;
      var e = new KeyboardEvent(type, { code: code, key: key, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
      try { Object.defineProperty(e, 'keyCode', { value: keyCode }); } catch (x) {}
      try { Object.defineProperty(e, 'which', { value: keyCode }); } catch (x) {}
      try { t.dispatchEvent(e); } catch (x) {}
    });
  }
  function pressHitboxes() {
    sendKey('keydown', 'F3', 'F3', 114);
    setTimeout(function () {
      sendKey('keydown', 'KeyB', 'b', 66);
      setTimeout(function () {
        sendKey('keyup', 'KeyB', 'b', 66);
        sendKey('keyup', 'F3', 'F3', 114);
        // undo the debug-screen flip the chord caused
        setTimeout(function () {
          sendKey('keydown', 'F3', 'F3', 114);
          setTimeout(function () { sendKey('keyup', 'F3', 'F3', 114); }, 90);
        }, 250);
      }, 110);
    }, 130);
  }

  var keyEls = {};
  root.querySelectorAll('.k').forEach(function (el) { keyEls[el.getAttribute('data-k')] = el; });

  /** True when the event is the configured key. Some input paths deliver
   *  key events with an EMPTY e.code (seen for real: trusted events with
   *  code "" and only e.key set), so never match on code alone. */
  function isKey(e, want) {
    if (e.code && e.code === want) return true;
    if (!e.key) return false;
    if (want.slice(0, 3) === 'Key') return e.key.toLowerCase() === want.slice(3).toLowerCase();
    if (want === 'Space') return e.key === ' ';
    return e.key === want;
  }
  function evCode(e) {
    if (e.code) return e.code;
    if (e.key === ' ') return 'Space';
    if (e.key && e.key.length === 1) return 'Key' + e.key.toUpperCase();
    return e.key || '';
  }
  function markKey(code, down) {
    var el = keyEls[code];
    if (el) el.classList.toggle('down', down);
  }
  /** Mod hotkeys only fire while the game has the mouse captured - which is
   *  exactly "actually playing". Chat, sign editing, menus, the world-name
   *  box: they all release the mouse, so typing can never trip a hotkey. */
  function playing() { return !!document.pointerLockElement; }

  window.addEventListener('keydown', function (e) {
    if (playing()) {
      if (isOn('zoom') && isKey(e, settingsOf(modById('zoom')).key)) { zoomHeld = true; zoomApply(); }
      if (isOn('tnttimer') && isKey(e, settingsOf(modById('tnttimer')).key)) tntStart();
      if (isOn('fullbright') && !e.repeat && isKey(e, settingsOf(modById('fullbright')).key)) fbToggle();
      if (isOn('xray') && !e.repeat && isKey(e, settingsOf(modById('xray')).key)) {
        setMod('xray', true);          // already on; re-assert is harmless
        xrayFlip();
      }
    }
    markKey(evCode(e), true);
  }, true);
  window.addEventListener('keyup', function (e) {
    if (isKey(e, settingsOf(modById('zoom')).key)) { zoomHeld = false; zoomApply(); }
    markKey(evCode(e), false);
  }, true);

  var clicksL = [], clicksR = [];
  window.addEventListener('mousedown', function (e) {
    markKey('M' + e.button, true);
    if (e.button === 0) clicksL.push(performance.now());
    if (e.button === 2) clicksR.push(performance.now());
  }, true);
  window.addEventListener('mouseup', function (e) { markKey('M' + e.button, false); }, true);

  /* ------------------------- frame loop --------------------------------- */

  var frames = 0, last = performance.now(), fps = 0;
  var dynLast = performance.now();
  (function tick() {
    frames++;
    var now = performance.now();

    // The game rewrites the canvas's inline style all the time (the same
    // reason image-rendering needs re-asserting), so effects that live on
    // that style have to be pushed back every frame. Cheap: two compares.
    var fc = findCanvas();
    if (fc) {
      if (fbFilterStr) {
        if (!fc.style.filter || fc.style.filter.indexOf('ccgamma') < 0) fc.style.filter = fbFilterStr;
      } else if (fc.style.filter) fc.style.filter = '';
      if (zoomHeld && isOn('zoom')) {
        var zp = 'scale(' + (settingsOf(modById('zoom')).power || 2) + ')';
        if (fc.style.transform !== zp) { fc.style.transform = zp; fc.style.transformOrigin = '50% 50%'; }
      } else if (fc.style.transform) fc.style.transform = '';
    }

    if (tntUntil) {
      var leftMs = tntUntil - now;
      if (leftMs <= -700) { tntUntil = 0; tntEl.style.display = 'none'; }
      else if (leftMs <= 0) { tntEl.textContent = '💥 BOOM'; tntEl.style.color = '#ffe14d'; }
      else {
        tntEl.textContent = '🧨 ' + (leftMs / 1000).toFixed(1);
        if (leftMs < 1200) tntEl.style.color = '#ffe14d';
      }
    }

    if (now - last >= 500) {
      fps = Math.round(frames * 1000 / (now - last));
      frames = 0; last = now;

      if (isOn('perfhud')) {
        var c = findCanvas();
        hudEl.innerHTML = fps + ' fps' + (c ? '<br>' + c.width + '×' + c.height : '');
      }
      if (isOn('cps')) {
        var cut = now - 1000;
        clicksL = clicksL.filter(function (t) { return t > cut; });
        clicksR = clicksR.filter(function (t) { return t > cut; });
        cpsEl.textContent = clicksL.length + ' | ' + clicksR.length + ' cps';
      }
      if (open) refreshStat();

      // Sodiumish: nudge the scale toward the target fps, once per second.
      if (sodiumishOn && armed && !document.hidden && now - dynLast > 1000) {
        dynLast = now;
        var so = settingsOf(modById('sodiumish'));
        var target = Number(so.target) || 45;
        var floor = (so.floor || 35) / 100;
        if (fps < target - 4 && dynScale > floor) dynScale = Math.max(floor, dynScale - 0.07);
        else if (fps > target + 8 && dynScale < 1) dynScale = Math.min(1, dynScale + 0.04);
        if (Math.abs(dynScale - scale) > 0.01) setScaleNow(dynScale);
      }
    }
    for (var i = 0; i < frameHooks.length; i++) {
      try { frameHooks[i](fps); } catch (e) { frameHooks.splice(i--, 1); }
    }
    requestAnimationFrame(tick);
  })();

  /* ============================== boot ================================== */

  // True gamma needs an SVG filter; CSS brightness() can't lift dark pixels
  // without washing everything grey. url(#id) only resolves inside the same
  // tree as the canvas, so this lives in the document, not our shadow root.
  var fbSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fbSvg.setAttribute('id', 'ccgamma-svg');
  fbSvg.setAttribute('width', '0');
  fbSvg.setAttribute('height', '0');
  fbSvg.style.position = 'absolute';
  fbSvg.innerHTML = '<filter id="ccgamma" color-interpolation-filters="sRGB">' +
    '<feComponentTransfer>' +
    '<feFuncR type="gamma" exponent="0.42" amplitude="1" offset="0"/>' +
    '<feFuncG type="gamma" exponent="0.42" amplitude="1" offset="0"/>' +
    '<feFuncB type="gamma" exponent="0.42" amplitude="1" offset="0"/>' +
    '</feComponentTransfer></filter>';

  var HOST_CSS = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  function mountTarget() {
    // In fullscreen the browser only paints descendants of the fullscreen
    // element - anything left on <body> simply vanishes. Every overlay,
    // toast and button has to follow the game in.
    return document.fullscreenElement || document.body;
  }
  function ensureMounted() {
    // The game rebuilds <body> while booting; it can sweep our host into its
    // own wrapper AND stamp new inline styles on it (seen: z-index 2,
    // position absolute). Re-assert both the parent and the style.
    var tgt = mountTarget();
    if (tgt && host.parentNode !== tgt) tgt.appendChild(host);
    if (tgt && fbSvg.parentNode !== tgt) {
      tgt.appendChild(fbSvg);
      fbApply();                       // re-point the canvas at the filter
    }
    if (host.style.zIndex !== '2147483647' || host.style.position !== 'fixed') {
      host.style.cssText = HOST_CSS;
    }
  }
  ensureMounted();
  setInterval(function () {
    ensureMounted();
    if (isOn('title') && document.title !== 'CloudClient ' + VERSION) document.title = 'CloudClient ' + VERSION;
    var c = findCanvas();
    if (c && isOn('renderscale')) {
      var want = settingsOf(modById('renderscale')).smooth ? 'auto' : 'pixelated';
      if (c.style.imageRendering !== want) c.style.setProperty('image-rendering', want, 'important');
    }
  }, 1000);

  function applyAll() { mods.forEach(applyMod); }
  applyAll();

  var waited = 0, seeded = false;
  (function waitForOptions() {
    if (optionsKey()) { applyAll(); needsReload = false; return; }
    waited++;
    if (!seeded && waited > 4) {
      seeded = true;
      gzip('renderDistance:3\n').then(function (b64) {
        if (!optionsKey()) localStorage.setItem('_eaglymc.g', b64);
      }).catch(function () {});
    }
    if (waited < 45) setTimeout(waitForOptions, 1200);
  })();

  userMods.forEach(runUserMod);

  window.CloudClient = {
    version: VERSION,
    toggle: toggle,
    openStore: openStore,
    mods: mods,
    store: STORE,
    api: api,
    pressHitboxes: pressHitboxes,
    register: function (m) { register(m); applyMod(m); renderMenu(); },
    get fps() { return fps; }
  };

  console.log('%c[CloudClient] ' + VERSION + ' ready — ☁ button, Ctrl+Shift+C (panel), Ctrl+Shift+M (mods)',
              'color:#7dd3fc');
})();

/*!
 * CloudClient 1.0 - a mod client for EaglercraftX in the browser
 * Built for a laggy school Chromebook. github.com/CLoudyIceOceaN/1.20
 *
 * The game itself is one compiled WASM blob with no mod loader, so nothing can
 * be patched inside it. Everything here works from outside, through the four
 * doors the client actually leaves open:
 *
 *   1. window.devicePixelRatio  -> how many pixels the game draws (render scale)
 *   2. localStorage "_eaglymc.g" -> the game's own video/HUD options
 *   3. IndexedDB resourcePacks   -> installing + selecting resource packs
 *   4. the page around the canvas -> overlays, wake lock, page title
 *
 * Mods are registered against that API, toggled from the menu on the little
 * button in the bottom-right corner, and remembered between launches. You can
 * add your own from the same menu.
 */
(function () {
  'use strict';

  if (window.CloudClient) { window.CloudClient.toggle(); return; }

  var VERSION = '1.0';
  var CFG_KEY = 'cloudclient.cfg';
  var MODS_KEY = 'cloudclient.mods';
  var PACK_NAME = 'CloudClient-NoAnim';

  /* =================================================================== *
   * storage
   * =================================================================== */

  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var cfg = load(CFG_KEY, {});
  if (!cfg.mods) cfg.mods = {};          // id -> { on: bool, s: {settingId: value} }
  function saveCfg() { store(CFG_KEY, cfg); }

  var userMods = load(MODS_KEY, []);     // [{ id, name, code, on }]
  function saveUserMods() { store(MODS_KEY, userMods); }

  var needsReload = false;

  /* =================================================================== *
   * the game, as seen from outside
   * =================================================================== */

  function findCanvas(root) {
    root = root || document;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].tagName === 'CANVAS') return all[i];
      if (all[i].shadowRoot) { var c = findCanvas(all[i].shadowRoot); if (c) return c; }
    }
    return null;
  }

  // --- the real devicePixelRatio, captured before we shadow it -----------
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

  // The game does its own layout maths with devicePixelRatio while it boots,
  // and lying to it that early leaves the canvas sized to a corner of the
  // window. So the hook reports the truth until the canvas exists.
  var armed = false;
  var scale = 1;

  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: function () { return armed ? Math.max(0.05, realDPR() * scale) : realDPR(); }
    });
  } catch (e) { console.warn('[CloudClient] devicePixelRatio is locked', e); }

  function pokeResize() { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }

  var armWait = 0;
  (function waitForCanvas() {
    var c = findCanvas();
    if (c && c.clientWidth > 0) { setTimeout(function () { armed = true; pokeResize(); }, 400); return; }
    if (armWait++ < 2400) setTimeout(waitForCanvas, 150);
  })();

  // --- the options file --------------------------------------------------
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

  /** Merge {key: value} into the game's options file. Takes effect next boot. */
  function setGameOptions(over) {
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
      return gzip(lines.filter(function (l) { return l !== ''; }).join('\n') + '\n');
    }).then(function (b64) {
      localStorage.setItem(key || '_eaglymc.g', b64);
      needsReload = true;
      refreshMenu();
      return true;
    }).catch(function (err) { console.warn('[CloudClient] options write failed', err); return false; });
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

  /* =================================================================== *
   * resource pack installer (used by the animation mod)
   * =================================================================== */

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

  /** Open the pack filesystem, but ONLY if the game already made it - opening a
   *  database that doesn't exist would create an empty one and break the game. */
  function openPackDB() {
    if (!indexedDB.databases) return Promise.resolve(null);
    return indexedDB.databases().then(function (list) {
      var found = list.some(function (db) { return db.name === PACK_DB; });
      if (!found) return null;
      return new Promise(function (res) {
        var q = indexedDB.open(PACK_DB);
        q.onsuccess = function () {
          var db = q.result;
          if (!db.objectStoreNames.contains('filesystem')) { db.close(); res(null); return; }
          res(db);
        };
        q.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
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
          man.resourcePacks.push({
            timestamp: Date.now(), name: PACK_NAME, folder: PACK_NAME, domains: ['minecraft']
          });
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

  /** Add/remove our pack from the game's selected list. */
  function selectPack(on) {
    return getGameOptions().then(function (opts) {
      var list = [];
      try { list = JSON.parse(opts.resourcePacks || '[]'); } catch (e) {}
      list = list.filter(function (n) { return n !== PACK_NAME; });
      if (on) list.push(PACK_NAME);
      return setGameOptions({ resourcePacks: JSON.stringify(list) });
    });
  }

  /* =================================================================== *
   * mod registry
   * =================================================================== */

  var mods = [];
  var CATS = { perf: 'Performance', visual: 'Look & HUD', util: 'Extras', user: 'My Mods' };

  function register(mod) {
    mods.push(mod);
    if (!cfg.mods[mod.id]) cfg.mods[mod.id] = { on: !!mod.def, s: {} };
    return mod;
  }
  function modById(id) {
    for (var i = 0; i < mods.length; i++) if (mods[i].id === id) return mods[i];
    return null;
  }
  function isOn(id) { return !!(cfg.mods[id] && cfg.mods[id].on); }
  function settingsOf(mod) {
    var saved = (cfg.mods[mod.id] && cfg.mods[mod.id].s) || {};
    var out = {};
    (mod.settings || []).forEach(function (s) {
      out[s.id] = saved[s.id] === undefined ? s.def : saved[s.id];
    });
    return out;
  }
  function applyMod(mod) {
    try { if (mod.apply) mod.apply(isOn(mod.id), settingsOf(mod)); }
    catch (e) { console.warn('[CloudClient] mod "' + mod.id + '" failed', e); }
  }
  function setMod(id, on) {
    cfg.mods[id].on = on; saveCfg();
    var mod = modById(id);
    if (mod) { applyMod(mod); if (mod.reload) needsReload = true; }
    refreshMenu();
  }
  function setSetting(id, key, value) {
    cfg.mods[id].s[key] = value; saveCfg();
    var mod = modById(id);
    if (mod) { applyMod(mod); if (mod.reload) needsReload = true; }
    refreshMenu();
  }

  /* =================================================================== *
   * built-in mods
   * =================================================================== */

  register({
    id: 'renderscale',
    name: 'Render Scale',
    cat: 'perf',
    def: true,
    desc: 'Draws the game smaller and lets the browser stretch it back out. Half scale is a quarter of the pixels. This is the biggest FPS win available in a browser.',
    settings: [
      { id: 'scale', type: 'slider', label: 'Resolution', min: 25, max: 100, step: 5, def: 60, unit: '%' },
      { id: 'smooth', type: 'toggle', label: 'Smooth the stretch (less blocky)', def: true }
    ],
    apply: function (on, s) {
      scale = on ? Math.max(0.25, Math.min(1, s.scale / 100)) : 1;
      if (armed) pokeResize();
      var c = findCanvas();
      if (c) c.style.setProperty('image-rendering', (on && s.smooth) ? 'auto' : 'pixelated', 'important');
    }
  });

  var VIDEO_PRESETS = {
    balanced: {
      renderDistance: '4', particles: '1', mipmapLevels: '0', entityShadows: 'true',
      renderClouds: 'fast', fancyGraphics: 'false', ao: '1', fxaa: '2', shaders: 'false',
      enableDynamicLights: 'false', connectedTexturesOF: '0', customSkyOF: 'false',
      smartLeavesOF: 'true', chunkFix: 'true', fog: 'true'
    },
    fast: {
      renderDistance: '3', particles: '1', mipmapLevels: '0', entityShadows: 'false',
      renderClouds: 'false', fancyGraphics: 'false', ao: '0', fxaa: '2', shaders: 'false',
      enableDynamicLights: 'false', connectedTexturesOF: '0', customSkyOF: 'false',
      customItemsOF: 'false', betterGrassOF: '0', smartLeavesOF: 'true', chunkFix: 'true',
      fog: 'true'
    },
    potato: {
      renderDistance: '2', particles: '2', mipmapLevels: '0', entityShadows: 'false',
      renderClouds: 'false', fancyGraphics: 'false', ao: '0', fxaa: '2', shaders: 'false',
      enableDynamicLights: 'false', connectedTexturesOF: '0', customSkyOF: 'false',
      customItemsOF: 'false', betterGrassOF: '0', smartLeavesOF: 'true',
      allowBlockAlternatives: 'false', chunkFix: 'true', fog: 'true', bobView: 'false',
      enableFNAWSkins: 'false'
    }
  };

  register({
    id: 'videotweaks',
    name: 'Fast Video Settings',
    cat: 'perf',
    def: true,
    reload: true,
    desc: 'Writes the heavy video options straight into the game before it starts: render distance, mipmaps, particles, shadows, clouds, connected textures, FXAA. Your keys, skin and sound are left alone.',
    settings: [
      { id: 'preset', type: 'select', label: 'Preset', def: 'fast', options: [
        { v: 'balanced', label: 'Balanced' }, { v: 'fast', label: 'Fast' }, { v: 'potato', label: 'Potato' }
      ] },
      { id: 'distance', type: 'slider', label: 'Render distance', min: 2, max: 8, step: 1, def: 0, unit: ' chunks',
        hint: '0 = leave it to the preset' }
    ],
    apply: function (on, s) {
      if (!on) return;
      var over = {};
      var base = VIDEO_PRESETS[s.preset] || VIDEO_PRESETS.fast;
      for (var k in base) over[k] = base[k];
      if (s.distance > 0) over.renderDistance = String(s.distance);
      setGameOptions(over);
    }
  });

  register({
    id: 'noanim',
    name: 'Freeze Animated Textures',
    cat: 'perf',
    def: true,
    reload: true,
    desc: 'Water, lava, fire and portals are re-uploaded to your graphics chip over and over while you play. This installs a tiny resource pack that gives them one frame each, so the uploads stop. Water goes still.',
    apply: function (on) {
      if (on) installNoAnimPack().then(function (ok) { if (ok) selectPack(true); });
      else selectPack(false);
    }
  });

  register({
    id: 'fpslimit',
    name: 'Frame Limit',
    cat: 'perf',
    def: false,
    reload: true,
    desc: 'Caps how many frames the game will try to draw. A Chromebook that is running hot slows itself down; asking for fewer frames can keep it cooler and steadier.',
    settings: [
      { id: 'max', type: 'select', label: 'Limit', def: '60', options: [
        { v: '30', label: '30 fps' }, { v: '45', label: '45 fps' }, { v: '60', label: '60 fps' },
        { v: '120', label: '120 fps' }, { v: '260', label: 'Unlimited' }
      ] }
    ],
    apply: function (on, s) { if (on) setGameOptions({ maxFps: s.max }); }
  });

  register({
    id: 'skipcountdown',
    name: 'Skip Launch Countdown',
    cat: 'util',
    def: true,
    desc: 'Presses the "Skip Countdown" button for you so the game starts straight away.',
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
    id: 'gamehud',
    name: 'Game HUD',
    cat: 'visual',
    def: true,
    reload: true,
    desc: "Turns the client's own corner readouts on and off.",
    settings: [
      { id: 'fps', type: 'toggle', label: 'FPS + chunk counter', def: true },
      { id: 'coords', type: 'toggle', label: 'Coordinates', def: true },
      { id: 'stats', type: 'toggle', label: 'Player stats', def: false },
      { id: 'clock', type: 'toggle', label: '24 hour clock', def: false }
    ],
    apply: function (on, s) {
      if (!on) return;
      setGameOptions({
        hudFps: String(!!s.fps), hudCoords: String(!!s.coords),
        hudStats: String(!!s.stats), hud24h: String(!!s.clock)
      });
    }
  });

  register({
    id: 'perfhud',
    name: 'CloudClient Overlay',
    cat: 'visual',
    def: false,
    desc: 'A small readout in the top-left corner showing the frame rate and the resolution the game is really drawing at.',
    apply: function (on) { hudEl.style.display = on ? 'block' : 'none'; }
  });

  register({
    id: 'watermark',
    name: 'CloudClient Watermark',
    cat: 'visual',
    def: true,
    desc: 'Little CloudClient tag in the corner.',
    apply: function (on) { markEl.style.display = on ? 'block' : 'none'; }
  });

  register({
    id: 'keepawake',
    name: 'Keep Screen Awake',
    cat: 'util',
    def: false,
    desc: 'Stops the screen dimming or sleeping while you play. Some laptops ignore this.',
    apply: function (on) {
      if (on) requestWakeLock(); else releaseWakeLock();
    }
  });

  register({
    id: 'title',
    name: 'Rename The Tab',
    cat: 'util',
    def: true,
    desc: 'Calls the browser tab "CloudClient" instead of the client\'s own name.',
    apply: function (on) {
      if (on) { document.title = 'CloudClient ' + VERSION; }
    }
  });

  /* --- wake lock ------------------------------------------------------- */
  var wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }
  function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && isOn('keepawake') && !wakeLock) requestWakeLock();
  });

  /* =================================================================== *
   * user mods
   * =================================================================== */

  // What a user mod gets to play with. Deliberately small and documented in
  // the menu, so a mod written today keeps working later.
  var api = {
    version: VERSION,
    canvas: findCanvas,
    log: function () {
      var args = ['[CloudClient]'].concat([].slice.call(arguments));
      console.log.apply(console, args);
    },
    setOptions: setGameOptions,
    getOptions: getGameOptions,
    setRenderScale: function (pct) { setSetting('renderscale', 'scale', Math.max(25, Math.min(100, pct))); },
    onFrame: function (fn) { frameHooks.push(fn); },
    overlay: function (html) {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483646;' +
        'font:12px system-ui,sans-serif;color:#cbd5e1;text-shadow:0 1px 2px #000;pointer-events:none';
      box.innerHTML = html;
      root.appendChild(box);
      return box;
    }
  };

  var frameHooks = [];

  function runUserMod(m) {
    if (!m.on) return;
    try {
      // eslint-disable-next-line no-new-func
      new Function('cc', m.code)(api);
      m.error = null;
    } catch (e) {
      m.error = String(e && e.message ? e.message : e);
      console.warn('[CloudClient] user mod "' + m.name + '" crashed', e);
    }
  }

  /* =================================================================== *
   * UI
   * =================================================================== */

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  root.innerHTML = [
    '<style>',
    ':host,*{box-sizing:border-box}',
    '.btn{position:fixed;bottom:8px;right:8px;width:38px;height:38px;border:0;border-radius:10px;',
    '  background:rgba(13,17,23,.78);color:#7dd3fc;font-size:18px;line-height:38px;text-align:center;',
    '  cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.5);padding:0}',
    '.btn:hover{background:rgba(13,17,23,.96)}',
    '.mark{position:fixed;left:8px;bottom:6px;font:600 12px system-ui,sans-serif;color:#7dd3fc;',
    '  text-shadow:0 1px 3px #000;pointer-events:none;letter-spacing:.3px}',
    '.hud{position:fixed;left:8px;top:6px;font:600 12px/1.5 ui-monospace,monospace;color:#7dd3fc;',
    '  text-shadow:0 1px 3px #000;pointer-events:none;display:none}',
    '.panel{position:fixed;right:8px;bottom:52px;width:330px;max-height:calc(100vh - 70px);',
    '  display:none;flex-direction:column;border-radius:14px;overflow:hidden;',
    '  background:rgba(13,17,23,.97);border:1px solid rgba(125,211,252,.18);',
    '  box-shadow:0 10px 40px rgba(0,0,0,.6);color:#e6edf3;font:13px/1.45 system-ui,sans-serif}',
    '.panel.on{display:flex}',
    '.head{padding:12px 14px 10px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.head h1{margin:0;font-size:16px;letter-spacing:.2px}',
    '.head h1 b{color:#7dd3fc}',
    '.head .sub{font-size:11px;color:#8b949e;margin-top:2px}',
    '.turbo{display:block;width:100%;margin-top:10px;padding:9px 0;border:0;border-radius:9px;',
    '  background:linear-gradient(90deg,#0ea5e9,#38bdf8);color:#04202e;font:700 13px system-ui;cursor:pointer}',
    '.turbo:hover{filter:brightness(1.08)}',
    '.tabs{display:flex;gap:4px;padding:8px 10px 0}',
    '.tab{flex:1;padding:6px 0;border:0;border-radius:8px 8px 0 0;background:transparent;color:#8b949e;',
    '  font:600 11px system-ui;cursor:pointer}',
    '.tab.sel{background:rgba(125,211,252,.12);color:#7dd3fc}',
    '.body{overflow-y:auto;padding:8px 10px 12px;flex:1}',
    '.mod{border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:9px 10px;margin-bottom:7px;',
    '  background:rgba(255,255,255,.02)}',
    '.mod.on{border-color:rgba(125,211,252,.35);background:rgba(125,211,252,.06)}',
    '.row{display:flex;align-items:center;gap:8px}',
    '.name{font-weight:600;font-size:13px;flex:1}',
    '.desc{font-size:11.5px;color:#8b949e;margin-top:4px}',
    '.sw{position:relative;width:36px;height:20px;border-radius:20px;background:#30363d;border:0;cursor:pointer;flex:none}',
    '.sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#8b949e;transition:.15s}',
    '.sw.on{background:#0ea5e9}.sw.on i{left:18px;background:#04202e}',
    '.sets{margin-top:8px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.08);display:none}',
    '.mod.on .sets{display:block}',
    '.set{margin-bottom:8px}',
    '.set label{display:block;font-size:11.5px;color:#c9d1d9;margin-bottom:3px}',
    '.set label b{color:#7dd3fc}',
    '.set input[type=range]{width:100%;accent-color:#38bdf8}',
    '.set select{width:100%;padding:5px;border-radius:7px;background:#161b22;color:#e6edf3;',
    '  border:1px solid rgba(255,255,255,.12);font-size:12px}',
    '.chk{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#c9d1d9;cursor:pointer;margin-bottom:5px}',
    '.hint{font-size:10.5px;color:#6e7681;margin-top:2px}',
    '.foot{padding:8px 10px;border-top:1px solid rgba(255,255,255,.07);display:flex;gap:6px}',
    '.foot button{flex:1;padding:7px 0;border-radius:8px;border:1px solid rgba(255,255,255,.12);',
    '  background:#21262d;color:#e6edf3;font-size:11.5px;cursor:pointer}',
    '.foot button:hover{background:#30363d}',
    '.reload{background:#0ea5e9;border-color:#0ea5e9;color:#04202e;font-weight:700}',
    '.add{width:100%;padding:8px 0;border-radius:9px;border:1px dashed rgba(125,211,252,.4);',
    '  background:transparent;color:#7dd3fc;font-size:12px;cursor:pointer;margin-bottom:8px}',
    'textarea,input.txt{width:100%;background:#0d1117;color:#e6edf3;border:1px solid rgba(255,255,255,.12);',
    '  border-radius:8px;padding:7px;font:12px ui-monospace,monospace;margin-bottom:6px}',
    'textarea{height:120px;resize:vertical}',
    '.mini{padding:5px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:#21262d;',
    '  color:#e6edf3;font-size:11px;cursor:pointer}',
    '.err{color:#f85149;font-size:11px;margin-top:4px}',
    '.doc{font-size:11px;color:#8b949e;background:rgba(255,255,255,.03);border-radius:8px;padding:8px;margin-bottom:8px}',
    '.doc code{color:#7dd3fc;font-family:ui-monospace,monospace}',
    '</style>',
    '<div class="mark">&#9729; CloudClient</div>',
    '<div class="hud" id="hud"></div>',
    '<button class="btn" id="open" title="CloudClient (Ctrl+Shift+C)">&#9729;</button>',
    '<div class="panel" id="panel">',
    '  <div class="head">',
    '    <h1>&#9729; <b>CloudClient</b> <span style="font-size:11px;color:#8b949e">v' + VERSION + '</span></h1>',
    '    <div class="sub" id="stat">&nbsp;</div>',
    '    <button class="turbo" id="turbo">&#9889; TURBO &mdash; make it as fast as possible</button>',
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
  var open = false, tab = 'perf';

  function toggle(force) {
    open = force === undefined ? !open : force;
    panel.classList.toggle('on', open);
    if (open) {
      if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) {} }
      refreshMenu();
    }
  }

  /* --- rendering the menu ---------------------------------------------- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function refreshMenu() {
    if (!open) return;

    var c = findCanvas();
    $('#stat').textContent = c
      ? ('drawing ' + c.width + '×' + c.height + ' → screen ' + c.clientWidth + '×' + c.clientHeight)
      : 'waiting for the game…';
    $('#reload').style.display = needsReload ? 'block' : 'none';

    var tabs = $('#tabs');
    tabs.innerHTML = '';
    Object.keys(CATS).forEach(function (k) {
      var b = document.createElement('button');
      b.className = 'tab' + (tab === k ? ' sel' : '');
      b.textContent = CATS[k];
      b.onclick = function () { tab = k; refreshMenu(); };
      tabs.appendChild(b);
    });

    var body = $('#body');
    body.innerHTML = '';
    if (tab === 'user') { renderUserTab(body); return; }

    mods.filter(function (m) { return m.cat === tab; }).forEach(function (m) {
      body.appendChild(renderMod(m));
    });
  }

  function renderMod(m) {
    var on = isOn(m.id);
    var s = settingsOf(m);
    var box = document.createElement('div');
    box.className = 'mod' + (on ? ' on' : '');

    var row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="name">' + esc(m.name) + '</div>';
    var sw = document.createElement('button');
    sw.className = 'sw' + (on ? ' on' : '');
    sw.innerHTML = '<i></i>';
    sw.onclick = function () { setMod(m.id, !isOn(m.id)); };
    row.appendChild(sw);
    box.appendChild(row);

    var desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = m.desc;
    box.appendChild(desc);

    if (m.settings && m.settings.length) {
      var sets = document.createElement('div');
      sets.className = 'sets';
      m.settings.forEach(function (def) { sets.appendChild(renderSetting(m, def, s[def.id])); });
      box.appendChild(sets);
    }
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

    var label = document.createElement('label');
    if (def.type === 'slider') {
      label.innerHTML = esc(def.label) + ': <b>' +
        (def.id === 'distance' && !value ? 'preset' : esc(value) + esc(def.unit || '')) + '</b>';
    } else {
      label.textContent = def.label;
    }
    wrap.appendChild(label);

    if (def.type === 'slider') {
      var r = document.createElement('input');
      r.type = 'range'; r.min = def.min; r.max = def.max; r.step = def.step; r.value = value;
      if (def.id === 'distance') r.min = 0;
      r.oninput = function () { setSetting(m.id, def.id, Number(r.value)); };
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

  function renderUserTab(body) {
    var doc = document.createElement('div');
    doc.className = 'doc';
    doc.innerHTML = 'Your mod is JavaScript that runs when the game starts. It gets a helper called ' +
      '<code>cc</code>:<br><code>cc.log(msg)</code>, <code>cc.canvas()</code>, ' +
      '<code>cc.setRenderScale(50)</code>, <code>cc.setOptions({renderDistance:"2"})</code>, ' +
      '<code>cc.overlay("&lt;b&gt;hi&lt;/b&gt;")</code>, <code>cc.onFrame(fn)</code>.' +
      '<br><br>Only paste code you trust &mdash; it runs with the game.';
    body.appendChild(doc);

    var add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+ Add a mod';
    add.onclick = function () { showEditor(null); };
    body.appendChild(add);

    if (!userMods.length) {
      var none = document.createElement('div');
      none.className = 'desc';
      none.textContent = 'No mods of your own yet.';
      body.appendChild(none);
    }

    userMods.forEach(function (m, i) {
      var box = document.createElement('div');
      box.className = 'mod' + (m.on ? ' on' : '');
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<div class="name">' + esc(m.name) + '</div>';

      var edit = document.createElement('button');
      edit.className = 'mini'; edit.textContent = 'Edit';
      edit.onclick = function () { showEditor(i); };
      row.appendChild(edit);

      var del = document.createElement('button');
      del.className = 'mini'; del.textContent = 'Delete';
      del.onclick = function () {
        userMods.splice(i, 1); saveUserMods(); needsReload = true; refreshMenu();
      };
      row.appendChild(del);

      var sw = document.createElement('button');
      sw.className = 'sw' + (m.on ? ' on' : '');
      sw.innerHTML = '<i></i>';
      sw.onclick = function () {
        m.on = !m.on; saveUserMods(); needsReload = true;
        if (m.on) runUserMod(m);
        refreshMenu();
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
    var editing = index != null ? userMods[index] : { name: '', code: '', on: true };
    var body = $('#body');
    body.innerHTML = '';

    var name = document.createElement('input');
    name.className = 'txt'; name.placeholder = 'Mod name'; name.value = editing.name;
    body.appendChild(name);

    var code = document.createElement('textarea');
    code.placeholder = '// example\ncc.log("hello from my mod");\ncc.overlay("<b>my mod is on</b>");';
    code.value = editing.code;
    body.appendChild(code);

    var row = document.createElement('div');
    row.className = 'row';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'mini'; saveBtn.textContent = 'Save';
    saveBtn.onclick = function () {
      var m = { id: 'u' + Date.now(), name: name.value.trim() || 'Untitled mod', code: code.value, on: true };
      if (index != null) { userMods[index].name = m.name; userMods[index].code = m.code; }
      else userMods.push(m);
      saveUserMods();
      needsReload = true;
      tab = 'user';
      refreshMenu();
    };
    row.appendChild(saveBtn);

    var fileBtn = document.createElement('button');
    fileBtn.className = 'mini'; fileBtn.textContent = 'Load .js file';
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
    cancel.onclick = function () { tab = 'user'; refreshMenu(); };
    row.appendChild(cancel);

    body.appendChild(row);
  }

  /* --- buttons ---------------------------------------------------------- */

  $('#open').onclick = function (e) { e.stopPropagation(); toggle(); };
  $('#reload').onclick = function () { location.reload(); };
  $('#turbo').onclick = function () {
    setMod('renderscale', true);
    setSetting('renderscale', 'scale', 50);
    setMod('videotweaks', true);
    setSetting('videotweaks', 'preset', 'potato');
    setMod('noanim', true);
    setMod('fpslimit', true);
    needsReload = true;
    refreshMenu();
  };
  $('#reset').onclick = function () {
    cfg = { mods: {} };
    mods.forEach(function (m) { cfg.mods[m.id] = { on: !!m.def, s: {} }; });
    saveCfg();
    mods.forEach(applyMod);
    needsReload = true;
    refreshMenu();
  };

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault(); e.stopPropagation(); toggle();
    }
  }, true);

  /* --- frame loop: fps readout + user hooks ------------------------------ */
  var frames = 0, last = performance.now(), fps = 0;
  (function tick() {
    frames++;
    var now = performance.now();
    if (now - last >= 500) {
      fps = Math.round(frames * 1000 / (now - last));
      frames = 0; last = now;
      if (isOn('perfhud')) {
        var c = findCanvas();
        hudEl.innerHTML = fps + ' fps' + (c ? '<br>' + c.width + '×' + c.height : '');
      }
      if (open) refreshMenu();
    }
    for (var i = 0; i < frameHooks.length; i++) {
      try { frameHooks[i](fps); } catch (e) { frameHooks.splice(i--, 1); }
    }
    requestAnimationFrame(tick);
  })();

  /* =================================================================== *
   * boot
   * =================================================================== */

  function ensureMounted() {
    if (document.body && !host.isConnected) document.body.appendChild(host);
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

  // Apply every enabled mod. Options-based ones need the file to exist, so on a
  // brand new profile we wait a few seconds for the game to write one, then
  // seed a minimal one ourselves and apply on top of that.
  function applyAll() { mods.forEach(applyMod); }

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
    if (waited < 45) { setTimeout(waitForOptions, 1200); return; }
    applyAll();                              // page-level mods still work
  })();

  userMods.forEach(runUserMod);

  window.CloudClient = {
    version: VERSION,
    toggle: toggle,
    mods: mods,
    api: api,
    register: function (m) { register(m); applyMod(m); refreshMenu(); },
    get fps() { return fps; }
  };

  console.log('%c[CloudClient] ' + VERSION + ' ready - Ctrl+Shift+C or the cloud button',
              'color:#7dd3fc');
})();

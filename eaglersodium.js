/*!
 * EaglerSodium 1.1 - a performance mod for EaglercraftX in the browser
 * Made for laggy Chromebooks. Works on daniezonsfusd.github.io/1.20 (EaglyMC 1.20-u7).
 *
 * What it actually does (no magic, all real):
 *   1. RENDER SCALE - the game draws every pixel of your screen times
 *      devicePixelRatio. We lie about devicePixelRatio so the game renders a
 *      smaller picture and the browser stretches it back out. Half scale =
 *      1/4 as many pixels to draw = the single biggest FPS win available.
 *   2. FAST SETTINGS - Eaglercraft keeps its options in localStorage as a
 *      gzipped text file. We rewrite the slow options (render distance,
 *      mipmaps, particles, entity shadows, connected textures, clouds...)
 *      before the game boots, so it starts up already tuned.
 *   3. A little control panel so you can change all of it while you play.
 *
 * Two ways to run it:
 *   - baked in: <script src="eaglersodium.js"></script> right after <head> in
 *     the game's index.html (how cloudyiceocean.github.io/1.20 serves it)
 *   - as a bookmarklet, clicked after the page loads
 *
 * Toggle the panel: click the lightning button, or press Ctrl+Shift+P.
 */
(function () {
  'use strict';

  if (window.__EAGLER_SODIUM__) { window.__EAGLER_SODIUM__.toggle(); return; }

  var VERSION = '1.1';
  var CFG_KEY = 'eaglersodium.cfg';

  /* ------------------------------------------------------------------ *
   * config
   * ------------------------------------------------------------------ */

  var cfg = {
    renderScale: 0.6,     // 1.0 = full resolution, 0.5 = quarter the pixels
    smooth: true,         // blur the upscale instead of blocky pixels
    preset: 'fast',       // which settings preset was applied last
    applied: 0,           // version of the preset we already wrote
    hideHand: false
  };
  try {
    var saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    for (var k in saved) if (k in cfg) cfg[k] = saved[k];
  } catch (e) {}

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 1. render scale
   * ------------------------------------------------------------------ */

  // Grab the browser's REAL devicePixelRatio getter before we shadow it, so we
  // can still read the true value (it changes if you zoom the page).
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
  // and lying to it that early leaves the canvas mis-sized (it ends up in a
  // corner of the window). So the hook stays dormant until the game's canvas
  // is up, then arms itself. Injected as a bookmarklet the wait is over
  // immediately; baked into the page it costs the first second of loading.
  var armed = false;

  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: function () {
        return armed ? Math.max(0.05, realDPR() * cfg.renderScale) : realDPR();
      }
    });
  } catch (e) {
    console.warn('[EaglerSodium] could not hook devicePixelRatio', e);
  }

  function arm() {
    if (armed) return;
    armed = true;
    refreshScale();
  }

  // wait for the game canvas, then give the runtime a moment to settle
  var armTries = 0;
  (function waitForCanvas() {
    var c = findCanvas();
    if (c && c.clientWidth > 0) { setTimeout(arm, 400); return; }
    if (armTries++ < 2400) setTimeout(waitForCanvas, 150);
  })();

  // Poke the game so it re-reads the screen size and resizes its canvas.
  function refreshScale() {
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    applySmoothing();
    updatePanel();
  }

  /* ------------------------------------------------------------------ *
   * finding the game canvas (it lives inside a shadow root)
   * ------------------------------------------------------------------ */

  function findCanvas(root) {
    root = root || document;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === 'CANVAS') return el;
      if (el.shadowRoot) { var c = findCanvas(el.shadowRoot); if (c) return c; }
    }
    return null;
  }

  function applySmoothing() {
    var c = findCanvas();
    if (!c) return;
    c.style.setProperty('image-rendering', cfg.smooth ? 'auto' : 'pixelated', 'important');
  }

  /* ------------------------------------------------------------------ *
   * 2. fast game settings (rewrite Eaglercraft's options blob)
   * ------------------------------------------------------------------ */

  var PRESET_VERSION = 4;

  var PRESETS = {
    off: {},
    fast: {
      renderDistance: '3',        // was 4 - fewer chunks to build and draw
      particles: '1',             // decreased
      mipmapLevels: '0',          // mipmaps cost upload time + memory
      entityShadows: 'false',
      renderClouds: 'false',
      fancyGraphics: 'false',
      ao: '0',                    // smooth lighting off
      fxaa: '2',                    // 0=auto 1=on 2=off - verified in game
      shaders: 'false',
      enableDynamicLights: 'false',
      connectedTexturesOF: '0',   // connected textures rebuild chunks slowly
      customSkyOF: 'false',
      customItemsOF: 'false',
      betterGrassOF: '0',
      smartLeavesOF: 'true',      // skips hidden leaf faces = less geometry
      chunkFix: 'true',
      fog: 'true'                 // fog is cheap and hides the short distance
    },
    potato: {
      renderDistance: '2',
      particles: '2',             // minimal
      mipmapLevels: '0',
      entityShadows: 'false',
      renderClouds: 'false',
      fancyGraphics: 'false',
      ao: '0',
      fxaa: '2',
      shaders: 'false',
      enableDynamicLights: 'false',
      connectedTexturesOF: '0',
      customSkyOF: 'false',
      customItemsOF: 'false',
      betterGrassOF: '0',
      smartLeavesOF: 'true',
      allowBlockAlternatives: 'false',  // fewer block model variants to build
      chunkFix: 'true',
      fog: 'true',
      bobView: 'false',
      enableFNAWSkins: 'false'
    }
  };

  function optionsKey() {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/\.g$/.test(k) && /^_/.test(k)) return k;   // e.g. "_eaglymc.g"
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
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function gunzip(b64) {
    var stream = new Blob([b64ToBytes(b64)]).stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  function gzip(text) {
    var stream = new Blob([text]).stream()
      .pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return bytesToB64(new Uint8Array(buf));
    });
  }

  // Read options -> override only the performance lines -> write back.
  function applyPreset(name) {
    var over = PRESETS[name];
    if (!over) return Promise.resolve('unknown preset');
    if (typeof CompressionStream === 'undefined') {
      return Promise.resolve('this browser is too old for the settings part');
    }
    var key = optionsKey();
    if (!key) return Promise.resolve('no settings found yet - play once, then try again');

    return gunzip(localStorage.getItem(key)).then(function (text) {
      var lines = text.split('\n');
      var seen = {};
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var c = line.indexOf(':');
        if (c < 0) continue;
        var name2 = line.slice(0, c);
        if (over.hasOwnProperty(name2)) {
          lines[i] = name2 + ':' + over[name2];
          seen[name2] = true;
        }
      }
      for (var o in over) if (!seen[o]) lines.push(o + ':' + over[o]);
      return gzip(lines.join('\n'));
    }).then(function (b64) {
      localStorage.setItem(key, b64);
      cfg.preset = name;
      cfg.applied = PRESET_VERSION;
      saveCfg();
      return 'ok';
    }).catch(function (err) {
      console.warn('[EaglerSodium] settings patch failed', err);
      return 'failed: ' + err;
    });
  }

  // Write a minimal options file so a fresh profile boots tuned. The key name
  // is this client's ("_eaglymc.g"); if a future build renames it, applyPreset
  // still catches the real file on the next launch.
  function seedOptions() {
    if (optionsKey()) return;
    var over = PRESETS[cfg.preset] || {};
    var lines = [];
    for (var k in over) lines.push(k + ':' + over[k]);
    if (!lines.length) return;
    gzip(lines.join('\n') + '\n').then(function (b64) {
      if (!optionsKey()) localStorage.setItem('_eaglymc.g', b64);
    }).catch(function () {});
  }

  /* ------------------------------------------------------------------ *
   * 3. panel UI
   * ------------------------------------------------------------------ */

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  root.innerHTML = [
    '<style>',
    ':host,*{box-sizing:border-box}',
    '.btn-open{position:fixed;bottom:8px;right:8px;width:34px;height:34px;border:0;border-radius:8px;',
    '  background:rgba(20,22,28,.72);color:#7ee787;font-size:17px;line-height:34px;text-align:center;',
    '  cursor:pointer;font-family:monospace;box-shadow:0 2px 8px rgba(0,0,0,.4)}',
    '.btn-open:hover{background:rgba(20,22,28,.95)}',
    '.panel{position:fixed;bottom:50px;right:8px;max-height:calc(100vh - 60px);overflow:auto;width:270px;padding:12px 14px 14px;border-radius:12px;',
    '  background:rgba(16,18,24,.94);color:#e6edf3;font:13px/1.45 system-ui,sans-serif;',
    '  box-shadow:0 8px 30px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.09);display:none}',
    '.panel.on{display:block}',
    'h1{margin:0 0 2px;font-size:15px;letter-spacing:.3px}',
    'h1 span{color:#7ee787}',
    '.sub{margin:0 0 10px;font-size:11px;color:#8b949e}',
    '.fps{font:600 26px/1 ui-monospace,monospace;color:#7ee787;margin:2px 0 1px}',
    '.res{font-size:11px;color:#8b949e;margin-bottom:10px}',
    'label{display:block;font-size:12px;margin:10px 0 4px;color:#c9d1d9}',
    'label b{color:#7ee787}',
    'input[type=range]{width:100%;accent-color:#7ee787}',
    '.row{display:flex;gap:6px;margin-top:6px}',
    'button.p{flex:1;padding:7px 0;border-radius:8px;border:1px solid rgba(255,255,255,.12);',
    '  background:#21262d;color:#e6edf3;font-size:12px;cursor:pointer}',
    'button.p:hover{background:#30363d}',
    'button.p.sel{background:#238636;border-color:#2ea043;color:#fff}',
    'button.wide{width:100%;margin-top:9px;padding:9px 0;border-radius:8px;border:0;',
    '  background:#238636;color:#fff;font-size:13px;font-weight:600;cursor:pointer}',
    'button.wide:hover{background:#2ea043}',
    'button.ghost{background:#21262d;color:#c9d1d9;font-weight:400}',
    'button.ghost:hover{background:#30363d}',
    '.chk{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:12px;cursor:pointer}',
    '.note{margin-top:9px;font-size:11px;color:#8b949e}',
    '.msg{margin-top:8px;font-size:11px;color:#d29922;min-height:14px}',
    '</style>',
    '<button class="btn-open" title="EaglerSodium (Ctrl+Shift+P)">&#9889;</button>',
    '<div class="panel">',
    '  <h1><span>&#9889;</span> EaglerSodium <small style="font-weight:400;color:#8b949e">v' + VERSION + '</small></h1>',
    '  <p class="sub">performance mod for Eaglercraft</p>',
    '  <div class="fps" id="fps">--</div>',
    '  <div class="res" id="res">&nbsp;</div>',
    '  <label>Resolution: <b id="rsv">60%</b> <span style="color:#8b949e">(lower = faster)</span></label>',
    '  <input type="range" id="rs" min="25" max="100" step="5">',
    '  <label class="chk"><input type="checkbox" id="smooth"> Smooth the stretch (less blocky)</label>',
    '  <label style="margin-top:14px">Game settings preset</label>',
    '  <div class="row">',
    '    <button class="p" data-p="off">None</button>',
    '    <button class="p" data-p="fast">Fast</button>',
    '    <button class="p" data-p="potato">Potato</button>',
    '  </div>',
    '  <button class="wide" id="apply">Apply settings &amp; restart game</button>',
    '  <button class="wide ghost" id="reset">Reset mod to defaults</button>',
    '  <div class="msg" id="msg"></div>',
    '  <div class="note">Fast = distance 3, no mipmaps/shadows/clouds.<br>Potato = distance 2, minimal particles.</div>',
    '</div>'
  ].join('');

  function $(sel) { return root.querySelector(sel); }

  var panel = $('.panel');
  var open = false;

  function toggle(force) {
    open = (force === undefined) ? !open : force;
    panel.classList.toggle('on', open);
    if (open && document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) {} }
    updatePanel();
  }

  function updatePanel() {
    var c = findCanvas();
    $('#rsv').textContent = Math.round(cfg.renderScale * 100) + '%';
    $('#rs').value = Math.round(cfg.renderScale * 100);
    $('#smooth').checked = !!cfg.smooth;
    $('#res').textContent = c ? ('drawing ' + c.width + '×' + c.height +
        ' → screen ' + c.clientWidth + '×' + c.clientHeight) : '';
    var btns = root.querySelectorAll('button.p');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('sel', btns[i].getAttribute('data-p') === cfg.preset);
    }
  }

  function msg(t) { $('#msg').textContent = t || ''; }

  $('.btn-open').addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

  $('#rs').addEventListener('input', function () {
    cfg.renderScale = Math.max(0.25, Math.min(1, this.value / 100));
    saveCfg();
    arm();
    refreshScale();
  });

  $('#smooth').addEventListener('change', function () {
    cfg.smooth = this.checked; saveCfg(); applySmoothing();
  });

  root.querySelectorAll('button.p').forEach(function (b) {
    b.addEventListener('click', function () {
      cfg.preset = b.getAttribute('data-p'); saveCfg(); updatePanel();
      msg(cfg.preset === 'off' ? 'Settings left alone.' : 'Now press "Apply settings & restart".');
    });
  });

  $('#apply').addEventListener('click', function () {
    if (cfg.preset === 'off') { msg('Pick Fast or Potato first.'); return; }
    msg('applying...');
    applyPreset(cfg.preset).then(function (r) {
      if (r === 'ok') { msg('Saved! restarting...'); setTimeout(function () { location.reload(); }, 500); }
      else msg(r);
    });
  });

  $('#reset').addEventListener('click', function () {
    cfg.renderScale = 1; cfg.smooth = true; cfg.preset = 'off'; cfg.applied = 0;
    saveCfg(); refreshScale(); msg('Mod reset. Game settings kept.');
  });

  // Ctrl+Shift+P, grabbed before the game sees it.
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault(); e.stopPropagation(); toggle();
    }
  }, true);

  /* ------------------------------------------------------------------ *
   * fps counter
   * ------------------------------------------------------------------ */

  var frames = 0, last = performance.now();
  (function tick() {
    frames++;
    var now = performance.now();
    if (now - last >= 500) {
      var fps = frames * 1000 / (now - last);
      frames = 0; last = now;
      if (open) { $('#fps').textContent = Math.round(fps) + ' fps'; updatePanel(); }
    }
    requestAnimationFrame(tick);
  })();

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */

  // The game wipes out the page body while it boots, which throws our panel
  // away. Check every second and put it back if it went missing.
  function ensureMounted() {
    if (!document.body) return;
    if (!host.isConnected) document.body.appendChild(host);
  }
  ensureMounted();
  setInterval(function () { ensureMounted(); applySmoothing(); }, 1000);

  // Don't sit through the 5 second countdown.
  // Skip the launch countdown. When we are baked into the page we run before
  // <body> exists, so wait for the button rather than looking once.
  var skipTries = 0;
  (function skipCountdown() {
    var b = document.getElementById('skipCountdown');
    if (b) { b.click(); return; }
    if (skipTries++ < 120) setTimeout(skipCountdown, 100);
  })();

  // First ever run (or a newer preset): tune the game settings automatically.
  if (cfg.applied < PRESET_VERSION && cfg.preset !== 'off') {
    // On a brand new browser profile the game has not written its options file
    // yet. Wait a few seconds for it; if it still isn't there, seed one so even
    // the first run boots tuned (the game fills in every key we leave out).
    var waited = 0;
    var seeded = false;
    (function tryPreset() {
      if (!optionsKey()) {
        waited += 1;
        if (!seeded && waited > 4) { seeded = true; seedOptions(); }
        if (waited < 45) { setTimeout(tryPreset, 1200); return; }
        return;                              // gave up; the panel button works
      }
      applyPreset(cfg.preset).then(function (r) {
        console.log('[EaglerSodium] fast settings: ' + r);
      });
    })();
  }

  refreshScale();

  window.__EAGLER_SODIUM__ = {
    version: VERSION, cfg: cfg, toggle: toggle, applyPreset: applyPreset,
    setScale: function (s) { cfg.renderScale = s; saveCfg(); arm(); refreshScale(); }
  };
  console.log('%c[EaglerSodium] ' + VERSION + ' loaded - Ctrl+Shift+P for the panel',
              'color:#7ee787');
})();

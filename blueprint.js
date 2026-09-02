/*
 * Blueprint v1.1 — a Litematica-style blueprint viewer for EaglercraftX 1.20 (browser)
 * by Colin Ang · works on https://daniezonsfusd.github.io/1.20 and other EaglercraftX pages
 *
 * Eaglercraft has no mod loader, so this is a page script:
 *  - A "📐 Blueprints" button shows on the title screen AND whenever you press
 *    Escape in game (any time the mouse is released).
 *  - Pick a build → an overlay shows it one layer at a time, with a block
 *    legend and material counts. Faded cells = the layer underneath.
 *  - While playing:  [ and ]  change layer,  B  hides/shows the overlay.
 */
(function () {
  "use strict";
  if (window.__blueprintMod) return;
  window.__blueprintMod = { version: "1.1" };

  /* ---------------- blueprint data ----------------
   * layers: bottom layer first; each string row, each char one block, "." = air.
   * palette: char -> [block name, css color]
   */
  var BLUEPRINTS = [
    {
      id: "starter-house", name: "Starter House",
      desc: "7×7 oak and cobblestone house with a door, windows and a pointy roof.",
      palette: {
        C: ["Cobblestone", "#8a8a8a"], P: ["Oak Planks", "#b8945f"],
        L: ["Oak Log", "#6e5530"], G: ["Glass", "#a8d8e8"],
        D: ["Oak Door", "#9c7b40"], S: ["Oak Stairs (roof)", "#7d6238"],
        T: ["Torch", "#ffd75e"]
      },
      layers: [
        ["CCCCCCC","CPPPPPC","CPPPPPC","CPPPPPC","CPPPPPC","CPPPPPC","CCCCCCC"],
        ["LPPDPPL","P.....P","P.....P","P.....P","P.....P","P.....P","LPPPPPL"],
        ["LPGDGPL","G..T..G","P.....P","P.....P","P.....P","G.....G","LPGGGPL"],
        ["LPPPPPL","P.....P","P.....P","P.....P","P.....P","P.....P","LPPPPPL"],
        ["SSSSSSS","SPPPPPS","SPPPPPS","SPPPPPS","SPPPPPS","SPPPPPS","SSSSSSS"],
        [".......",".SSSSS.",".SPPPS.",".SPPPS.",".SPPPS.",".SSSSS.","......."],
        [".......",".......","..SSS..","..SSS..","..SSS..",".......","......."]
      ]
    },
    {
      id: "watchtower", name: "Watchtower",
      desc: "5×5 cobblestone tower, 8 blocks tall, with a ladder up the middle.",
      palette: {
        C: ["Cobblestone", "#8a8a8a"], H: ["Ladder", "#c9a15c"],
        F: ["Fence", "#6e5530"], P: ["Oak Planks", "#b8945f"], T: ["Torch", "#ffd75e"]
      },
      layers: [
        ["CCCCC","CCCCC","CCCCC","CCCCC","CCCCC"],
        ["CCCCC","C...C","C.H.C","C...C","CCCCC"],
        ["CCCCC","C...C","C.H.C","C...C","CCCCC"],
        ["CCCCC","C...C","C.H.C","C...C","CCCCC"],
        ["CCCCC","C...C","C.H.C","C...C","CCCCC"],
        ["CCCCC","C...C","C.H.C","C...C","CCCCC"],
        ["CCCCC","CPPPC","CPHPC","CPPPC","CCCCC"],
        ["F.F.F",".....","F.T.F",".....","F.F.F"]
      ]
    },
    {
      id: "nether-portal", name: "Nether Portal",
      desc: "Standing portal frame, 4 wide × 5 tall (10 obsidian, corners skipped).",
      palette: { O: ["Obsidian", "#241b3a"] },
      layers: [
        [".OO."],
        ["O..O"],
        ["O..O"],
        ["O..O"],
        [".OO."]
      ],
      note: "This one is a WALL, not a floor plan: build each layer on top of the last, all in one flat line. Light the inside with flint and steel."
    },
    {
      id: "wheat-farm", name: "Wheat Farm",
      desc: "Classic 9×9 farm — water in the middle waters every block.",
      palette: {
        W: ["Water", "#3b6fd4"], D: ["Farmland (hoe dirt)", "#79553a"],
        L: ["Oak Log border", "#6e5530"], S: ["Wheat Seeds", "#a5c94f"], T: ["Torch", "#ffd75e"]
      },
      layers: [
        ["LLLLLLLLL","LDDDDDDDL","LDDDDDDDL","LDDDDDDDL","LDDDWDDDL","LDDDDDDDL","LDDDDDDDL","LDDDDDDDL","LLLLLLLLL"],
        ["T.......T",".SSSSSSS.",".SSSSSSS.",".SSSSSSS.",".SSS.SSS.",".SSSSSSS.",".SSSSSSS.",".SSSSSSS.","T.......T"]
      ]
    },
    {
      id: "storage-room", name: "Storage Room",
      desc: "7×5 underground-style storage with chests along the walls.",
      palette: {
        P: ["Oak Planks", "#b8945f"], C: ["Chest", "#c78e28"],
        B: ["Crafting Table", "#8a6d3b"], F: ["Furnace", "#6f6f6f"], T: ["Torch", "#ffd75e"]
      },
      layers: [
        ["PPPPPPP","PPPPPPP","PPPPPPP","PPPPPPP","PPPPPPP"],
        ["CCC.CCC","C.....C","C.....C","C.....B","CCC.CFF"],
        ["T.....T",".......",".......",".......","T.....T"]
      ]
    }
  ];

  /* ---------------- state ---------------- */
  var LS_KEY = "__blueprint.state";
  var state = { sel: null, layer: 0, hidden: false, view: "2d", rot: 0 };
  try { var s = JSON.parse(localStorage.getItem(LS_KEY) || "null"); if (s && typeof s === "object") state = s; } catch (e) {}
  if (state.view !== "3d") state.view = "2d";
  state.rot = (state.rot | 0) % 4;
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {} }
  function current() {
    for (var i = 0; i < BLUEPRINTS.length; i++) if (BLUEPRINTS[i].id === state.sel) return BLUEPRINTS[i];
    return null;
  }

  /* ---------------- host + shadow UI ---------------- */
  var HOST_CSS = "position:fixed;inset:0;pointer-events:none;z-index:2147483000;";
  var host = document.createElement("div");
  host.id = "__blueprint-host";
  host.style.cssText = HOST_CSS;
  var root = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent = [
    "*{box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif}",
    ".btn{position:fixed;bottom:14px;right:14px;pointer-events:auto;background:#1d2b45;color:#fff;border:1px solid #4f79c7;border-radius:10px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.5)}",
    ".btn:hover{background:#27406b}",
    ".panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(430px,92vw);max-height:80vh;overflow:auto;pointer-events:auto;background:#101827f2;color:#e8eefc;border:1px solid #3a5a96;border-radius:14px;padding:14px;box-shadow:0 8px 40px rgba(0,0,0,.6)}",
    ".panel h2{margin:0 0 4px;font-size:17px}",
    ".panel .sub{color:#9db2d8;font-size:12px;margin:0 0 10px}",
    ".card{background:#182339;border:1px solid #2c3e63;border-radius:10px;padding:10px;margin:8px 0;cursor:pointer}",
    ".card:hover{border-color:#5c8ae0;background:#1c2a45}",
    ".card b{font-size:14px}",
    ".card p{margin:3px 0 0;font-size:12px;color:#a8bade}",
    ".x{float:right;background:none;border:none;color:#9db2d8;font-size:16px;cursor:pointer}",
    ".hud{position:fixed;top:12px;left:12px;pointer-events:auto;background:#101827d9;color:#e8eefc;border:1px solid #3a5a96;border-radius:12px;padding:10px;max-width:46vw;box-shadow:0 4px 20px rgba(0,0,0,.45)}",
    ".hud h3{margin:0 0 6px;font-size:13px}",
    ".hud .lay{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px}",
    ".hud .lay button{background:#24365c;border:1px solid #44639f;color:#fff;border-radius:6px;padding:2px 9px;cursor:pointer;font-size:13px}",
    ".grid{display:grid;gap:1px;background:#0a0f1a;padding:3px;border-radius:6px;width:max-content}",
    ".cell{width:16px;height:16px;border-radius:2px}",
    ".legend{margin-top:7px;font-size:11px;color:#c6d4ee}",
    ".legend div{display:flex;align-items:center;gap:5px;margin-top:2px}",
    ".sw{width:10px;height:10px;border-radius:2px;display:inline-block}",
    ".hint{margin-top:6px;font-size:10px;color:#8aa0c8}",
    ".note{margin-top:6px;font-size:11px;color:#ffd75e}",
    ".tabs{display:flex;gap:4px;margin-bottom:6px}",
    ".tabs button{flex:1;background:#16223a;border:1px solid #2c3e63;color:#9db2d8;border-radius:6px;padding:3px 0;font-size:11px;cursor:pointer}",
    ".tabs button.on{background:#24365c;border-color:#5c8ae0;color:#fff}",
    ".iso{background:#0a0f1a;border-radius:6px;display:block}"
  ].join("\n");
  root.appendChild(style);

  var btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "📐 Blueprints";
  btn.onclick = function () { panel.hidden = !panel.hidden; renderPanel(); };
  root.appendChild(btn);

  var panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;
  root.appendChild(panel);

  var hud = document.createElement("div");
  hud.className = "hud";
  hud.hidden = true;
  root.appendChild(hud);

  /* ---------------- rendering ---------------- */
  function renderPanel() {
    if (panel.hidden) return;
    var h = "<button class='x' data-x>✕</button><h2>📐 Blueprints</h2>" +
      "<p class='sub'>Pick a build. In game: <b>[</b> and <b>]</b> change layer, <b>B</b> hides the overlay.</p>";
    for (var i = 0; i < BLUEPRINTS.length; i++) {
      var b = BLUEPRINTS[i], t = totals(b), n = 0, k;
      for (k in t) n += t[k];
      h += "<div class='card' data-id='" + b.id + "'><b>" + (b.id === state.sel ? "✅ " : "") + b.name + "</b>" +
        "<p>" + b.desc + "</p><p>" + b.layers.length + " layers · " + n + " blocks</p></div>";
    }
    if (state.sel) h += "<div class='card' data-stop><b>🚫 Stop building</b><p>Hide the blueprint overlay.</p></div>";
    panel.innerHTML = h;
    panel.querySelector("[data-x]").onclick = function () { panel.hidden = true; };
    panel.querySelectorAll(".card").forEach(function (c) {
      c.onclick = function () {
        if (c.hasAttribute("data-stop")) { state.sel = null; }
        else { state.sel = c.getAttribute("data-id"); state.layer = 0; state.hidden = false; }
        save(); panel.hidden = true; renderPanel(); renderHud();
      };
    });
  }

  function totals(b) {
    var t = {};
    b.layers.forEach(function (layer) {
      layer.forEach(function (row) {
        for (var i = 0; i < row.length; i++) {
          var ch = row[i];
          if (ch !== "." && ch !== " " && b.palette[ch]) t[ch] = (t[ch] || 0) + 1;
        }
      });
    });
    return t;
  }

  /* ---------------- 3D isometric preview ---------------- */
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.min(255, ((n >> 16) & 255) * f | 0),
        g = Math.min(255, ((n >> 8) & 255) * f | 0),
        b = Math.min(255, (n & 255) * f | 0);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function dims(b) {
    var rows = 0, cols = 0;
    b.layers.forEach(function (layer) {
      rows = Math.max(rows, layer.length);
      layer.forEach(function (row) { cols = Math.max(cols, row.length); });
    });
    return { rows: rows, cols: cols };
  }

  function drawIso(canvas, b) {
    var d = dims(b), rows = d.rows, cols = d.cols, n = b.layers.length;
    var rot = state.rot % 4;
    var W = rot % 2 ? rows : cols, D = rot % 2 ? cols : rows;

    var tw = Math.max(6, Math.min(20, Math.floor(340 / (W + D))));
    var th = tw / 2, bh = Math.round(tw * 0.62);
    var pad = 8;
    var cw = (W + D) * tw / 2 + pad * 2;
    var chh = (W + D) * th / 2 + n * bh + pad * 2;
    canvas.width = cw * 2; canvas.height = chh * 2;         // 2x for crisp text-size pixels
    canvas.style.width = cw + "px"; canvas.style.height = chh + "px";
    var ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    var ox = pad + D * tw / 2, oy = pad + n * bh;

    function cell(layerIdx, gx, gz) {           // rotated grid -> original chars
      var x, z;
      if (rot === 0) { x = gx; z = gz; }
      else if (rot === 1) { x = gz; z = rows - 1 - gx; }
      else if (rot === 2) { x = cols - 1 - gx; z = rows - 1 - gz; }
      else { x = cols - 1 - gz; z = gx; }
      var row = b.layers[layerIdx][z];
      var ch = row ? row[x] : ".";
      return (ch && ch !== "." && ch !== " " && b.palette[ch]) ? ch : null;
    }

    for (var y = 0; y < n; y++) {
      var above = y > state.layer;
      ctx.globalAlpha = above ? 0.13 : 1;
      for (var s = 0; s <= W + D - 2; s++) {
        for (var gx = 0; gx < W; gx++) {
          var gz = s - gx;
          if (gz < 0 || gz >= D) continue;
          var ch = cell(y, gx, gz);
          if (!ch) continue;
          var c = b.palette[ch][1];
          var sx = ox + (gx - gz) * tw / 2;
          var sy = oy + (gx + gz) * th / 2 - y * bh;
          // top
          ctx.fillStyle = shade(c, 1.18);
          ctx.beginPath();
          ctx.moveTo(sx, sy - bh);
          ctx.lineTo(sx + tw / 2, sy - bh + th / 2);
          ctx.lineTo(sx, sy - bh + th);
          ctx.lineTo(sx - tw / 2, sy - bh + th / 2);
          ctx.closePath(); ctx.fill();
          // left
          ctx.fillStyle = shade(c, 0.72);
          ctx.beginPath();
          ctx.moveTo(sx - tw / 2, sy - bh + th / 2);
          ctx.lineTo(sx, sy - bh + th);
          ctx.lineTo(sx, sy + th);
          ctx.lineTo(sx - tw / 2, sy + th / 2);
          ctx.closePath(); ctx.fill();
          // right
          ctx.fillStyle = shade(c, 0.5);
          ctx.beginPath();
          ctx.moveTo(sx + tw / 2, sy - bh + th / 2);
          ctx.lineTo(sx, sy - bh + th);
          ctx.lineTo(sx, sy + th);
          ctx.lineTo(sx + tw / 2, sy + th / 2);
          ctx.closePath(); ctx.fill();
          // current-layer highlight on the top face
          if (y === state.layer) {
            ctx.strokeStyle = "rgba(255,255,255,.85)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sx, sy - bh);
            ctx.lineTo(sx + tw / 2, sy - bh + th / 2);
            ctx.lineTo(sx, sy - bh + th);
            ctx.lineTo(sx - tw / 2, sy - bh + th / 2);
            ctx.closePath(); ctx.stroke();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function renderHud() {
    var b = current();
    if (!b || state.hidden) { hud.hidden = true; return; }
    hud.hidden = false;
    if (state.layer >= b.layers.length) state.layer = b.layers.length - 1;
    if (state.layer < 0) state.layer = 0;
    var layer = b.layers[state.layer];
    var below = state.layer > 0 ? b.layers[state.layer - 1] : null;
    var cols = 0, r;
    for (r = 0; r < layer.length; r++) cols = Math.max(cols, layer[r].length);

    var counts = {}, cy, cx, cch;
    for (cy = 0; cy < layer.length; cy++) {
      for (cx = 0; cx < layer[cy].length; cx++) {
        cch = layer[cy][cx];
        if (cch !== "." && cch !== " " && b.palette[cch]) counts[cch] = (counts[cch] || 0) + 1;
      }
    }
    var leg = "";
    for (var k in counts) leg += "<div><span class='sw' style='background:" + b.palette[k][1] + "'></span>" + b.palette[k][0] + " × " + counts[k] + "</div>";
    if (!leg) leg = "<div>(empty layer)</div>";

    var body, hint;
    if (state.view === "3d") {
      body = "<canvas class='iso'></canvas>";
      hint = "Bright outline = current layer · R or ↻ spin · [ ] layer · B hide";
    } else {
      var cells = "";
      for (var y = 0; y < layer.length; y++) {
        for (var x = 0; x < cols; x++) {
          var ch = layer[y][x] || ".", css = "background:transparent;border:1px solid #1d2a44";
          if (ch !== "." && ch !== " " && b.palette[ch]) {
            css = "background:" + b.palette[ch][1];
          } else if (below && below[y] && below[y][x] && below[y][x] !== "." && below[y][x] !== " " && b.palette[below[y][x]]) {
            css = "background:" + b.palette[below[y][x]][1] + ";opacity:.22";
          }
          cells += "<div class='cell' style='" + css + "'></div>";
        }
      }
      body = "<div class='grid' style='grid-template-columns:repeat(" + cols + ",16px)'>" + cells + "</div>";
      hint = "Faded = layer below · [ ] change layer · B hide";
    }

    hud.innerHTML = "<h3>📐 " + b.name + "</h3>" +
      "<div class='tabs'><button data-v='2d'" + (state.view === "2d" ? " class='on'" : "") + ">⬛ Layers</button>" +
      "<button data-v='3d'" + (state.view === "3d" ? " class='on'" : "") + ">🧊 3D</button>" +
      (state.view === "3d" ? "<button data-rot title='rotate'>↻</button>" : "") + "</div>" +
      "<div class='lay'><button data-d='-1'>▼</button> Layer <b>&nbsp;" + (state.layer + 1) + " / " + b.layers.length + "&nbsp;</b><button data-d='1'>▲</button><button data-close style='margin-left:auto'>✕</button></div>" +
      body +
      "<div class='legend'>" + leg + "</div>" +
      (b.note ? "<div class='note'>⚠️ " + b.note + "</div>" : "") +
      "<div class='hint'>" + hint + "</div>";

    if (state.view === "3d") drawIso(hud.querySelector("canvas"), b);

    hud.querySelectorAll("[data-d]").forEach(function (bt) {
      bt.onclick = function () { state.layer += +bt.getAttribute("data-d"); save(); renderHud(); };
    });
    hud.querySelectorAll("[data-v]").forEach(function (bt) {
      bt.onclick = function () { state.view = bt.getAttribute("data-v"); save(); renderHud(); };
    });
    var rb = hud.querySelector("[data-rot]");
    if (rb) rb.onclick = function () { state.rot = (state.rot + 1) % 4; save(); renderHud(); };
    hud.querySelector("[data-close]").onclick = function () { state.sel = null; save(); renderHud(); };
  }

  /* ---------------- keys (match key OR code — trusted events can miss code) */
  window.addEventListener("keydown", function (e) {
    // only while actually playing (mouse captured) — typing in chat can't trip these
    if (!current() || !document.pointerLockElement) return;
    var k = e.key, c = e.code;
    if (k === "]" || c === "BracketRight") { state.layer++; save(); renderHud(); }
    else if (k === "[" || c === "BracketLeft") { state.layer--; save(); renderHud(); }
    else if (k === "b" || k === "B" || c === "KeyB") { state.hidden = !state.hidden; save(); renderHud(); }
    else if ((k === "r" || k === "R" || c === "KeyR") && state.view === "3d" && !state.hidden) {
      state.rot = (state.rot + 1) % 4; save(); renderHud();
    }
  }, true);

  /* ---------------- show/hide with pointer lock ---------------- */
  function syncLock() {
    var locked = !!document.pointerLockElement;
    btn.style.display = locked ? "none" : "";
    if (locked) panel.hidden = true;
  }
  document.addEventListener("pointerlockchange", syncLock);

  /* ---------------- keep mounted (game wipes body + fullscreen traps paint) */
  function ensureMounted() {
    var want = document.fullscreenElement || document.body;
    if (!want) return;
    if (host.parentNode !== want) want.appendChild(host);
    if (host.style.cssText !== HOST_CSS) host.style.cssText = HOST_CSS;
  }
  document.addEventListener("fullscreenchange", ensureMounted);
  setInterval(ensureMounted, 500);

  function boot() { ensureMounted(); syncLock(); renderPanel(); renderHud(); }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();

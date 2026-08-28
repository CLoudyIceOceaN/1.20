# CloudClient

EaglercraftX 1.20 (EaglyMC 1.20-u7 WASM-GC) with **CloudClient** built in.

**Play: https://cloudyiceocean.github.io/1.20/**

Press the cloud button in the bottom-right corner (or Ctrl+Shift+C) for the mod
menu: toggle mods, change their settings, and add your own.

## What's in it

The game is one compiled WASM blob with no mod loader, so nothing can be
patched inside it. CloudClient works through the four doors the client does
leave open, and every mod is one of these:

| door | what it buys |
| --- | --- |
| `window.devicePixelRatio` | render scale - how many pixels the game draws |
| `localStorage["_eaglymc.g"]` | the game's own video and HUD options |
| IndexedDB `resourcePacks` | installing and selecting resource packs |
| the page around the canvas | overlays, wake lock, tab title |

**Performance:** Render Scale (live slider - 60% is about a third of the pixels
of full resolution), Fast Video Settings (Balanced / Fast / Potato presets plus
a render-distance slider), Freeze Animated Textures (installs a tiny pack that
gives water, lava, fire and portals a single frame, so the game stops
re-uploading them every frame), Frame Limit.

**Look & HUD:** the game's own FPS / coordinate readouts, a CloudClient
overlay, the watermark.

**Extras:** skip the launch countdown, keep the screen awake, rename the tab.

**TURBO** in the menu switches on everything that helps at once: 50% render
scale, Potato settings, frozen animations, 60 fps cap.

## Adding your own mods

Mod menu -> *My Mods* -> **+ Add a mod**. A mod is JavaScript that runs when
the game starts, and gets a helper object `cc`:

```js
cc.log('hello');                      // console
cc.canvas();                          // the game's <canvas>
cc.setRenderScale(50);                // percent
cc.setOptions({ renderDistance: '2' });  // the game's options (applies next launch)
cc.getOptions().then(o => cc.log(o.renderDistance));
cc.overlay('<b>on screen</b>');       // corner overlay
cc.onFrame(fps => { ... });           // every animation frame
```

Mods are saved in your browser and run on every launch. They can be edited,
switched off, or deleted from the same menu.

## Rebuilding

`index.html` is the stock client plus one line after `<head>`:

```html
<script src="cloudclient.js"></script>
```

Delete that line for the unmodified client. Source of the mod client and its
build scripts: `~/Documents/Claude/EaglerSodium/cloudclient.js`.

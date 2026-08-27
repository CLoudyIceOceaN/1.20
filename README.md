# 1.20

EaglercraftX 1.20 (EaglyMC 1.20-u7 WASM-GC), with **EaglerSodium** baked in.

Play: https://cloudyiceocean.github.io/1.20/

The only change to `index.html` is one `<script src="eaglersodium.js">` line at
the top of `<head>`. Delete it for the stock client.

## What EaglerSodium does

* **Render scale** - the game normally draws your screen times the display's
  pixel ratio. The mod reports a smaller ratio, so the game draws fewer pixels
  and the browser stretches the picture back out. 60% scale is ~2.8x fewer
  pixels to draw; that is the biggest FPS win available in a browser.
* **Fast settings** - rewrites the slow video options (render distance,
  mipmaps, particles, entity shadows, clouds, connected textures, FXAA) in
  localStorage before the game boots. Keybinds, skin and sound are untouched.
* **Skips the launch countdown.**

Open the panel with the small lightning button in the corner, or Ctrl+Shift+P:
resolution slider, Fast/Potato presets, and a reset.

Companion resource pack (freezes animated textures):
https://cloudyiceocean.github.io/modinth/resourcepack/eaglersodium

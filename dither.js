// Dithering engine: animated background + cover display with a Bayer-order dissolve.
// Exposes setCover(url) and Dither.playing; everything else is internal.

// Spotify's design guidelines say artwork must not be altered. Keep false
// for anything you distribute; flip to true for fully dithered covers on your own machine.
const DITHER_COVERS = false;

// style: pattern 'bayer' | 'noise' | 'halftone'; oneBit: 2 tones only; fixedHue: null = follow the cover
const Dither = { playing: false, oneBit: false, fixedHue: null };

const BAYER = (() => { // 8x8 Bayer threshold matrix, values in (0,1)
  let m = [[0]];
  for (let k = 0; k < 3; k++) {
    const n = m.length, r = [];
    for (let y = 0; y < n * 2; y++) { r[y] = [];
      for (let x = 0; x < n * 2; x++) r[y][x] = 4 * m[y % n][x % n] + [0, 2, 3, 1][(y >= n) * 2 + (x >= n)]; }
    m = r;
  }
  return m.flat().map(v => (v + .5) / 64);
})();
// threshold maps, tiled 64x64; TH is the active one (swapped by Dither.setPattern)
const PATTERNS = {
  bayer: (x, y) => BAYER[(y & 7) * 8 + (x & 7)],
  // interleaved gradient noise: organic grain, no visible grid
  noise: (x, y) => { const v = 52.9829189 * ((.06711056 * x + .00583715 * y) % 1); return (v % 1) * .98 + .01; },
  // halftone: dots grow from the centre of 8px cells on a 45° grid
  halftone: (x, y) => { const u = ((x + y) & 7) - 3.5, w = ((x - y) & 7) - 3.5; return Math.min(.99, .01 + Math.hypot(u, w) / 4.95); },
};
const TH = new Float64Array(64 * 64);
Dither.setPattern = name => {
  const f = PATTERNS[name] || PATTERNS.bayer;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) TH[y * 64 + x] = f(x, y);
  artDirty = true; lastBg = 0;
  if (curPix) redither?.();
};
const th = (x, y) => TH[(y & 63) * 64 + (x & 63)];
const q = (v, x, y, n) => Math.max(0, Math.min(n - 1, Math.floor(v * (n - 1) + th(x, y))));
function rgb(h, s, l) { // hsl -> packed ABGR for Uint32 ImageData
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l), k = n => (n + h / 30) % 12;
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (255 << 24) | (f(4) << 16) | (f(8) << 8) | f(0);
}

/* background: drifting dithered field that glows around the cover */
const S = 3; // screen px per dither pixel
const bg = document.getElementById('bg'), bctx = bg.getContext('2d');
let bimg, bbuf;
function resize() {
  bg.width = Math.ceil(innerWidth / S); bg.height = Math.ceil(innerHeight / S);
  bimg = bctx.createImageData(bg.width, bg.height); bbuf = new Uint32Array(bimg.data.buffer);
}
addEventListener('resize', resize); resize();

// glow centre/radius in dither px; cached, since reading layout every frame forces a reflow
let glow = { cx: 0, cy: 0, rad: 1 };
function measureGlow() {
  let r = art.getBoundingClientRect();
  if (document.body.classList.contains('login') || !r.width) r = { left: innerWidth / 2 - 160, top: innerHeight / 2 - 160, width: 320 };
  glow = { cx: (r.left + r.width / 2) / S, cy: (r.top + r.width / 2) / S, rad: r.width / S };
}

// trig hoisted out of the pixel loop (one sin per row and per column, not per pixel);
// same pixels as the naive version, ~5x less work
let colS = new Float64Array(0), dx2 = new Float64Array(0);
function paintBg(t, e, hue) {
  const W = bg.width, H = bg.height, ob = Dither.oneBit, n1 = ob ? 1 : 2;
  const pal = ob ? [rgb(hue, 30, 5), rgb(hue, 60, 26), 0] : [rgb(hue, 30, 5), rgb(hue, 50, 14), rgb(hue, 70, 32)];
  const { cx, cy, rad } = glow, g = .55 + .35 * e;
  if (colS.length !== W) { colS = new Float64Array(W); dx2 = new Float64Array(W); }
  for (let x = 0; x < W; x++) { colS[x] = .08 * Math.sin(x * .04 + t * .5); const dx = (x - cx) / rad; dx2[x] = dx * dx; }
  for (let y = 0; y < H; y++) {
    const sy = Math.sin(y * .05 - t * .35), base = .1 + .06 * Math.sin(y * .03 - t * 1.5), dy = (y - cy) / rad, dy2 = dy * dy, row = y * W, by = (y & 63) * 64;
    for (let x = 0; x < W; x++) {
      const k = Math.floor((base + colS[x] * sy + g / (1 + (dx2[x] + dy2) * 2.2)) * n1 + TH[by + (x & 63)]); // q(v, x, y, n1 + 1) inlined
      bbuf[row + x] = pal[k < 0 ? 0 : k > n1 ? n1 : k];
    }
  }
  bctx.putImageData(bimg, 0, 0);
}

/* cover: decoded into ImageData, swapped with a Bayer-ordered dissolve */
const art = document.getElementById('art'), actx = art.getContext('2d');
art.width = art.height = DITHER_COVERS ? 160 : 600;
art.style.imageRendering = DITHER_COVERS ? 'pixelated' : 'auto';
let curPix = null, prevPix = null, swapAt = 0, hueTarget = 300, coverHueNow = 300, coverUrl = '';
Dither.setHue = h => { Dither.fixedHue = h; hueTarget = h ?? coverHueNow; };
let redither = null; // re-runs the cover dither after a pattern change (DITHER_COVERS only)

function coverHue(img) { // hue of the most saturated pixel in an 8x8 downscale
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8);
  const d = x.getImageData(0, 0, 8, 8).data;
  let best = null, bs = .15;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), s = mx - Math.min(r, g, b);
    if (s > bs) { bs = s; const h = mx === r ? ((g - b) / s) % 6 : mx === g ? (b - r) / s + 2 : (r - g) / s + 4; best = (h * 60 + 360) % 360; }
  }
  return best;
}

function setCover(url) {
  if (!url || url === coverUrl) return;
  coverUrl = url;
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (url !== coverUrl) return; // a newer cover was requested meanwhile
    coverHueNow = coverHue(img) ?? coverHueNow; hueTarget = Dither.fixedHue ?? coverHueNow;
    const c = document.createElement('canvas'); c.width = c.height = art.width;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height);
    if (DITHER_COVERS) {
      const pal = [rgb(hueTarget, 30, 5), rgb(hueTarget, 60, 30), rgb(hueTarget, 85, 58), rgb(hueTarget, 95, 85)];
      const px = new Uint32Array(d.data.buffer), W = c.width;
      for (let i = 0; i < px.length; i++) {
        const l = (.299 * d.data[i * 4] + .587 * d.data[i * 4 + 1] + .114 * d.data[i * 4 + 2]) / 255;
        px[i] = pal[q(l, i % W, i / W | 0, 4)];
      }
    }
    prevPix = curPix; curPix = d; swapAt = performance.now();
  };
  img.src = url;
}

function paintArt(p) {
  if (!prevPix) return actx.putImageData(curPix, 0, 0);
  const W = art.width, out = actx.createImageData(W, W), o = new Uint32Array(out.data.buffer);
  const a = new Uint32Array(prevPix.data.buffer), b = new Uint32Array(curPix.data.buffer), s = DITHER_COVERS ? 0 : 3;
  for (let i = 0; i < o.length; i++) o[i] = th((i % W) >> s, (i / W | 0) >> s) > p ? a[i] : b[i];
  actx.putImageData(out, 0, 0);
}

new ResizeObserver(measureGlow).observe(art);
new MutationObserver(measureGlow).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // login / mini
addEventListener('resize', measureGlow);

let time = 0, last = 0, hue = 300, artDirty = true, shownHue = -1, lastBg = 0;
Dither.setPattern('bayer');
(function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, (now - last) / 1000 || 0); last = now;
  time += dt * (Dither.playing ? 1 : .15);
  // ponytail: gentle breathing, not real audio reactivity (DRM audio can't be analysed, audio-analysis API is closed to new apps)
  const e = Dither.playing ? .5 + .5 * Math.sin(time * 3) : 0;
  hue += (hueTarget - hue) * Math.min(1, dt * 4);
  if (Math.abs(hue - shownHue) > .05) { shownHue = hue; document.documentElement.style.setProperty('--hue', hue.toFixed(1)); } // restyles the whole page: only on change
  if (now - lastBg >= (Dither.playing ? 33 : 100)) { lastBg = now; paintBg(time, e, hue); } // background: 30 fps playing, 10 fps paused
  if (curPix) {
    const p = Math.min(1, (now - swapAt) / 700);
    if (p < 1 || artDirty) { paintArt(p); artDirty = p < 1; }
    if (p >= 1) prevPix = null;
  }
  Dither.onFrame?.();
})(0);

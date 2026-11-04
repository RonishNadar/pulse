/* Pulse: a dithered local music player. Library, playback (crossfade + gapless), queue, views.
   Visuals live in dither.js; palette, lyrics, stats, tag editor and settings in extras.js. */

const $ = id => document.getElementById(id);
// ⌘ on macOS, Ctrl elsewhere; labels are written Mac-style and translated
const MAC = pulse.platform === 'darwin', WIN = pulse.platform === 'win32', MOD = MAC ? 'metaKey' : 'ctrlKey';
const keyLabel = s => MAC ? s : s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+');
const FINDER = MAC ? 'Finder' : WIN ? 'Explorer' : 'folder';
document.body.classList.add(MAC ? 'mac' : 'wco'); // wco: window controls overlay (Windows/Linux)
for (const el of document.querySelectorAll('[title], [placeholder]')) {
  if (el.title) el.title = keyLabel(el.title);
  if (el.placeholder) el.placeholder = keyLabel(el.placeholder);
}
const fmt = ms => { const s = Math.max(0, ms / 1000 | 0); return `${s / 60 | 0}:${String(s % 60).padStart(2, '0')}`; };
const fill = el => el.style.setProperty('--p', (el.value / el.max) * 100 + '%');
const songs = n => `${(+n).toLocaleString()} song${+n === 1 ? '' : 's'}`;
const minutes = sec => sec < 60 ? `${Math.round(sec)} s` : sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round(sec % 3600 / 60)} min` : `${Math.round(sec / 60)} min`;
const shuffled = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

// children may be nested arrays, null/false (skipped) or numbers; strings become text nodes, never HTML
const kids = k => k.flat(Infinity).filter(x => x != null && x !== false).map(x => typeof x === 'number' ? String(x) : x);
const fillIn = (el, ...k) => el.replaceChildren(...kids(k));
// h('div', { class: 'x', onclick }, 'text', child)
function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e[k.toLowerCase()] = v;
    else if (k in e && !k.includes('-')) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids(children));
  return e;
}
const img = (src, cls = '') => h('img', { class: cls, src: src || null, alt: '', loading: 'lazy' });
const PLAY_SVG = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>';
const icon = svg => { const t = document.createElement('template'); t.innerHTML = svg; return t.content.firstChild; }; // constants only

const ago = at => {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = String(msg instanceof Error ? msg.message : msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

/* ---------- library index ---------- */
let L = { tracks: new Map(), list: [], albums: new Map(), artists: new Map(), genres: new Map(), folders: [] };
const albumKey = t => `${t.albumArtist.toLowerCase()}\u0001${t.album.toLowerCase()}`;
const byAlbumOrder = (x, y) => (x.disc - y.disc) || (x.track - y.track) || x.title.localeCompare(y.title);

function indexLibrary(snap) {
  const tracks = new Map(), albums = new Map(), artists = new Map(), genres = new Map();
  const artist = name => { const k = name.toLowerCase(); let a = artists.get(k); if (!a) artists.set(k, a = { name, tracks: [], albums: new Set() }); return a; };
  for (const t of snap.tracks) {
    tracks.set(t.id, t);
    const k = albumKey(t);
    let a = albums.get(k);
    if (!a) albums.set(k, a = { key: k, title: t.album, artist: t.albumArtist, year: 0, art: null, added: 0, tracks: [] });
    a.tracks.push(t); a.year ||= t.year; a.art ||= t.artUrl; a.added = Math.max(a.added, t.added);
    artist(t.albumArtist).albums.add(a);
    for (const name of new Set([t.albumArtist, ...t.artists])) artist(name).tracks.push(t);
    if (t.genre) { const gk = t.genre.toLowerCase(); let g = genres.get(gk); if (!g) genres.set(gk, g = { name: t.genre, tracks: [] }); g.tracks.push(t); }
  }
  for (const a of albums.values()) a.tracks.sort(byAlbumOrder);
  L = { tracks, list: snap.tracks, albums, artists, genres, folders: snap.folders };
  $('me').textContent = `${tracks.size.toLocaleString()} SONGS`;
}
// anything without art gets a generated dithered cover: same name, same pattern (rings, waves or an orb)
const genCache = new Map();
function genArt(seed) {
  if (genCache.has(seed)) return genCache.get(seed);
  let n = 7; for (const ch of seed) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), d = x.createImageData(S, S), px = new Uint32Array(d.data.buffer);
  const hue = n % 360, kind = (n >>> 9) % 3, f1 = 2 + (n >>> 3) % 5, f2 = 1 + (n >>> 6) % 4, ph = (n % 628) / 100;
  const pal = [rgb(hue, 30, 8), rgb(hue, 60, 30), rgb(hue, 85, 55), rgb(hue, 95, 80)];
  for (let y = 0; y < S; y++) for (let X = 0; X < S; X++) {
    const u = X / S * 2 - 1, v = y / S * 2 - 1;
    const val = kind === 0 ? .5 + .5 * Math.sin(Math.hypot(u, v) * f1 * 3 - ph)
      : kind === 1 ? .5 + .5 * Math.sin(u * f1 + Math.sin(v * f2 * 2 + ph) * 2)
      : Math.max(0, 1 - Math.hypot(u - .3 * Math.cos(ph), v + .3 * Math.sin(ph)) * (1 + f2 * .3));
    px[y * S + X] = pal[q(val * .9 + .05, X, y, 4)];
  }
  x.putImageData(d, 0, 0);
  const url = c.toDataURL();
  genCache.set(seed, url);
  return url;
}
const albumArt = a => a.art || genArt('album:' + a.key);
const trackArt = t => t.artUrl || genArt('album:' + albumKey(t));
const artistArt = ar => [...ar.albums].find(a => a.art)?.art || ar.tracks.find(t => t.artUrl)?.artUrl || genArt('artist:' + ar.name.toLowerCase());
const albumOf = t => L.albums.get(albumKey(t));

// the row model trackTable() draws
const row = (t, extra) => t && ({
  id: t.id, uri: t.id, name: t.title, ms: t.duration * 1000, img: trackArt(t), playable: t.playable,
  artists: t.artists.map(n => ({ name: n, uri: 'artist:' + n.toLowerCase() })),
  album: { name: t.album, uri: 'album:' + albumKey(t) }, ...extra,
});

/* ---------- your data: likes, playlists, play history (kept by the main process) ---------- */
let D = { likes: {}, playlists: [], plays: [] };
const saveD = key => pulse.store.set(key, D[key]);
const isLiked = id => !!D.likes[id];
function setLiked(ids, on) {
  for (const id of [].concat(ids)) { if (on) D.likes[id] = Date.now(); else delete D.likes[id]; }
  saveD('likes'); showHeart();
}
let countsCache = null;
const playCounts = () => countsCache ||= D.plays.reduce((m, p) => m.set(p.id, (m.get(p.id) || 0) + 1), new Map());

/* ---------- playback: two decks, so the next song can fade in (crossfade) or start on the beat (gapless) ---------- */
const onTrack = [], onTick = [], onPlayed = []; // extras.js hooks: track changed / every frame / counted as a play
const decks = [new Audio(), new Audio()];
for (const d of decks) d.preload = 'auto';
let live = 0, now = null, seeking = false, transition = null;
const Q = { items: [], base: [], index: -1, shuffle: false, repeat: 'off', from: null };
const deck = () => decks[live], spare = () => decks[1 - live];
const savedVolume = () => { const v = parseFloat(localStorage.getItem('pulse.volume')); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : .8; };
let master = savedVolume();
const crossfade = () => +localStorage.getItem('pulse.crossfade') || 0; // seconds; 0 = off
const position = () => deck().currentTime || 0;
const length = () => (Number.isFinite(deck().duration) && deck().duration) || now?.duration || 0;

function load(d, t, at = 0) {
  d.dataset.id = t.id;
  d.src = t.url;
  if (at) d.addEventListener('loadedmetadata', () => { d.currentTime = at; }, { once: true });
}

function nextIndex() {
  if (Q.repeat === 'one') return Q.index;
  if (Q.index + 1 < Q.items.length) return Q.index + 1;
  return Q.repeat === 'all' && Q.items.length ? 0 : -1;
}

// start the song at Q position i on the live deck
function start(i, { at = 0, autoplay = true } = {}) {
  endTransition();
  const t = L.tracks.get(Q.items[i]);
  if (!t) return;
  if (!t.playable) { toast(`Can’t play “${t.title}”: ${t.codec} isn’t supported. Skipping.`); Q.index = i; const n = nextIndex(); return n >= 0 && n !== i ? start(n) : null; }
  Q.index = i;
  spare().pause();
  const d = deck();
  load(d, t, at);
  d.volume = master;
  if (autoplay) d.play().catch(e => toast(e.message));
  setNow(t);
  prepareNext();
}

// keep the following song loaded on the spare deck, ready to fade in
function prepareNext() {
  const n = nextIndex(), t = n >= 0 && L.tracks.get(Q.items[n]);
  if (t && t.playable && spare().dataset.id !== t.id) load(spare(), t);
  renderQueueIfOpen();
}

// same album, consecutive tracks: no crossfade (live albums and DJ mixes flow into each other)
const gaplessPair = (a, b) => a && b && albumKey(a) === albumKey(b) && b.disc === a.disc && b.track === a.track + 1;

function engine() {
  const d = deck();
  if (!now || d.paused) return;
  if (transition) { // fading
    const p = Math.min(1, (performance.now() - transition.t0) / transition.ms);
    transition.out.volume = master * (1 - p);
    d.volume = master * p;
    if (p >= 1) endTransition();
    return;
  }
  const n = nextIndex();
  if (n < 0 || Q.repeat === 'one' || !Number.isFinite(d.duration)) return;
  const next = L.tracks.get(Q.items[n]);
  if (!next?.playable) return;
  const gapless = crossfade() === 0 || gaplessPair(now, next);
  const lead = gapless ? .06 : Math.min(crossfade(), d.duration / 3);
  if (d.duration - d.currentTime > lead) return;
  // hand over: the spare deck (already loaded) becomes live
  const out = d, inn = spare();
  if (inn.dataset.id !== next.id) load(inn, next);
  inn.currentTime = 0;
  inn.volume = gapless ? master : 0;
  inn.play().catch(() => {});
  live = 1 - live;
  Q.index = n;
  transition = { out, t0: performance.now(), ms: lead * 1000 }; // gapless: a 60 ms overlap, ramped so there's no click
  setNow(next);
}
setInterval(engine, 30); // timers keep running when the window is hidden (backgroundThrottling is off)

function endTransition() {
  if (!transition) return;
  transition.out.pause();
  transition = null;
  deck().volume = master;
  prepareNext();
}

for (const d of decks) {
  d.addEventListener('ended', () => { // a song ran out with no hand-over (end of queue, repeat one, not ready)
    if (d !== deck()) return;
    const n = nextIndex();
    if (n >= 0) start(n); else { setNow(now); d.currentTime = 0; }
  });
  d.addEventListener('play', () => d === deck() && playState());
  d.addEventListener('pause', () => d === deck() && playState());
  d.addEventListener('error', () => { if (d === deck() && now) toast(`Couldn’t play “${now.title}” (file missing or unreadable).`); });
}

function playState() {
  const paused = !now || deck().paused;
  Dither.playing = !paused;
  document.body.classList.toggle('paused', paused);
  $('play').ariaLabel = paused ? 'Play' : 'Pause';
  navigator.mediaSession.playbackState = now ? (paused ? 'paused' : 'playing') : 'none';
}

// play a list of songs (ids), starting at index i: an album, playlist, search result...
function playList(ids, i = 0, from = null) {
  ids = ids.filter(id => L.tracks.has(id));
  if (!ids.length) return toast('Nothing to play here.');
  Q.base = ids.slice(); Q.from = from;
  if (Q.shuffle) { Q.items = [ids[i], ...shuffled(ids.filter((_, k) => k !== i))]; start(0); }
  else { Q.items = ids.slice(); start(i); }
}
const playShuffled = (ids, from) => { Q.shuffle = true; showModes(); playList(ids, Math.random() * ids.length | 0, from); };

const ctl = {
  toggle() {
    if (!now) return Q.items.length ? start(Math.max(0, Q.index)) : toast('Pick something to play.');
    if (deck().paused) { deck().play().catch(e => toast(e.message)); transition?.out.play(); }
    else { deck().pause(); transition?.out.pause(); }
  },
  // the button always moves on (repeat-one only repeats when a song ends by itself); wraps unless repeat is off
  next() { const n = Q.index + 1 < Q.items.length ? Q.index + 1 : Q.repeat !== 'off' && Q.items.length ? 0 : -1; if (n >= 0) start(n); },
  prev() { if (position() > 3 || Q.index <= 0) { deck().currentTime = 0; return; } start(Q.index - 1); },
  seek(sec) { endTransition(); deck().currentTime = sec; },
  volume(v) { master = v; if (!transition) deck().volume = v; },
  shuffle() {
    Q.shuffle = !Q.shuffle;
    const cur = Q.items[Q.index];
    if (Q.shuffle) Q.items = cur ? [cur, ...shuffled(Q.items.filter((_, k) => k !== Q.index))] : shuffled(Q.items);
    else Q.items = Q.base.length ? Q.base.slice() : Q.items;
    Q.index = Math.max(0, Q.items.indexOf(cur));
    showModes(); prepareNext();
  },
  repeat() { Q.repeat = { off: 'all', all: 'one', one: 'off' }[Q.repeat]; showModes(); prepareNext(); },
};

// queue edits (Up Next): positions are indexes into Q.items
const queue = {
  playNext(ids) { Q.items.splice(Q.index + 1, 0, ...ids); toast(ids.length > 1 ? `${songs(ids.length)} play next` : 'Plays next'); prepareNext(); },
  add(ids) { if (Q.index < 0) return playList(ids); Q.items.push(...ids); toast(ids.length > 1 ? `Added ${songs(ids.length)} to Up Next` : 'Added to Up Next'); prepareNext(); },
  remove(i) { if (i > Q.index) { Q.items.splice(i, 1); prepareNext(); } },
  move(from, to) { if (from <= Q.index || to <= Q.index) return; const [x] = Q.items.splice(from, 1); Q.items.splice(to, 0, x); prepareNext(); },
  clear() { Q.items.splice(Q.index + 1); prepareNext(); },
};

function showModes() {
  $('shuffle').classList.toggle('on', Q.shuffle);
  $('repeat').classList.toggle('on', Q.repeat !== 'off');
  $('repeatOne').hidden = Q.repeat !== 'one';
}

// counting a play (and Last.fm, via onPlayed): half the song or 4 minutes, whichever comes first
let listen = null;
function setNow(t) {
  const changed = t?.id !== now?.id;
  now = t;
  playState();
  if (!t) {
    $('title').textContent = 'NOTHING PLAYING'; $('artist').replaceChildren('Pick something to play'); $('like').hidden = true; $('status').textContent = ' ';
    navigator.mediaSession.metadata = null;
    return markPlaying();
  }
  if (!changed && listen?.id === t.id) return;
  listen = { id: t.id, start: Date.now(), heard: 0, need: Math.min(t.duration / 2, 240), counted: t.duration < 30 };
  $('title').textContent = t.title;
  fillIn($('artist'), artistLinks(row(t).artists));
  $('status').textContent = [t.codec, t.lossless ? 'LOSSLESS' : t.bitrate ? `${t.bitrate} KBPS` : '', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} KHZ` : ''].filter(Boolean).join(' · ').toUpperCase();
  setCover(trackArt(t));
  showHeart();
  markPlaying();
  renderQueueIfOpen();
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: [{ src: trackArt(t), sizes: '512x512' }] });
  onTrack.forEach(f => f(t));
}
let lastTick = performance.now();
setInterval(() => {
  const t = performance.now(), dt = (t - lastTick) / 1000; lastTick = t;
  if (!now || !listen || deck().paused || listen.id !== now.id) return;
  listen.heard += Math.min(dt, 1);
  if (!listen.counted && listen.heard >= listen.need) {
    listen.counted = true;
    D.plays.push({ id: now.id, at: listen.start }); countsCache = null; saveD('plays');
    onPlayed.forEach(f => f(now, Math.floor(listen.start / 1000)));
  }
}, 1000);

function markPlaying() {
  for (const r of document.querySelectorAll('.trow')) r.classList.toggle('on', !!now && r.dataset.uri === now.id);
}

function showHeart() {
  const b = $('like');
  b.hidden = !now;
  const on = !!now && isLiked(now.id);
  b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡'; b.ariaLabel = on ? 'Remove from Liked Songs' : 'Add to Liked Songs';
}
$('like').onclick = () => { if (now) { const on = !isLiked(now.id); setLiked(now.id, on); toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs'); } };

for (const [a, fn] of [['play', () => ctl.toggle()], ['pause', () => ctl.toggle()], ['nexttrack', () => ctl.next()], ['previoustrack', () => ctl.prev()]])
  navigator.mediaSession.setActionHandler(a, fn);
navigator.mediaSession.setActionHandler('seekto', e => ctl.seek(e.seekTime));

// progress bar runs off the frame loop in dither.js
Dither.onFrame = () => {
  onTick.forEach(f => f());
  if (!now || seeking) return;
  const pos = position(), len = length(), s = $('seek');
  s.max = len || 1; s.value = pos; fill(s);
  $('cur').textContent = fmt(pos * 1000); $('rem').textContent = '-' + fmt((len - pos) * 1000);
};

// where you left off: the queue and position, restored paused on the next launch
function saveSession() {
  if (!now) return;
  localStorage.setItem('pulse.session', JSON.stringify({ items: Q.items, base: Q.base, index: Q.index, shuffle: Q.shuffle, repeat: Q.repeat, from: Q.from, at: position() }));
}
setInterval(saveSession, 5000);
addEventListener('beforeunload', saveSession);
function restoreSession() {
  let s; try { s = JSON.parse(localStorage.getItem('pulse.session')); } catch {}
  if (!s?.items?.length) return;
  Object.assign(Q, { items: s.items.filter(id => L.tracks.has(id)), base: s.base.filter(id => L.tracks.has(id)), shuffle: s.shuffle, repeat: s.repeat, from: s.from });
  const i = Q.items.indexOf(s.items[s.index]);
  if (i >= 0) start(i, { at: s.at, autoplay: false });
  showModes();
}

/* ---------- shared UI ---------- */
function goUri(uri) {
  const i = uri.indexOf(':'), type = uri.slice(0, i), id = uri.slice(i + 1);
  if (['album', 'artist', 'playlist', 'genre', 'folder'].includes(type)) go({ v: type, id });
}
function link(text, uri) {
  return h('a', { class: 'link', href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); goUri(uri); } }, text);
}
const artistLinks = artists => artists.flatMap((a, i) => [i ? ', ' : null, a.uri ? link(a.name, a.uri) : a.name]);

// opts: { album: false } hides the album column; { playlist } enables remove; { reorder(from, to) } enables drag reordering
function trackTable(playFn, opts = {}) {
  const rows = [], ul = h('ul', { class: 'tracks' + (opts.album === false ? ' noalbum' : '') });
  ul.add = more => {
    const frag = document.createDocumentFragment();
    for (const t of more) {
      if (!t) continue;
      const i = rows.push(t) - 1;
      frag.append(h('li', { style: `--i:${Math.min(i % 50, 20)}` }, h('div', {
        class: 'row trow' + (t.playable === false ? ' off' : ''), role: 'button', tabIndex: 0, 'data-uri': t.uri,
        title: t.playable === false ? 'This format can’t be played' : null,
        onclick: () => playFn(i, rows), onkeydown: e => e.key === 'Enter' && playFn(i, rows),
        oncontextmenu: e => trackMenu(e, t, opts, ul, i),
        draggable: true,
        ondragstart: e => { e.dataTransfer.setData('pulse/track', t.id); e.dataTransfer.setData('pulse/pos', String(i)); e.dataTransfer.effectAllowed = 'copyMove'; },
        ondragover: opts.reorder ? e => { if (e.dataTransfer.types.includes('pulse/pos')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } } : null,
        ondragleave: opts.reorder ? e => e.currentTarget.classList.remove('drop') : null,
        ondrop: opts.reorder ? e => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const from = +e.dataTransfer.getData('pulse/pos'); if (Number.isFinite(from) && from !== i) opts.reorder(from, i); } : null,
      },
        h('span', { class: 'num' }, t.n ?? i + 1), img(t.img, 'thumb'),
        h('div', { class: 'clip' }, h('span', {}, t.name), h('small', {}, artistLinks(t.artists), t.when ? ' · ' + ago(t.when) : null)),
        opts.album === false ? null : h('span', { class: 'dim clip' }, h('span', {}, t.album ? link(t.album.name, t.album.uri) : '')),
        h('span', { class: 'dim' }, fmt(t.ms)))));
    }
    ul.append(frag);
    markPlaying();
  };
  return ul;
}
// big lists (all songs) are added in slices so the view appears at once
function addAll(table, rows) {
  table.add(rows.slice(0, 200));
  const mine = renderId;
  let i = 200;
  const step = () => { if (mine !== renderId || i >= rows.length) return; table.add(rows.slice(i, i += 400)); requestIdleCallback(step); };
  requestIdleCallback(step);
}
const playRows = from => (i, rows) => playList(rows.map(r => r.id), i, from);

function card({ title, sub, art, round, open, play, glyph }) {
  return h('div', { class: 'card', role: 'button', tabIndex: 0, onclick: open, onkeydown: e => e.key === 'Enter' && open() },
    h('div', { class: 'cimg' + (round ? ' round' : '') + (glyph && !art ? ' liked' : '') }, art ? img(art) : glyph || null,
      play ? h('button', { class: 'cplay', 'aria-label': 'Play ' + title, onclick: e => { e.stopPropagation(); play(); } }, icon(PLAY_SVG)) : null),
    h('b', {}, title), h('small', {}, sub));
}
const albumCard = a => card({ title: a.title, sub: [a.year || '', a.artist].filter(Boolean).join(' · '), art: albumArt(a), open: () => go({ v: 'album', id: a.key }), play: () => playList(a.tracks.map(t => t.id), 0, a.title) });
const artistCard = ar => card({ title: ar.name, sub: `${songs(ar.tracks.length)}`, art: artistArt(ar), round: true, glyph: ar.name[0], open: () => go({ v: 'artist', id: ar.name.toLowerCase() }), play: () => playShuffled(ar.tracks.map(t => t.id), ar.name) });
const playlistCard = p => card({ title: p.name, sub: `${songs(p.tracks.length)}`, art: playlistArt(p), glyph: '≡', open: () => go({ v: 'playlist', id: p.id }), play: () => playList(p.tracks, 0, p.name) });
const likedCard = () => card({ title: 'Liked Songs', sub: `${songs(Object.keys(D.likes).length)}`, glyph: '♥', open: () => go({ v: 'liked' }), play: () => playList(likedIds(), 0, 'Liked Songs') });
const playlistArt = p => p.cover || p.tracks.map(id => L.tracks.get(id)?.artUrl).find(Boolean) || genArt('playlist:' + p.id);
const likedIds = () => Object.entries(D.likes).sort((a, b) => b[1] - a[1]).map(([id]) => id).filter(id => L.tracks.has(id));

const shelf = (title, cards) => cards.length ? h('div', { class: 'shelf' }, h('h2', {}, title), h('div', { class: 'grid' }, cards)) : null;
function hero(cover, kind, title, meta) {
  return h('header', { class: 'hero' }, cover,
    h('div', { class: 'clip' }, h('small', {}, kind), h('h1', {}, title), h('p', { class: 'dim' }, meta)));
}
const coverImg = src => src ? img(src) : h('div', { class: 'liked' }, '♪');
const bigPlay = fn => h('button', { class: 'bigplay', 'aria-label': 'Play', onclick: fn }, icon('<svg width="24" height="24" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>'));
const btn = (label, fn, on) => h('button', { class: 'btn' + (on ? ' on' : ''), onclick: fn }, label);
const actions = (ids, from, ...more) => h('div', { class: 'actions' }, bigPlay(() => playList(ids, 0, from)), btn('SHUFFLE', () => playShuffled(ids, from)), ...more);
const totalTime = tracks => minutes(tracks.reduce((s, t) => s + t.duration, 0));

/* context menu */
function menu(e, items) {
  e.preventDefault();
  closeMenu();
  const m = h('div', { class: 'menu' }, items.filter(Boolean).map(it => it === '-' ? h('hr') :
    h('button', { onclick: () => { closeMenu(); it[1](); } }, it[0])));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}
const closeMenu = () => document.querySelector('.menu')?.remove();
addEventListener('pointerdown', e => { if (!e.target.closest('.menu')) closeMenu(); });
addEventListener('blur', closeMenu);

function trackMenu(e, r, opts, table, i) {
  const t = L.tracks.get(r.id);
  if (!t) return;
  const liked = isLiked(t.id);
  menu(e, [
    ['Play next', () => queue.playNext([t.id])],
    ['Add to Up Next', () => queue.add([t.id])],
    [liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', () => { setLiked(t.id, !liked); toast(liked ? 'Removed from Liked Songs' : 'Added to Liked Songs'); }],
    ['Add to playlist…', () => addToPlaylist([t.id])],
    opts.playlist && ['Remove from this playlist', () => {
      opts.playlist.tracks.splice(i, 1); saveD('playlists'); render(true); toast('Removed from playlist');
    }],
    '-',
    ['Go to artist', () => go({ v: 'artist', id: t.artists[0].toLowerCase() })],
    ['Go to album', () => go({ v: 'album', id: albumKey(t) })],
    ['Edit info…', () => editTags([t])],
    [`Show in ${FINDER}`, () => pulse.library.reveal(t.id)],
  ]);
}

/* modal: resolves with the value passed to done(), or null on cancel */
function modal(title, build) {
  return new Promise(resolve => {
    const done = v => { back.remove(); removeEventListener('keydown', esc, true); resolve(v); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const back = h('div', { class: 'modal', onclick: e => e.target === back && done(null) }, h('div', {}, h('h3', {}, title), build(done)));
    addEventListener('keydown', esc, true);
    document.body.append(back);
    back.querySelector('input, button')?.focus();
  });
}
const ask = (title, label, value) => modal(title, done => {
  const input = h('input', { class: 'search', placeholder: label, value });
  return h('form', { class: 'form', onsubmit: e => { e.preventDefault(); done(input.value.trim() || null); } },
    input, h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'CANCEL'), h('button', { class: 'btn on' }, 'OK')));
});

async function createPlaylist(ids = []) {
  const name = await ask('NEW PLAYLIST', 'Playlist name', 'My Playlist');
  if (!name) return null;
  const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, description: '', cover: null, tracks: ids, created: Date.now() };
  D.playlists.push(p); saveD('playlists'); renderSidebar();
  toast(ids.length ? `Created “${name}” with ${ids.length} song${ids.length > 1 ? 's' : ''}` : `Created “${name}”`);
  return p;
}

async function addToPlaylist(ids) {
  const pick = await modal('ADD TO PLAYLIST', done => h('div', { class: 'scroll', style: 'display:grid;gap:2px' },
    h('button', { class: 'row', onclick: () => done('new') }, h('div', { class: 'thumb liked' }, '+'), h('div', { class: 'clip' }, h('span', {}, 'New playlist…'))),
    D.playlists.map(p => h('button', { class: 'row', onclick: () => done(p.id) },
      img(playlistArt(p), 'thumb'), h('div', { class: 'clip' }, h('span', {}, p.name), h('small', {}, `${songs(p.tracks.length)}`))))));
  if (!pick) return;
  if (pick === 'new') return createPlaylist(ids);
  const p = D.playlists.find(x => x.id === pick);
  p.tracks.push(...ids); saveD('playlists'); renderSidebar();
  toast(`Added to “${p.name}”`);
}

/* ---------- router ---------- */
const hist = []; let hpos = -1, renderId = 0;
function go(route, replace = false) {
  if (replace && hpos >= 0) hist[hpos] = route;
  else { hist.splice(hpos + 1); hist.push(route); hpos = hist.length - 1; }
  render();
}
async function render(keepScroll = false) {
  const route = hist[hpos], mine = ++renderId, view = $('view'), top = view.scrollTop;
  $('back').disabled = hpos <= 0; $('fwd').disabled = hpos >= hist.length - 1;
  for (const n of document.querySelectorAll('.nav')) n.classList.toggle('on', n.dataset.v === route.v);
  for (const r of $('lists').querySelectorAll('.row')) r.classList.toggle('on', r.dataset.id === (route.v === 'liked' ? 'liked' : route.id));
  closeMenu();
  try {
    const node = await VIEWS[route.v](route);
    if (mine !== renderId) return;
    view.replaceChildren(node); view.scrollTop = keepScroll ? top : 0; markPlaying();
  } catch (e) {
    if (mine === renderId) view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message)));
  }
}

/* ---------- views ---------- */
function onboarding() {
  return h('div', { class: 'empty onboard' },
    h('div', { class: 'hello' }, 'YOUR MUSIC, DITHERED'),
    h('p', {}, 'Point Pulse at the folders where your music lives. It reads the tags and album art, and keeps up as you add songs.'),
    h('p', { class: 'dim' }, 'Plays MP3, AAC/M4A, FLAC, OGG, Opus and WAV.'),
    h('button', { class: 'cta', onclick: addFolder }, 'ADD A MUSIC FOLDER'));
}
async function addFolder() {
  try { const s = await pulse.library.addFolder(); indexLibrary(s); renderSidebar(); render(); }
  catch (e) { toast(e); }
}

const VIEWS = {
  home() {
    if (!L.folders.length) return onboarding();
    if (!L.tracks.size) return h('div', { class: 'empty' }, h('div', { class: 'hello' }, 'SCANNING…'), h('p', {}, 'Reading your music. Songs appear as soon as the first scan finishes.'));
    const hr = new Date().getHours(), counts = playCounts();
    const seen = new Set(), recentAlbums = [];
    for (const p of [...D.plays].reverse()) {
      const t = L.tracks.get(p.id), a = t && albumOf(t);
      if (a && !seen.has(a.key)) { seen.add(a.key); recentAlbums.push(a); if (recentAlbums.length >= 12) break; }
    }
    const albums = [...L.albums.values()];
    const added = albums.slice().sort((a, b) => b.added - a.added).slice(0, 12);
    const most = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => row(L.tracks.get(id))).filter(Boolean);
    const month = Date.now() - 30 * 864e5, lastPlayed = new Map(D.plays.map(p => [p.id, p.at]));
    const rediscover = shuffled(albums.filter(a => a.tracks.every(t => !(lastPlayed.get(t.id) > month)))).slice(0, 8);
    const mostTable = trackTable(playRows('Most played')); mostTable.add(most);
    return h('div', {},
      h('div', { class: 'hello' }, hr < 5 ? 'GOOD NIGHT' : hr < 12 ? 'GOOD MORNING' : hr < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'),
      shelf('JUMP BACK IN', recentAlbums.map(albumCard)),
      most.length ? h('div', { class: 'shelf' }, h('h2', {}, 'ON REPEAT'), mostTable) : null,
      shelf('RECENTLY ADDED', added.map(albumCard)),
      shelf('REDISCOVER', rediscover.map(albumCard)));
  },

  search({ q }) {
    if (!q) return h('div', { class: 'empty' }, h('p', {}, 'Search your hits, artists and albums.'));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = s => words.every(w => s.includes(w));
    const hits = L.list.filter(t => hit(`${t.title} ${t.artist} ${t.album}`.toLowerCase())).slice(0, 50);
    const artists = [...L.artists.values()].filter(a => hit(a.name.toLowerCase())).slice(0, 12);
    const albums = [...L.albums.values()].filter(a => hit(`${a.title} ${a.artist}`.toLowerCase())).slice(0, 12);
    const table = trackTable(playRows(`“${q}”`)); table.add(hits.map(t => row(t)));
    return h('div', {},
      hits.length ? h('div', { class: 'shelf' }, h('h2', {}, 'SONGS'), table) : null,
      shelf('ARTISTS', artists.map(artistCard)), shelf('ALBUMS', albums.map(albumCard)),
      !hits.length && !artists.length && !albums.length ? h('div', { class: 'empty' }, h('p', {}, `Nothing matches “${q}”.`)) : null);
  },

  library({ tab = 'albums', sort = 'recent' }) {
    if (!L.folders.length) return onboarding();
    const tabs = { albums: 'ALBUMS', artists: 'ARTISTS', songs: 'SONGS', genres: 'GENRES', folders: 'FOLDERS', playlists: 'PLAYLISTS' };
    const chips = h('div', { class: 'chips' }, Object.entries(tabs).map(([k, label]) => btn(label, () => go({ v: 'library', tab: k }, true), k === tab)));
    let body;
    if (tab === 'albums') {
      const sorters = { recent: (a, b) => b.added - a.added, title: (a, b) => a.title.localeCompare(b.title), artist: (a, b) => a.artist.localeCompare(b.artist) || a.year - b.year, year: (a, b) => b.year - a.year };
      body = [h('div', { class: 'chips' }, Object.entries({ recent: 'RECENTLY ADDED', title: 'A–Z', artist: 'ARTIST', year: 'YEAR' }).map(([k, l]) => btn(l, () => go({ v: 'library', tab, sort: k }, true), k === sort))),
        h('div', { class: 'grid' }, [...L.albums.values()].sort(sorters[sort] || sorters.recent).map(albumCard))];
    }
    if (tab === 'artists') body = h('div', { class: 'grid' }, [...L.artists.values()].filter(a => a.albums.size).sort((a, b) => a.name.localeCompare(b.name)).map(artistCard));
    if (tab === 'songs') {
      const all = L.list.slice().sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || byAlbumOrder(a, b));
      const table = trackTable(playRows('All songs')); addAll(table, all.map(t => row(t)));
      body = [h('div', { class: 'actions' }, bigPlay(() => playList(all.map(t => t.id), 0, 'All songs')), btn('SHUFFLE', () => playShuffled(all.map(t => t.id), 'All songs'))), table];
    }
    if (tab === 'genres') body = h('div', { class: 'grid' }, [...L.genres.values()].sort((a, b) => b.tracks.length - a.tracks.length).map(g =>
      card({ title: g.name, sub: `${songs(g.tracks.length)}`, art: genArt('genre:' + g.name.toLowerCase()), open: () => go({ v: 'genre', id: g.name.toLowerCase() }), play: () => playShuffled(g.tracks.map(t => t.id), g.name) })));
    if (tab === 'folders') return VIEWS.folder({ id: '', chips });
    if (tab === 'playlists') body = h('div', { class: 'grid' }, likedCard(), D.playlists.map(playlistCard),
      card({ title: 'New playlist', sub: 'Create', glyph: '+', open: async () => { const p = await createPlaylist(); if (p) go({ v: 'playlist', id: p.id }); } }));
    return h('div', {}, h('div', { class: 'hello' }, 'YOUR LIBRARY'), chips, body);
  },

  album({ id }) {
    const a = L.albums.get(id);
    if (!a) throw new Error('This album isn’t in your library any more.');
    const multiDisc = new Set(a.tracks.map(t => t.disc)).size > 1;
    const table = trackTable(playRows(a.title), { album: false });
    table.add(a.tracks.map(t => row(t, { n: t.track ? (multiDisc ? `${t.disc}·${t.track}` : t.track) : null })));
    const fmts = [...new Set(a.tracks.map(t => t.codec))].join(' / ');
    return h('div', {},
      hero(coverImg(albumArt(a)), 'ALBUM', a.title, [link(a.artist, 'artist:' + a.artist.toLowerCase()), ` · ${[a.year || null, `${songs(a.tracks.length)}`, totalTime(a.tracks), fmts].filter(Boolean).join(' · ')}`]),
      actions(a.tracks.map(t => t.id), a.title, btn('EDIT ALBUM', () => editTags(a.tracks, true)), btn('ADD TO PLAYLIST', () => addToPlaylist(a.tracks.map(t => t.id)))),
      table);
  },

  artist({ id }) {
    const ar = L.artists.get(id);
    if (!ar) throw new Error('This artist isn’t in your library any more.');
    const counts = playCounts();
    const top = ar.tracks.slice().sort((x, y) => (counts.get(y.id) || 0) - (counts.get(x.id) || 0) || x.title.localeCompare(y.title)).slice(0, 5);
    const own = [...ar.albums].sort((a, b) => b.year - a.year);
    const appears = [...new Set(ar.tracks.map(albumOf))].filter(a => a && !ar.albums.has(a));
    const ordered = own.flatMap(a => a.tracks).concat(ar.tracks.filter(t => !ar.albums.has(albumOf(t))));
    const table = trackTable(playRows(ar.name)); table.add(top.map(t => row(t)));
    return h('div', {},
      hero(img(artistArt(ar), 'round'), 'ARTIST', ar.name, `${songs(ar.tracks.length)} · ${own.length} albums`),
      actions(ordered.map(t => t.id), ar.name),
      h('div', { class: 'shelf' }, h('h2', {}, counts.size ? 'MOST PLAYED' : 'SONGS'), table),
      shelf('ALBUMS', own.map(albumCard)), shelf('APPEARS ON', appears.map(albumCard)));
  },

  genre({ id }) {
    const g = L.genres.get(id);
    if (!g) throw new Error('No songs in this genre any more.');
    const table = trackTable(playRows(g.name)); addAll(table, g.tracks.map(t => row(t)));
    const albums = [...new Set(g.tracks.map(albumOf))].filter(Boolean);
    return h('div', {}, hero(img(genArt('genre:' + g.name.toLowerCase())), 'GENRE', g.name, `${songs(g.tracks.length)} · ${totalTime(g.tracks)}`),
      actions(g.tracks.map(t => t.id), g.name), shelf('ALBUMS', albums.map(albumCard)), h('div', { class: 'shelf' }, h('h2', {}, 'SONGS'), table));
  },

  // folders: '' = your library folders; otherwise the subfolders and songs directly inside one folder
  folder({ id = '', chips }) {
    const sep = WIN ? '\\' : '/';
    const under = L.list.filter(t => id && t.path.startsWith(id + sep));
    const subs = new Map(), here = [];
    for (const t of under) {
      const rest = t.path.slice(id.length + 1), k = rest.indexOf(sep);
      if (k < 0) here.push(t);
      else { const name = rest.slice(0, k); const s = subs.get(name) || subs.set(name, { name, path: id + sep + name, count: 0, art: null }).get(name); s.count++; s.art ||= t.artUrl; }
    }
    const roots = !id ? L.folders.map(f => ({ name: f, path: f, count: L.list.filter(t => t.path.startsWith(f + sep)).length, art: L.list.find(t => t.path.startsWith(f + sep) && t.artUrl)?.artUrl })) : [...subs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const root = L.folders.find(f => id === f || id.startsWith(f + sep));
    const crumbs = id ? [link('All folders', 'folder:'), ...id.slice(root.length).split(sep).filter(Boolean).reduce((acc, part) => {
      const p = (acc.p || root) + sep + part; acc.list.push(' / ', link(part, 'folder:' + p)); acc.p = p; return acc;
    }, { list: [' / ', link(root.split(sep).pop() || root, 'folder:' + root)], p: root }).list] : null;
    here.sort((a, b) => a.path.localeCompare(b.path));
    const table = trackTable(playRows(id.split(sep).pop()));
    table.add(here.map(t => row(t)));
    const all = under.slice().sort((a, b) => a.path.localeCompare(b.path)).map(t => t.id);
    return h('div', {},
      chips ? [h('div', { class: 'hello' }, 'YOUR LIBRARY'), chips] : h('div', { class: 'hello' }, id ? id.split(sep).pop() : 'FOLDERS'),
      crumbs ? h('p', { class: 'dim crumbs' }, crumbs) : null,
      id && all.length ? actions(all, id.split(sep).pop()) : null,
      roots.length ? h('div', { class: 'grid' }, roots.map(f => card({ title: f.name.split(sep).pop() || f.name, sub: `${songs(f.count)}`, art: f.art || genArt('folder:' + f.path), glyph: '▤', open: () => go({ v: 'folder', id: f.path }), play: () => playList(L.list.filter(t => t.path.startsWith(f.path + sep)).sort((a, b) => a.path.localeCompare(b.path)).map(t => t.id), 0, f.name) }))) : null,
      here.length ? h('div', { class: 'shelf' }, h('h2', {}, 'SONGS IN THIS FOLDER'), table) : null,
      !id && !roots.length ? onboarding() : null);
  },

  playlist({ id }) {
    const p = D.playlists.find(x => x.id === id);
    if (!p) throw new Error('This playlist was deleted.');
    const tracks = p.tracks.map(tid => L.tracks.get(tid));
    const table = trackTable(playRows(p.name), {
      playlist: p,
      reorder: (from, to) => { const [x] = p.tracks.splice(from, 1); p.tracks.splice(to, 0, x); saveD('playlists'); render(true); },
    });
    table.add(tracks.map(t => t ? row(t) : null).filter(Boolean));
    const missing = tracks.filter(t => !t).length;
    return h('div', {},
      hero(coverImg(playlistArt(p)), 'PLAYLIST', p.name, [p.description, p.description ? h('br') : null, `${songs(p.tracks.length)} · ${totalTime(tracks.filter(Boolean))}`, missing ? ` · ${missing} missing from your library` : '']),
      actions(p.tracks, p.name, btn('EDIT', () => editPlaylist(p))),
      p.tracks.length ? table : h('div', { class: 'empty' }, h('p', {}, 'Empty playlist. Right-click a song → Add to playlist, or drag songs onto it in the sidebar.')));
  },

  liked() {
    const ids = likedIds();
    const table = trackTable(playRows('Liked Songs')); addAll(table, ids.map(id => row(L.tracks.get(id), { when: D.likes[id] })));
    return h('div', {}, hero(h('div', { class: 'liked' }, '♥'), 'PLAYLIST', 'Liked Songs', `${songs(ids.length)}`),
      actions(ids, 'Liked Songs'), ids.length ? table : h('div', { class: 'empty' }, h('p', {}, 'Tap ♡ on any song to keep it here.')));
  },

  history() {
    const plays = [...D.plays].reverse().filter(p => L.tracks.has(p.id)).slice(0, 500);
    const table = trackTable(playRows('History')); addAll(table, plays.map(p => row(L.tracks.get(p.id), { when: p.at })));
    return h('div', {}, hero(h('div', { class: 'liked' }, '↺'), 'HISTORY', 'Recently Played', `${D.plays.length.toLocaleString()} plays counted (half a song, or 4 minutes)`),
      plays.length ? table : h('div', { class: 'empty' }, h('p', {}, 'Nothing played yet.')));
  },
};

/* ---------- sidebar ---------- */
function renderSidebar() {
  const cur = hist[hpos];
  const rowFor = (id, name, sub, thumb, route, i) => h('li', { style: `--i:${i}` },
    h('button', { class: 'row' + ((cur?.v === 'liked' ? 'liked' : cur?.id) === id ? ' on' : ''), 'data-id': id, onclick: () => go(route),
      ondragover: e => { if (e.dataTransfer.types.includes('pulse/track')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
      ondragleave: e => e.currentTarget.classList.remove('drop'),
      ondrop: e => {
        e.preventDefault(); e.currentTarget.classList.remove('drop');
        const tid = e.dataTransfer.getData('pulse/track'); if (!tid) return;
        if (id === 'liked') { setLiked(tid, true); toast('Added to Liked Songs'); }
        else { const p = D.playlists.find(x => x.id === id); p.tracks.push(tid); saveD('playlists'); toast(`Added to “${p.name}”`); renderSidebar(); }
      },
      oncontextmenu: route.v === 'playlist' ? e => menu(e, [['Play', () => { const p = D.playlists.find(x => x.id === id); playList(p.tracks, 0, p.name); }], ['Edit…', () => editPlaylist(D.playlists.find(x => x.id === id))]]) : null },
      thumb, h('div', { class: 'clip' }, h('span', {}, name), h('small', {}, sub))));
  fillIn($('lists'),
    rowFor('liked', 'Liked Songs', `${songs(Object.keys(D.likes).length)}`, h('div', { class: 'thumb liked', style: 'font-size:16px' }, '♥'), { v: 'liked' }, 0),
    D.playlists.map((p, i) => rowFor(p.id, p.name, `${songs(p.tracks.length)}`, playlistArt(p) ? img(playlistArt(p), 'thumb') : h('div', { class: 'thumb liked' }, '≡'), { v: 'playlist', id: p.id }, i + 1)));
}

/* ---------- right panel ---------- */
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const p of ['playing', 'lyrics', 'queue']) $('pane-' + p).hidden = p !== name;
  if (name === 'lyrics') renderLyrics();
  if (name === 'queue') renderQueue();
}
const renderQueueIfOpen = () => { if (!$('pane-queue').hidden) renderQueue(); };
function renderQueue() {
  const pane = $('pane-queue');
  const cur = L.tracks.get(Q.items[Q.index]);
  const qrow = (t, i) => h('li', {}, h('div', {
    class: 'row qrow' + (i === Q.index ? ' on' : ''), role: 'button', tabIndex: 0, draggable: i > Q.index,
    onclick: () => start(i),
    oncontextmenu: e => menu(e, [['Play now', () => start(i)], i > Q.index && ['Remove from Up Next', () => queue.remove(i)], '-', ['Go to album', () => go({ v: 'album', id: albumKey(t) })]]),
    ondragstart: e => e.dataTransfer.setData('pulse/q', String(i)),
    ondragover: e => { if (e.dataTransfer.types.includes('pulse/q') && i > Q.index) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
    ondragleave: e => e.currentTarget.classList.remove('drop'),
    ondrop: e => { e.preventDefault(); queue.move(+e.dataTransfer.getData('pulse/q'), i); },
  }, img(trackArt(t), 'thumb'), h('div', { class: 'clip' }, h('span', {}, t.title), h('small', {}, t.artist))));
  const upcoming = Q.items.slice(Q.index + 1, Q.index + 201).map((id, k) => [L.tracks.get(id), Q.index + 1 + k]).filter(([t]) => t);
  fillIn(pane,
    h('h3', {}, 'NOW PLAYING', Q.from ? ` · FROM ${Q.from.toUpperCase()}` : ''), cur ? qrow(cur, Q.index) : h('p', { class: 'dim' }, 'Nothing playing.'),
    h('h3', { class: 'qhead' }, h('span', {}, 'UP NEXT'), upcoming.length ? h('button', { class: 'linkish', onclick: () => queue.clear() }, 'CLEAR') : null),
    upcoming.length ? upcoming.map(([t, i]) => qrow(t, i)) : h('p', { class: 'dim' }, Q.repeat === 'all' ? 'Repeats from the start.' : 'Nothing queued. Right-click a song → Play next.'),
    Q.items.length - Q.index - 1 > 200 ? h('p', { class: 'dim' }, `…and ${Q.items.length - Q.index - 201} more`) : null);
}

/* ---------- wiring ---------- */
for (const n of document.querySelectorAll('.nav')) n.onclick = () => n.dataset.v === 'search' ? ($('search').focus(), go({ v: 'search', q: $('search').value.trim() })) : go({ v: n.dataset.v });
for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
$('back').onclick = () => { if (hpos > 0) { hpos--; render(); } };
$('fwd').onclick = () => { if (hpos < hist.length - 1) { hpos++; render(); } };
$('newPl').onclick = async () => { const p = await createPlaylist(); if (p) go({ v: 'playlist', id: p.id }); };

// mini player: compact floating layout of this same window
let miniOn = false;
async function setMini(on) {
  miniOn = on;
  closeMenu();
  if (on) showTab('playing');
  document.body.classList.toggle('compact', on);
  await pulse.mini(on);
  if (on) { $('pin').classList.add('on'); $('pin').textContent = 'ON TOP'; }
}
$('miniBtn').onclick = () => setMini(true);
$('expand').onclick = () => setMini(false);
$('pin').onclick = () => {
  const on = !$('pin').classList.contains('on');
  $('pin').classList.toggle('on', on); $('pin').textContent = on ? 'ON TOP' : 'NOT ON TOP';
  pulse.pin(on);
};

let searchTimer;
$('search').oninput = e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => go({ v: 'search', q }, hist[hpos]?.v === 'search'), 150);
};

$('play').onclick = () => ctl.toggle();
$('next').onclick = () => ctl.next();
$('prev').onclick = () => ctl.prev();
$('shuffle').onclick = () => ctl.shuffle();
$('repeat').onclick = () => ctl.repeat();
$('seek').onpointerdown = () => seeking = true;
$('seek').onpointerup = $('seek').onpointercancel = () => seeking = false;
$('seek').oninput = e => { fill(e.target); $('cur').textContent = fmt(+e.target.value * 1000); };
$('seek').onchange = e => { seeking = false; ctl.seek(+e.target.value); };
$('vol').value = master; fill($('vol'));
$('vol').oninput = e => { fill(e.target); localStorage.setItem('pulse.volume', e.target.value); ctl.volume(+e.target.value); };

document.onkeydown = e => {
  if (e[MOD] && e.code === 'KeyK') { e.preventDefault(); return openPalette(); }
  if (e[MOD] && (e.code === 'KeyF' || e.code === 'KeyL')) { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (e[MOD] && e.shiftKey && e.code === 'KeyM') { e.preventDefault(); return setMini(!miniOn); }
  if (e[MOD] && e.code === 'BracketLeft') return $('back').click();
  if (e[MOD] && e.code === 'BracketRight') return $('fwd').click();
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || document.querySelector('.modal')) return;
  if (e.code === 'Space') { e.preventDefault(); ctl.toggle(); }
  if (e[MOD] && e.code === 'ArrowRight') ctl.next();
  if (e[MOD] && e.code === 'ArrowLeft') ctl.prev();
  if (!e[MOD] && e.code === 'ArrowRight' && now) ctl.seek(Math.min(length(), position() + 10));
  if (!e[MOD] && e.code === 'ArrowLeft' && now) ctl.seek(Math.max(0, position() - 10));
  if (e[MOD] && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    const v = $('vol'); v.value = Math.max(0, Math.min(1, +v.value + (e.code === 'ArrowUp' ? .1 : -.1))); v.oninput({ target: v });
  }
  if (e.key === 'Escape') closeMenu();
};

/* ---------- boot ---------- */
pulse.library.onChanged(snap => {
  indexLibrary(snap); renderSidebar();
  if (!['settings', 'stats'].includes(hist[hpos]?.v)) render(true);
});
pulse.library.onProgress(p => {
  $('me').textContent = p ? `SCANNING ${p.done.toLocaleString()} / ${p.total.toLocaleString()}` : `${L.tracks.size.toLocaleString()} SONGS`;
});

(async () => {
  const [data, snap] = await Promise.all([pulse.store.get(), pulse.library.get()]);
  D = { ...D, ...data };
  indexLibrary(snap);
  renderSidebar();
  restoreSession();
  go({ v: 'home' });
})();

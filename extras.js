/* Pulse extras: command palette, lyrics, stats, playlist and tag editing, Last.fm scrobbling, settings.
   Loaded after app.js and uses its globals (h, L, D, now, go, playList, toast, ...). */

const prefs = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('pulse.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('pulse.' + k, JSON.stringify(v)),
};

/* ---------- appearance (dither style) ---------- */
function applyStyle() {
  const s = prefs.get('style', { pattern: 'bayer', oneBit: false, hue: null, covers: false });
  Dither.setPattern(s.pattern);
  Dither.oneBit = s.oneBit;
  Dither.setHue(s.hue);
  if (Dither.ditherCovers !== !!s.covers) Dither.setCoverStyle(s.covers);
  return s;
}
applyStyle();

// images you pick (playlist covers, album art) as bytes; optionally dithered in the current colour
async function imageBytes(file, dither, size = 1000) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height), out = Math.min(size, s);
  const c = h('canvas', { width: out, height: out }), x = c.getContext('2d');
  x.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, out, out); // centre crop to square
  if (dither) {
    const d = x.getImageData(0, 0, out, out), px = new Uint32Array(d.data.buffer), hue = Dither.fixedHue ?? hueTarget;
    const pal = [rgb(hue, 30, 5), rgb(hue, 60, 30), rgb(hue, 85, 58), rgb(hue, 95, 85)], cell = Math.max(1, out / 250 | 0);
    for (let i = 0; i < px.length; i++) {
      const l = (.299 * d.data[i * 4] + .587 * d.data[i * 4 + 1] + .114 * d.data[i * 4 + 2]) / 255;
      px[i] = pal[q(l, ((i % out) / cell) | 0, ((i / out | 0) / cell) | 0, 4)]; // chunky cells, so the pattern reads at any size
    }
    x.putImageData(d, 0, 0);
  }
  const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', .92));
  return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
}

/* ---------- playlists ---------- */
async function editPlaylist(p) {
  const name = h('input', { class: 'search', value: p.name, placeholder: 'Name' });
  const desc = h('textarea', { class: 'search', rows: 3, placeholder: 'Description' }, p.description || '');
  const file = h('input', { type: 'file', accept: 'image/*' });
  const dith = h('input', { type: 'checkbox', checked: true });
  const result = await modal('EDIT PLAYLIST', done => h('form', { class: 'form', onsubmit: e => { e.preventDefault(); done('save'); } },
    name, desc,
    h('label', {}, h('small', {}, 'COVER (optional; otherwise the first song’s art)'), file),
    h('label', { class: 'check' }, dith, ' Dither the cover in Pulse style'),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'btn', style: 'margin-right:auto', onclick: () => done('delete') }, 'DELETE'),
      p.cover ? h('button', { type: 'button', class: 'btn', onclick: () => done('nocover') }, 'REMOVE COVER') : null,
      h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'CANCEL'),
      h('button', { class: 'btn on' }, 'SAVE'))));
  try {
    if (result === 'delete') {
      const sure = await modal('DELETE PLAYLIST?', done => h('div', { class: 'form' },
        h('p', { class: 'dim' }, `“${p.name}” will be deleted. The songs stay in your library.`),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => done(false) }, 'CANCEL'), h('button', { class: 'btn on', onclick: () => done(true) }, 'DELETE'))));
      if (!sure) return;
      D.playlists = D.playlists.filter(x => x !== p); saveD('playlists'); renderSidebar(); go({ v: 'library', tab: 'playlists' }); toast('Playlist deleted');
      return;
    }
    if (result === 'nocover') p.cover = null;
    if (result === 'save') {
      p.name = name.value.trim() || p.name; p.description = desc.value.trim();
      if (file.files[0]) { const { data } = await imageBytes(file.files[0], dith.checked, 800); p.cover = await pulse.saveCover(data, 'jpg'); }
    }
    if (!result) return;
    saveD('playlists'); renderSidebar(); render(true); toast('Playlist updated');
  } catch (e) { toast(e); }
}

/* ---------- tag editor: one song, or a whole album at once ---------- */
async function editTags(tracks, albumMode = false) {
  const t0 = tracks[0], same = k => tracks.every(t => t[k] === t0[k]) ? t0[k] : '';
  const fields = albumMode
    ? [['album', 'Album'], ['albumArtist', 'Album artist'], ['year', 'Year'], ['genre', 'Genre']]
    : [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'], ['track', 'Track #'], ['disc', 'Disc #'], ['year', 'Year'], ['genre', 'Genre']];
  const inputs = Object.fromEntries(fields.map(([k, label]) => [k, h('input', { class: 'search', placeholder: label, value: String(same(k) || ''), title: label })]));
  const file = h('input', { type: 'file', accept: 'image/*' });
  const dith = h('input', { type: 'checkbox' });
  const ok = await modal(albumMode ? `EDIT ALBUM · ${tracks.length} SONGS` : 'EDIT SONG INFO', done => h('form', { class: 'form tagform', onsubmit: e => { e.preventDefault(); done(true); } },
    fields.map(([k, label]) => h('label', {}, h('small', {}, label.toUpperCase()), inputs[k])),
    h('label', {}, h('small', {}, albumMode ? 'NEW ALBUM ART (optional, written into every song)' : 'NEW ART (optional)'), file),
    h('label', { class: 'check' }, dith, ' Dither the art in Pulse style'),
    h('p', { class: 'dim' }, 'Changes are written into the music files themselves.'),
    h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, 'CANCEL'), h('button', { class: 'btn on' }, 'SAVE'))));
  if (!ok) return;
  const patch = {};
  for (const [k] of fields) { const v = inputs[k].value.trim(); if (v !== String(same(k) || '')) patch[k] = v; }
  try {
    const cover = file.files[0] ? await imageBytes(file.files[0], dith.checked) : null;
    if (!Object.keys(patch).length && !cover) return;
    toast(`Saving ${tracks.length > 1 ? tracks.length + ' songs' : 'song'}…`);
    const snap = await pulse.library.writeTags(tracks.map(t => t.id), patch, cover);
    indexLibrary(snap); renderSidebar();
    // the album key may have changed: follow it
    if (hist[hpos]?.v === 'album') { const t = L.tracks.get(t0.id); if (t) return go({ v: 'album', id: albumKey(t) }, true); }
    render(true); toast('Saved');
  } catch (e) { toast(e); }
}

/* ---------- command palette (⌘K) ---------- */
function openPalette() {
  if (document.querySelector('.palette')) return;
  const input = h('input', { class: 'search', placeholder: 'Jump to, play or do anything…', spellcheck: false });
  const list = h('ul', { class: 'scroll' });
  let items = [], sel = 0;
  const close = () => { back.remove(); };
  const run = it => { close(); it.run(); };

  const actions = () => [
    ['Go to Home', () => go({ v: 'home' })], ['Go to Library', () => go({ v: 'library' })], ['Go to Folders', () => go({ v: 'library', tab: 'folders' })],
    ['Go to History', () => go({ v: 'history' })], ['Go to Stats', () => go({ v: 'stats' })],
    ['Go to Liked Songs', () => go({ v: 'liked' })], ['Open Settings', () => go({ v: 'settings' })],
    ['Play / Pause', () => ctl.toggle()], ['Next song', () => ctl.next()], ['Previous song', () => ctl.prev()],
    ['Toggle shuffle', () => ctl.shuffle()], ['Cycle repeat', () => ctl.repeat()],
    ['Like current song', () => now && $('like').click()],
    ['Show lyrics', () => showTab('lyrics')], ['Show Up Next', () => showTab('queue')],
    ['Mini player', () => setMini(true)], ['Create playlist', () => createPlaylist()],
    ['Shuffle all songs', () => playShuffled(L.list.map(t => t.id), 'All songs')],
    ['Shuffle Liked Songs', () => playShuffled(likedIds(), 'Liked Songs')],
    ['Add a music folder', () => addFolder()], ['Rescan music folders', () => pulse.library.rescan()],
    now && ['Edit current song info', () => editTags([now])],
  ].filter(Boolean).map(([label, fn]) => ({ label, kind: 'ACTION', run: fn }));

  const score = (label, q) => { // lower is better, -1 = no match
    const l = label.toLowerCase();
    if (l.startsWith(q)) return 0;
    if (l.includes(' ' + q)) return 1;
    if (l.includes(q)) return 2;
    let i = 0; for (const ch of l) if (ch === q[i]) i++;
    return i === q.length ? 3 : -1;
  };

  function draw() {
    const q = input.value.trim().toLowerCase();
    const pool = [...actions(), ...D.playlists.map(p => ({ label: p.name, kind: 'PLAYLIST', img: playlistArt(p), run: () => go({ v: 'playlist', id: p.id }) }))];
    if (q.length >= 2) { // the library itself: songs play, albums and artists open
      for (const a of L.artists.values()) pool.push({ label: a.name, kind: 'ARTIST', img: artistArt(a), run: () => go({ v: 'artist', id: a.name.toLowerCase() }) });
      for (const a of L.albums.values()) pool.push({ label: a.title, sub: a.artist, kind: 'ALBUM', img: albumArt(a), run: () => go({ v: 'album', id: a.key }) });
      for (const t of L.list) pool.push({ label: t.title, sub: t.artist, kind: 'SONG', img: trackArt(t), run: () => playList([t.id], 0, t.title) });
    }
    items = q ? pool.map(it => [score(it.label, q), it]).filter(([s]) => s >= 0).sort((a, b) => a[0] - b[0]).map(([, it]) => it).slice(0, 30) : pool.slice(0, 18);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    fillIn(list, items.map((it, i) => h('li', { style: `--i:${Math.min(i, 12)}` },
      h('button', { class: 'row prow' + (i === sel ? ' on' : ''), onclick: () => run(it), onmousemove: () => mark(i) },
        it.img ? img(it.img, 'thumb') : h('div', { class: 'thumb glyph' }, it.kind[0]),
        h('div', { class: 'clip' }, h('span', {}, it.label), it.sub ? h('small', {}, it.sub) : null),
        h('small', {}, it.kind)))),
      !items.length && q ? h('li', { class: 'empty' }, 'No matches.') : null);
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  function mark(i) { // move the highlight without rebuilding the list
    sel = i;
    list.querySelectorAll('.prow').forEach((b, k) => b.classList.toggle('on', k === i));
    list.querySelector('.prow.on')?.scrollIntoView({ block: 'nearest' });
  }

  input.oninput = () => { sel = 0; draw(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mark(Math.min(items.length - 1, sel + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark(Math.max(0, sel - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const back = h('div', { class: 'modal palette', onclick: e => e.target === back && close() }, h('div', {}, input, list));
  document.body.append(back);
  draw(); input.focus();
}

/* ---------- lyrics: a .lrc/.txt next to the song first, then LRCLIB (free, open, time-synced) ---------- */
const lyricsCache = new Map(); // track id -> Promise<{ lines: [{ t, text }] | null, plain, instrumental, source } | null | undefined>
const LRC = { headers: { 'Lrclib-Client': 'Pulse desktop player' } };

function parseLrc(text) {
  const lines = [];
  for (const row of (text || '').split('\n')) {
    const m = row.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (m) lines.push({ t: (+m[1] * 60 + +m[2]) * 1000, text: m[3] });
  }
  return lines.length ? lines : null;
}

function fetchLyrics(t) {
  if (!lyricsCache.has(t.id)) lyricsCache.set(t.id, (async () => {
    const side = await pulse.library.lyrics(t.id).catch(() => null);
    if (side) return { lines: side.synced ? parseLrc(side.text) : null, plain: side.synced ? null : side.text, source: 'file' };
    const sec = Math.round(t.duration);
    const qs = new URLSearchParams({ artist_name: t.artists[0], track_name: t.title, album_name: t.album, ...(sec ? { duration: sec } : {}) });
    let r = await fetch('https://lrclib.net/api/get?' + qs, LRC), d = r.ok ? await r.json() : null;
    if (!d) { // fuzzy fallback: search, closest duration wins
      r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: t.title, artist_name: t.artists[0] }), LRC);
      const found = r.ok ? await r.json() : [];
      d = found.sort((a, b) => Math.abs(a.duration - sec) - Math.abs(b.duration - sec))[0] || null;
    }
    return d ? { lines: parseLrc(d.syncedLyrics), plain: d.plainLyrics, instrumental: d.instrumental, source: 'lrclib' } : null;
  })().catch(() => { lyricsCache.delete(t.id); return undefined; }));
  return lyricsCache.get(t.id);
}

let lyricLines = null, lyricIdx = -1;
async function renderLyrics() {
  const pane = $('pane-lyrics'), t = now;
  lyricLines = null; lyricIdx = -1;
  if (!t) return fillIn(pane, h('p', { class: 'dim' }, 'Play something to see its lyrics.'));
  fillIn(pane, h('div', { class: 'loading' }, 'FINDING LYRICS'));
  const d = await fetchLyrics(t);
  if (now?.id !== t.id || pane.hidden) return;
  const credit = h('p', { class: 'credit' }, d?.source === 'file' ? 'Lyrics from the file next to this song' : ['Lyrics from ', h('a', { href: 'https://lrclib.net', class: 'link' }, 'LRCLIB'), ' · or put a .lrc file next to the song']);
  if (d === undefined) return fillIn(pane, h('p', { class: 'dim' }, 'Couldn’t reach the lyrics service.'), h('button', { class: 'btn', onclick: renderLyrics }, 'TRY AGAIN'));
  if (!d || (!d.lines && !d.plain)) return fillIn(pane, h('p', { class: 'dim' }, d?.instrumental ? '♪ Instrumental' : 'No lyrics found for this song.'), credit);
  if (d.lines) {
    lyricLines = d.lines;
    fillIn(pane, h('div', { class: 'lines' }, d.lines.map(l => h('p', { class: 'line', onclick: () => ctl.seek(l.t / 1000) }, l.text || '♪'))), credit);
  } else fillIn(pane, h('div', { class: 'lines plain' }, d.plain.split('\n').map(x => h('p', { class: 'line' }, x || ' '))), h('p', { class: 'dim' }, 'Not time-synced.'), credit);
}
onTrack.push(() => { if (!$('pane-lyrics').hidden) renderLyrics(); });
onTick.push(() => {
  if (!lyricLines || $('pane-lyrics').hidden || !now) return;
  const pos = position() * 1000 + 250; // light lead so the line lands with the voice
  let lo = 0, hi = lyricLines.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lyricLines[m].t <= pos) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i === lyricIdx) return;
  const els = $('pane-lyrics').querySelectorAll('.line');
  els[lyricIdx]?.classList.remove('on');
  lyricIdx = i;
  if (els[i]) { els[i].classList.add('on'); els[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
});

/* ---------- stats: from your own play history ---------- */
VIEWS.stats = ({ range = '4w' }) => {
  const ranges = { '4w': ['4 WEEKS', 28], '6m': ['6 MONTHS', 182], all: ['ALL TIME', Infinity] };
  const since = Date.now() - ranges[range][1] * 864e5;
  const plays = D.plays.filter(p => p.at >= since && L.tracks.has(p.id));
  const tally = key => { const m = new Map(); for (const p of plays) { const k = key(L.tracks.get(p.id)); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const seconds = plays.reduce((s, p) => s + Math.min(L.tracks.get(p.id).duration, 600), 0);
  const topSongs = tally(t => t.id).slice(0, 20), artists = tally(t => t.artists[0].toLowerCase()).slice(0, 12), genres = tally(t => t.genre).slice(0, 8);
  const max = genres[0]?.[1] || 1;
  const table = trackTable(playRows('Top topSongs')); table.add(topSongs.map(([id, n]) => row(L.tracks.get(id), { n: `${n}×` })));
  return h('div', {},
    h('div', { class: 'hello' }, 'YOUR STATS'),
    h('div', { class: 'chips' }, Object.entries(ranges).map(([k, [label]]) => btn(label, () => go({ v: 'stats', range: k }, true), k === range))),
    plays.length ? h('div', { class: 'statline' },
      h('div', {}, h('b', {}, plays.length.toLocaleString()), h('small', {}, 'PLAYS')),
      h('div', {}, h('b', {}, minutes(seconds)), h('small', {}, 'LISTENED')),
      h('div', {}, h('b', {}, new Set(plays.map(p => p.id)).size.toLocaleString()), h('small', {}, 'DIFFERENT SONGS'))) : null,
    genres.length ? h('div', { class: 'shelf' }, h('h2', {}, 'TOP GENRES'),
      h('div', { class: 'bars', role: 'table', 'aria-label': 'Top genres by plays' }, genres.map(([name, v], i) =>
        h('div', { class: 'bar', role: 'row', title: `${name}: ${v} plays`, style: `--w:${(v / max) * 100}%;--i:${i}` },
          h('span', { role: 'cell', class: 'clip' }, h('span', {}, name)),
          h('span', { role: 'cell', class: 'track' }, h('i')),
          h('span', { role: 'cell', class: 'dim' }, v))))) : null,
    artists.length ? h('div', { class: 'shelf' }, h('h2', {}, 'TOP ARTISTS'),
      h('div', { class: 'grid ranked' }, artists.map(([k, n], i) => { const ar = L.artists.get(k); if (!ar) return null; const c = artistCard(ar); c.querySelector('small').textContent = `${n} plays`; c.prepend(h('b', { class: 'rank' }, `#${i + 1}`)); return c; }))) : null,
    topSongs.length ? h('div', { class: 'shelf' }, h('h2', {}, 'TOP SONGS'), table) : null,
    !plays.length ? h('div', { class: 'empty' }, h('p', {}, 'Nothing counted for this period yet. A song counts after you’ve heard half of it (or 4 minutes).')) : null);
};

/* ---------- Last.fm scrobbling ---------- */
let lfmUser = null;
pulse.lastfm.status().then(s => { lfmUser = s?.user ?? null; });
const lfmTrack = t => ({ artist: t.artists[0], track: t.title, ...(t.album ? { album: t.album } : {}), ...(t.albumArtist !== t.artists[0] ? { albumArtist: t.albumArtist } : {}), duration: Math.round(t.duration) });
onTrack.push(t => { if (lfmUser && t.duration >= 30) pulse.lastfm.nowPlaying(lfmTrack(t)); });
onPlayed.push((t, startedAt) => { if (lfmUser && t.duration >= 30) pulse.lastfm.scrobble({ ...lfmTrack(t), timestamp: startedAt }).catch(e => toast(e)); });

/* ---------- settings ---------- */
VIEWS.settings = async () => {
  const s = applyStyle();
  const save = patch => { prefs.set('style', { ...s, ...patch }); applyStyle(); go({ v: 'settings' }, true); };
  const chip = (label, on, fn) => h('button', { class: 'btn' + (on ? ' on' : ''), onclick: fn }, label);
  const section = (title, ...kids) => h('div', { class: 'shelf settings' }, h('h2', {}, title), ...kids);
  const rowOf = (label, help, ...ctrl) => h('div', { class: 'setrow' }, h('div', { class: 'clip' }, h('span', {}, label), help ? h('small', {}, help) : null), h('div', { class: 'chips' }, ...ctrl));
  const again = () => go({ v: 'settings' }, true);

  const hue = h('input', { type: 'range', min: 0, max: 359, step: 1, value: s.hue ?? Math.round(hueTarget), 'aria-label': 'Colour' });
  hue.oninput = () => { fill(hue); Dither.setHue(+hue.value); };
  hue.onchange = () => save({ hue: +hue.value });
  setTimeout(() => fill(hue));

  const atLogin = await pulse.loginItem.get().catch(() => false);
  const fade = crossfade();
  const fm = lfmUser
    ? [rowOf(`Connected as ${lfmUser}`, 'Songs count after half their length or 4 minutes.',
        chip('DISCONNECT', false, async () => { await pulse.lastfm.disconnect(); lfmUser = null; again(); }))]
    : (() => {
      const key = h('input', { class: 'search', placeholder: 'API key', spellcheck: false });
      const secret = h('input', { class: 'search', placeholder: 'Shared secret', spellcheck: false, type: 'password' });
      const b = h('button', { class: 'btn on' }, 'CONNECT');
      return [h('p', { class: 'dim' }, 'Create a free API account at ', h('a', { class: 'link', href: 'https://www.last.fm/api/account/create' }, 'last.fm/api/account/create'),
        ' (any name; leave callback empty), then paste its key and secret.'),
        h('form', { class: 'form', onsubmit: async e => {
          e.preventDefault(); b.textContent = 'APPROVE IN BROWSER…';
          try { lfmUser = (await pulse.lastfm.connect(key.value, secret.value)).user; toast(`Scrobbling to ${lfmUser}`); again(); }
          catch (err) { toast(err); b.textContent = 'CONNECT'; }
        } }, key, secret, b)];
    })();

  return h('div', {},
    h('div', { class: 'hello' }, 'SETTINGS'),
    section('MUSIC FOLDERS',
      L.folders.length ? L.folders.map(f => rowOf(f, `${songs(L.list.filter(t => t.path.startsWith(f)).length.toLocaleString())}`,
        chip('REMOVE', false, async () => { indexLibrary(await pulse.library.removeFolder(f)); renderSidebar(); again(); })))
        : h('p', { class: 'dim' }, 'No folders yet.'),
      h('div', { class: 'chips', style: 'margin-top:14px' }, chip('ADD FOLDER', true, async () => { await addFolder(); again(); }), chip('RESCAN', false, () => { pulse.library.rescan(); toast('Rescanning your folders…'); })),
      h('p', { class: 'dim' }, `${songs(L.tracks.size.toLocaleString())} · ${L.albums.size.toLocaleString()} albums. New and changed files are picked up automatically. Plays MP3, AAC/M4A, FLAC, OGG, Opus and WAV (not ALAC or AIFF).`)),
    section('PLAYBACK',
      rowOf('Crossfade', 'Blend the end of one song into the next. Songs from the same album always play gapless.',
        ...[0, 2, 4, 6, 8, 12].map(n => chip(n ? `${n} S` : 'OFF', fade === n, () => { localStorage.setItem('pulse.crossfade', n); again(); })))),
    section('APPEARANCE',
      rowOf('Dither pattern', 'How tones are built from dots',
        chip('CLASSIC GRID', s.pattern === 'bayer', () => save({ pattern: 'bayer' })),
        chip('NOISE', s.pattern === 'noise', () => save({ pattern: 'noise' })),
        chip('HALFTONE', s.pattern === 'halftone', () => save({ pattern: 'halftone' }))),
      rowOf('Album art', 'Show covers as they are, or dithered in the Pulse style',
        chip('ORIGINAL', !s.covers, () => save({ covers: false })), chip('DITHERED', !!s.covers, () => save({ covers: true }))),
      rowOf('Tones', '1-bit uses just two colours for the background',
        chip('SOFT', !s.oneBit, () => save({ oneBit: false })), chip('1-BIT', s.oneBit, () => save({ oneBit: true }))),
      rowOf('Colour', 'Follow each album cover, or keep one colour',
        chip('FOLLOW COVER', s.hue == null, () => save({ hue: null })), chip('FIXED', s.hue != null, () => save({ hue: Math.round(hueTarget) }))),
      s.hue != null ? h('div', { class: 'huewrap' }, hue) : null),
    section('STARTUP',
      rowOf(`Open Pulse when you log in to your ${MAC ? 'Mac' : 'computer'}`, null,
        chip('ON', atLogin, async () => { await pulse.loginItem.set(true); again(); }),
        chip('OFF', !atLogin, async () => { await pulse.loginItem.set(false); again(); })),
      rowOf('Start in the mini player when opened at login', null,
        chip('ON', prefs.get('miniAtLogin', false), () => { prefs.set('miniAtLogin', true); again(); }),
        chip('OFF', !prefs.get('miniAtLogin', false), () => { prefs.set('miniAtLogin', false); again(); }))),
    section('LAST.FM SCROBBLING', ...fm),
    section('KEYBOARD',
      h('div', { class: 'keys' }, [['⌘K', 'Command palette'], ['⌘F', 'Search'], ['Space', 'Play / pause'], ['← →', 'Back / forward 10 s'], ['⌘← ⌘→', 'Previous / next song'],
        ['⌘↑ ⌘↓', 'Volume'], ['⌘[ ⌘]', 'Back / forward'], ['⇧⌘M', 'Mini player'], ['Right-click', 'Song menu'], ['Drag a song', 'Onto a playlist in the sidebar'],
      ].map(([k, v]) => h('div', {}, h('kbd', {}, keyLabel(k)), h('span', { class: 'dim' }, v))))));
};

// the gear toggles: a second click leaves Settings for wherever you were
$('settingsBtn').onclick = () => hist[hpos]?.v === 'settings' ? (hpos > 0 ? $('back').click() : go({ v: 'home' })) : go({ v: 'settings' });

// opened at login with "start in mini" on
pulse.loginItem.wasOpenedAtLogin().then(yes => { if (yes && prefs.get('miniAtLogin', false)) setMini(true); }).catch(() => {});

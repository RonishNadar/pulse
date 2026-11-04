/* Pulse extras: command palette, lyrics, stats, playlist editing, Last.fm scrobbling, settings.
   Loaded after app.js and uses its globals (h, api, now, go, play, toast, ...). */

const prefs = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('pulse.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('pulse.' + k, JSON.stringify(v)),
};

/* ---------- appearance (dither style) ---------- */
function applyStyle() {
  const s = prefs.get('style', { pattern: 'bayer', oneBit: false, hue: null });
  Dither.setPattern(s.pattern);
  Dither.oneBit = s.oneBit;
  Dither.setHue(s.hue);
  return s;
}
applyStyle();

/* ---------- playlist editing ---------- */
async function reorderPlaylist(pl, from, to) {
  try {
    // insert_before counts positions before the moved item is taken out
    await put(`/playlists/${pl.id}/items`, { range_start: from, insert_before: to > from ? to + 1 : to });
    toast('Moved'); go(hist[hpos], true);
  } catch (e) { toast(e); }
}

const editable = id => id === 'liked' || myLists.some(p => p.id === id && (p.owner?.id === me?.id || p.collaborative));
function dropTarget(id) {
  if (!editable(id)) return {};
  return {
    ondragover: e => { if (e.dataTransfer.types.includes('text/uri-list')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
    ondragleave: e => e.currentTarget.classList.remove('drop'),
    ondrop: async e => {
      e.preventDefault(); e.currentTarget.classList.remove('drop');
      const uri = e.dataTransfer.getData('text/uri-list');
      if (!/^spotify:(track|episode):/.test(uri)) return;
      try {
        if (id === 'liked') { await lib.save(uri); toast('Added to Liked Songs'); }
        else { await post(`/playlists/${id}/items`, { uris: [uri] }); toast('Added to playlist'); }
      } catch (err) { toast(err); }
    },
  };
}

// a JPEG data URL under Spotify's 256 KB cover limit, optionally dithered (your own cover, not album art)
async function coverJpeg(file, dither) {
  const bmp = await createImageBitmap(file);
  const c = h('canvas', { width: 640, height: 640 }), x = c.getContext('2d');
  const s = Math.min(bmp.width, bmp.height); // centre crop to square
  x.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 640, 640);
  if (dither) {
    const d = x.getImageData(0, 0, 640, 640), px = new Uint32Array(d.data.buffer), hue = Dither.fixedHue ?? hueTarget;
    const pal = [rgb(hue, 30, 5), rgb(hue, 60, 30), rgb(hue, 85, 58), rgb(hue, 95, 85)];
    for (let i = 0; i < px.length; i++) {
      const l = (.299 * d.data[i * 4] + .587 * d.data[i * 4 + 1] + .114 * d.data[i * 4 + 2]) / 255;
      const X = (i % 640) >> 2, Y = (i / 640 | 0) >> 2; // 4px dither cells so the pattern survives JPEG
      px[i] = pal[q(l, X, Y, 4)];
    }
    x.putImageData(d, 0, 0);
  }
  for (let qual = .9; qual > .2; qual -= .1) {
    const b64 = c.toDataURL('image/jpeg', qual).split(',')[1];
    if (b64.length <= 256 * 1024) return b64;
  }
  throw new Error('Image is too detailed to fit Spotify’s 256 KB cover limit.');
}

async function editPlaylist(pl) {
  const name = h('input', { class: 'search', value: pl.name, placeholder: 'Name' });
  const desc = h('textarea', { class: 'search', rows: 3, placeholder: 'Description' }, plain(pl.description));
  const pub = h('input', { type: 'checkbox', checked: !!pl.public });
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const dith = h('input', { type: 'checkbox', checked: true });
  const result = await modal('EDIT PLAYLIST', done => h('form', { class: 'form', onsubmit: e => { e.preventDefault(); done('save'); } },
    name, desc,
    h('label', { class: 'check' }, pub, ' Public (shown on your profile)'),
    h('label', {}, h('small', {}, 'NEW COVER (optional)'), file),
    h('label', { class: 'check' }, dith, ' Dither the cover in Pulse style'),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'btn', style: 'margin-right:auto', onclick: () => done('remove') }, 'REMOVE FROM LIBRARY'),
      h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'CANCEL'),
      h('button', { class: 'btn on' }, 'SAVE'))));
  try {
    if (result === 'remove') {
      if (await modal('REMOVE PLAYLIST?', done => h('div', { class: 'form' },
        h('p', { class: 'dim' }, `“${pl.name}” will be removed from your library. Spotify keeps it recoverable from your account page for 90 days.`),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => done(false) }, 'CANCEL'), h('button', { class: 'btn on', onclick: () => done(true) }, 'REMOVE'))))) {
        await lib.remove(pl.uri); await loadSidebar(); go({ v: 'library' }); toast('Playlist removed');
      }
      return;
    }
    if (result !== 'save') return;
    await put(`/playlists/${pl.id}`, { name: name.value.trim() || pl.name, description: desc.value.trim(), public: pub.checked });
    if (file.files[0]) {
      const b64 = await coverJpeg(file.files[0], dith.checked);
      const r = await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/images`, {
        method: 'PUT', headers: { Authorization: 'Bearer ' + await pulse.token(), 'Content-Type': 'image/jpeg' }, body: b64 });
      if (!r.ok) throw new Error(`Spotify ${r.status}: cover upload failed`);
    }
    toast('Playlist updated');
    setTimeout(async () => { await loadSidebar(); go(hist[hpos], true); }, 800); // covers take a moment to process
  } catch (e) { toast(e); }
}

/* ---------- command palette (⌘K) ---------- */
function openPalette() {
  if (document.querySelector('.palette')) return;
  const input = h('input', { class: 'search', placeholder: 'Jump to or do anything…', spellcheck: false });
  const list = h('ul', { class: 'scroll' });
  let items = [], sel = 0, remote = [], timer, seq = 0;
  const close = () => { back.remove(); };
  const run = it => { close(); it.run(); };

  const actions = () => [
    ['Go to Home', () => go({ v: 'home' })], ['Go to Library', () => go({ v: 'library' })],
    ['Go to History', () => go({ v: 'history' })], ['Go to Stats', () => go({ v: 'stats' })],
    ['Go to Liked Songs', () => go({ v: 'liked' })], ['Open Settings', () => go({ v: 'settings' })],
    ['Play / Pause', () => ctl.toggle()], ['Next song', () => ctl.next()], ['Previous song', () => ctl.prev()],
    ['Toggle shuffle', () => ctl.shuffle()], ['Cycle repeat', () => ctl.repeat()],
    ['Like current song', () => now && !$('like').hidden && $('like').click()],
    ['Show lyrics', () => showTab('lyrics')], ['Show queue', () => showTab('queue')], ['Switch device', () => showTab('devices')],
    ['Mini player', () => setMini(true)], ['Create playlist', () => createPlaylist()],
    ['Shuffle Liked Songs', async () => { try { const d = await api('/me/tracks?limit=50'); const u = d.items.map(i => i.track.uri).sort(() => Math.random() - .5); play({ uris: u }); } catch (e) { toast(e); } }],
  ].map(([label, fn]) => ({ label, kind: 'ACTION', run: fn }));
  const lists = () => myLists.map(p => ({ label: p.name, kind: 'PLAYLIST', img: p.images?.at(-1)?.url, run: () => go({ v: 'playlist', id: p.id }) }));

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
    const local = [...actions(), ...lists()];
    items = q ? local.map(it => [score(it.label, q), it]).filter(([s]) => s >= 0).sort((a, b) => a[0] - b[0]).map(([, it]) => it).slice(0, 12).concat(remote)
      : local.slice(0, 18);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    fillIn(list, items.map((it, i) => h('li', { style: `--i:${Math.min(i, 12)}` },
      h('button', { class: 'row prow' + (i === sel ? ' on' : ''), onclick: () => run(it), onmousemove: () => mark(i) },
        it.img ? img(it.img, 'thumb') : h('div', { class: 'thumb glyph' }, it.kind[0]),
        h('div', { class: 'clip' }, h('span', {}, it.label), it.sub ? h('small', {}, it.sub) : null),
        h('small', {}, it.kind)))),
      !items.length ? h('li', { class: 'empty' }, q ? 'Searching Spotify…' : '') : null);
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  function mark(i) { // move the highlight without rebuilding the list
    sel = i;
    list.querySelectorAll('.prow').forEach((b, k) => b.classList.toggle('on', k === i));
    list.querySelector('.prow.on')?.scrollIntoView({ block: 'nearest' });
  }

  input.oninput = () => {
    remote = []; sel = 0; draw();
    clearTimeout(timer);
    const q = input.value.trim(), mine = ++seq;
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const d = await api(`/search?type=track,artist,album,playlist&limit=4&q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        const pick = (x, kind, sub, fn) => ({ label: x.name, kind, sub, img: (x.images || x.album?.images)?.at(-1)?.url, run: fn });
        remote = [
          ...(d.tracks?.items || []).filter(Boolean).map(t => pick(t, 'SONG', t.artists.map(a => a.name).join(', '), () => play({ uris: [t.uri] }))),
          ...(d.artists?.items || []).filter(Boolean).map(a => pick(a, 'ARTIST', null, () => goUri(a.uri))),
          ...(d.albums?.items || []).filter(Boolean).map(a => pick(a, 'ALBUM', a.artists?.map(x => x.name).join(', '), () => goUri(a.uri))),
          ...(d.playlists?.items || []).filter(Boolean).map(p => pick(p, 'PLAYLIST', p.owner?.display_name, () => goUri(p.uri))),
        ];
        draw();
      } catch {}
    }, 200);
  };
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

/* ---------- lyrics (LRCLIB: free, open, time-synced) ---------- */
const lyricsCache = new Map(); // uri -> Promise<{ lines: [{ t, text }] | null, plain, instrumental }>
const LRC = { headers: { 'Lrclib-Client': 'Pulse desktop player' } };

function parseLrc(text) {
  const lines = [];
  for (const row of (text || '').split('\n')) {
    const m = row.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (m) lines.push({ t: (+m[1] * 60 + +m[2]) * 1000, text: m[3] });
  }
  return lines.length ? lines : null;
}

function fetchLyrics(n) {
  if (!lyricsCache.has(n.uri)) lyricsCache.set(n.uri, (async () => {
    const artist = n.artists?.[0]?.name || '', track = n.name, sec = Math.round((n.duration || 0) / 1000);
    const qs = new URLSearchParams({ artist_name: artist, track_name: track, ...(n.album?.name ? { album_name: n.album.name } : {}), ...(sec ? { duration: sec } : {}) });
    let r = await fetch('https://lrclib.net/api/get?' + qs, LRC), d = r.ok ? await r.json() : null;
    if (!d) { // fuzzy fallback: search, closest duration wins
      r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: track, artist_name: artist }), LRC);
      const found = r.ok ? await r.json() : [];
      d = found.sort((a, b) => Math.abs(a.duration - sec) - Math.abs(b.duration - sec))[0] || null;
    }
    return d ? { lines: parseLrc(d.syncedLyrics), plain: d.plainLyrics, instrumental: d.instrumental } : null;
  })().catch(() => { lyricsCache.delete(n.uri); return undefined; }));
  return lyricsCache.get(n.uri);
}

let lyricLines = null, lyricIdx = -1;
async function renderLyrics() {
  const pane = $('pane-lyrics'), n = now;
  lyricLines = null; lyricIdx = -1;
  if (!n) return fillIn(pane, h('p', { class: 'dim' }, 'Play something to see its lyrics.'));
  if (n.episode) return fillIn(pane, h('p', { class: 'dim' }, 'No lyrics for podcasts.'));
  fillIn(pane, h('div', { class: 'loading' }, 'FINDING LYRICS'));
  const d = await fetchLyrics(n);
  if (now?.uri !== n.uri || pane.hidden) return;
  const credit = h('p', { class: 'credit' }, 'Lyrics from ', h('a', { href: 'https://lrclib.net', class: 'link' }, 'LRCLIB'));
  if (d === undefined) return fillIn(pane, h('p', { class: 'dim' }, 'Couldn’t reach the lyrics service.'), h('button', { class: 'btn', onclick: renderLyrics }, 'TRY AGAIN'));
  if (!d || (!d.lines && !d.plain)) return fillIn(pane, h('p', { class: 'dim' }, d?.instrumental ? '♪ Instrumental' : 'No lyrics found for this song.'), credit);
  if (d.lines) {
    lyricLines = d.lines;
    fillIn(pane, h('div', { class: 'lines' }, d.lines.map(l => h('p', { class: 'line', onclick: () => ctl.seek(l.t) }, l.text || '♪'))), credit);
  } else fillIn(pane, h('div', { class: 'lines plain' }, d.plain.split('\n').map(t => h('p', { class: 'line' }, t || ' '))), h('p', { class: 'dim' }, 'Not time-synced.'), credit);
}
onTrack.push(() => { if (!$('pane-lyrics').hidden) renderLyrics(); });
onTick.push(() => {
  if (!lyricLines || $('pane-lyrics').hidden || !now) return;
  const pos = position() + 250; // light lead so the line lands with the voice
  let lo = 0, hi = lyricLines.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lyricLines[m].t <= pos) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i === lyricIdx) return;
  const els = $('pane-lyrics').querySelectorAll('.line');
  els[lyricIdx]?.classList.remove('on');
  lyricIdx = i;
  if (els[i]) { els[i].classList.add('on'); els[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
});

/* ---------- stats ---------- */
VIEWS.stats = async ({ range = 'short_term' }) => {
  const ranges = { short_term: '4 WEEKS', medium_term: '6 MONTHS', long_term: '12 MONTHS' };
  const [artists, tracks] = await Promise.all([
    api(`/me/top/artists?limit=20&time_range=${range}`), api(`/me/top/tracks?limit=20&time_range=${range}`)]);
  // genres weighted by artist rank: #1 counts 20, #20 counts 1
  const g = new Map();
  artists.items.forEach((a, i) => (a.genres || []).forEach(x => g.set(x, (g.get(x) || 0) + 20 - i)));
  const genres = [...g].sort((a, b) => b[1] - a[1]).slice(0, 8), max = genres[0]?.[1] || 1;
  const table = trackTable(playUris); table.add(tracks.items.map(t => T(t)));
  return h('div', {},
    h('div', { class: 'hello' }, 'YOUR STATS'),
    h('div', { class: 'chips' }, Object.entries(ranges).map(([k, label]) =>
      h('button', { class: 'btn' + (k === range ? ' on' : ''), onclick: () => go({ v: 'stats', range: k }, true) }, label))),
    genres.length ? h('div', { class: 'shelf' }, h('h2', {}, 'TOP GENRES'),
      h('div', { class: 'bars', role: 'table', 'aria-label': 'Top genres by weighted artist rank' }, genres.map(([name, v], i) =>
        h('div', { class: 'bar', role: 'row', title: `${name}: score ${v} (from your top artists)`, style: `--w:${(v / max) * 100}%;--i:${i}` },
          h('span', { role: 'cell', class: 'clip' }, h('span', {}, name)),
          h('span', { role: 'cell', class: 'track' }, h('i')),
          h('span', { role: 'cell', class: 'dim' }, v))))) : null,
    artists.items.length ? h('div', { class: 'shelf' }, h('h2', {}, 'TOP ARTISTS'),
      h('div', { class: 'grid ranked' }, artists.items.map((a, i) => { const c = card(a); c.prepend(h('b', { class: 'rank' }, `#${i + 1}`)); return c; }))) : null,
    tracks.items.length ? h('div', { class: 'shelf' }, h('h2', {}, 'TOP SONGS'), table) : null,
    !artists.items.length && !tracks.items.length ? h('div', { class: 'empty' }, 'Not enough listening yet for this period.') : null);
};

/* ---------- Last.fm scrobbling ---------- */
let lfmUser = null;
pulse.lastfm.status().then(s => { lfmUser = s?.user ?? null; });
// a play counts once you've heard half the song or 4 minutes, whichever comes first (Last.fm's rule); songs under 30 s never count
let scrob = null, lastTick = performance.now();
onTrack.push(n => {
  scrob = n.episode || n.restored || !n.duration || n.duration < 30000 ? null
    : { n, start: Math.floor(Date.now() / 1000), heard: 0, need: Math.min(n.duration / 2, 240000), sent: false, announced: false };
});
onTick.push(() => {
  const t = performance.now(), dt = t - lastTick; lastTick = t;
  if (!lfmUser || !scrob || !now || now.uri !== scrob.n.uri || now.paused || now.restored) return;
  const base = { artist: scrob.n.artists?.[0]?.name || '', track: scrob.n.name, ...(scrob.n.album?.name ? { album: scrob.n.album.name } : {}), duration: Math.round(scrob.n.duration / 1000) };
  if (!scrob.announced) { scrob.announced = true; pulse.lastfm.nowPlaying(base); }
  scrob.heard += Math.min(dt, 1000); // clamp: a sleeping Mac shouldn't count as listening
  if (!scrob.sent && scrob.heard >= scrob.need) {
    scrob.sent = true;
    pulse.lastfm.scrobble({ ...base, timestamp: scrob.start }).catch(e => toast(e));
  }
});

/* ---------- settings ---------- */
VIEWS.settings = async () => {
  const s = prefs.get('style', { pattern: 'bayer', oneBit: false, hue: null });
  const save = patch => { prefs.set('style', { ...s, ...patch }); applyStyle(); go({ v: 'settings' }, true); };
  const chip = (label, on, fn) => h('button', { class: 'btn' + (on ? ' on' : ''), onclick: fn }, label);
  const section = (title, ...kids) => h('div', { class: 'shelf settings' }, h('h2', {}, title), ...kids);
  const rowOf = (label, help, ...ctrl) => h('div', { class: 'setrow' }, h('div', { class: 'clip' }, h('span', {}, label), help ? h('small', {}, help) : null), h('div', { class: 'chips' }, ...ctrl));

  const hue = h('input', { type: 'range', min: 0, max: 359, step: 1, value: s.hue ?? Math.round(hueTarget), 'aria-label': 'Colour' });
  hue.oninput = () => { fill(hue); Dither.setHue(+hue.value); };
  hue.onchange = () => save({ hue: +hue.value });
  setTimeout(() => fill(hue));

  const atLogin = await pulse.loginItem.get().catch(() => false);
  const fm = lfmUser
    ? [rowOf(`Connected as ${lfmUser}`, 'Songs count after half their length or 4 minutes. Only while Pulse is open.',
        chip('DISCONNECT', false, async () => { await pulse.lastfm.disconnect(); lfmUser = null; go({ v: 'settings' }, true); }))]
    : (() => {
      const key = h('input', { class: 'search', placeholder: 'API key', spellcheck: false });
      const secret = h('input', { class: 'search', placeholder: 'Shared secret', spellcheck: false, type: 'password' });
      const btn = h('button', { class: 'btn on' }, 'CONNECT');
      return [h('p', { class: 'dim' }, 'Create a free API account at ', h('a', { class: 'link', href: 'https://www.last.fm/api/account/create' }, 'last.fm/api/account/create'),
        ' (any name; leave callback empty), then paste its key and secret. If Spotify itself already scrobbles to Last.fm, use only one of the two, or plays count twice.'),
        h('form', { class: 'form', onsubmit: async e => {
          e.preventDefault(); btn.textContent = 'APPROVE IN BROWSER…';
          try { lfmUser = (await pulse.lastfm.connect(key.value, secret.value)).user; toast(`Scrobbling to ${lfmUser}`); go({ v: 'settings' }, true); }
          catch (err) { toast(err); btn.textContent = 'CONNECT'; }
        } }, key, secret, btn)];
    })();

  return h('div', {},
    h('div', { class: 'hello' }, 'SETTINGS'),
    section('APPEARANCE',
      rowOf('Dither pattern', 'How tones are built from dots',
        chip('CLASSIC GRID', s.pattern === 'bayer', () => save({ pattern: 'bayer' })),
        chip('NOISE', s.pattern === 'noise', () => save({ pattern: 'noise' })),
        chip('HALFTONE', s.pattern === 'halftone', () => save({ pattern: 'halftone' }))),
      rowOf('Tones', '1-bit uses just two colours for the background',
        chip('SOFT', !s.oneBit, () => save({ oneBit: false })), chip('1-BIT', s.oneBit, () => save({ oneBit: true }))),
      rowOf('Colour', 'Follow each album cover, or keep one colour',
        chip('FOLLOW COVER', s.hue == null, () => save({ hue: null })), chip('FIXED', s.hue != null, () => save({ hue: Math.round(hueTarget) }))),
      s.hue != null ? h('div', { class: 'huewrap' }, hue) : null),
    section('STARTUP',
      rowOf('Open Pulse when you log in to your Mac', null,
        chip('ON', atLogin, async () => { await pulse.loginItem.set(true); go({ v: 'settings' }, true); }),
        chip('OFF', !atLogin, async () => { await pulse.loginItem.set(false); go({ v: 'settings' }, true); })),
      rowOf('Start in the mini player when opened at login', null,
        chip('ON', prefs.get('miniAtLogin', false), () => { prefs.set('miniAtLogin', true); go({ v: 'settings' }, true); }),
        chip('OFF', !prefs.get('miniAtLogin', false), () => { prefs.set('miniAtLogin', false); go({ v: 'settings' }, true); }))),
    section('LAST.FM SCROBBLING', ...fm),
    section('ACCOUNT',
      rowOf(`Signed in as ${me?.display_name || me?.id || '…'}`, 'Logging out forgets your Spotify login on this Mac.',
        chip('LOG OUT', false, logout))),
    section('KEYBOARD',
      h('div', { class: 'keys' }, [['⌘K', 'Command palette'], ['⌘F', 'Search'], ['Space', 'Play / pause'], ['⌘← ⌘→', 'Previous / next'],
        ['⌘↑ ⌘↓', 'Volume'], ['⌘[ ⌘]', 'Back / forward'], ['⇧⌘M', 'Mini player'], ['Right-click', 'Song menu'], ['Drag a song', 'Onto a playlist in the sidebar'],
      ].map(([k, v]) => h('div', {}, h('kbd', {}, keyLabel(k)), h('span', { class: 'dim' }, v))))));
};

$('settingsBtn').onclick = () => go({ v: 'settings' });

// opened at login with "start in mini" on
pulse.loginItem.wasOpenedAtLogin().then(yes => { if (yes && prefs.get('miniAtLogin', false)) setMini(true); }).catch(() => {});

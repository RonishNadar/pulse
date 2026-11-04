/* Pulse: Spotify client. Views, playback, library actions. Visuals live in dither.js. */

const $ = id => document.getElementById(id);
// ⌘ on macOS, Ctrl elsewhere; labels are written Mac-style and translated
const MAC = pulse.platform === 'darwin', IOS = pulse.platform === 'ios', MOD = MAC || IOS ? 'metaKey' : 'ctrlKey';
const keyLabel = s => MAC ? s : s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+');
document.body.classList.add(IOS ? 'ios' : MAC ? 'mac' : 'wco'); // wco: window controls overlay (Windows/Linux)
for (const el of document.querySelectorAll('[title], [placeholder]')) {
  if (el.title) el.title = keyLabel(el.title);
  if (el.placeholder) el.placeholder = keyLabel(el.placeholder);
}
const fmt = ms => { const s = Math.max(0, ms / 1000 | 0); return `${s / 60 | 0}:${String(s % 60).padStart(2, '0')}`; };
const fill = el => el.style.setProperty('--p', (el.value / el.max) * 100 + '%');
const idOf = uri => uri?.split(':')[2];
const plain = html => new DOMParser().parseFromString(html || '', 'text/html').body.textContent; // descriptions carry HTML entities

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

const ago = iso => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = String(msg instanceof Error ? msg.message : msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

/* ---------- Spotify Web API ---------- */
async function api(path, opts = {}, retry = true) {
  const token = await pulse.token();
  if (!token) { showLogin(); throw new Error('Session expired, please log in again'); }
  const r = await fetch(path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  if (r.status === 429 && retry) { // rate limited: wait as told, once
    await new Promise(ok => setTimeout(ok, (+r.headers.get('Retry-After') || 1) * 1000));
    return api(path, opts, false);
  }
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text();
  // player commands may answer 200 with a plain-text id, not JSON: keep the text, don't throw
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = r.ok ? text : null; }
  if (!r.ok) throw new Error(`Spotify ${r.status}: ${body?.error?.message || r.statusText}`);
  return body;
}
const put = (path, body) => api(path, { method: 'PUT', body: body && JSON.stringify(body) });
const post = (path, body) => api(path, { method: 'POST', body: body && JSON.stringify(body) });
const del = (path, body) => api(path, { method: 'DELETE', body: body && JSON.stringify(body) });

// Library (Spotify Feb 2026 API): likes, saves and follows all go through /me/library, keyed by URI
const lib = {
  has: async uri => !!(await api(`/me/library/contains?uris=${encodeURIComponent(uri)}`))?.[0],
  save: uri => put(`/me/library?uris=${encodeURIComponent(uri)}`),
  remove: uri => del(`/me/library?uris=${encodeURIComponent(uri)}`),
};

/* ---------- models ---------- */
// track or episode -> row model
function T(t, album) {
  if (!t || t.is_local) return null;
  if (t.type === 'episode') {
    const imgs = t.images?.length ? t.images : t.show?.images;
    return { uri: t.uri, id: t.id, name: t.name, ms: t.duration_ms, episode: true, img: imgs?.at(-1)?.url, big: imgs?.[0]?.url,
      artists: t.show ? [{ name: t.show.name, uri: t.show.uri }] : [], album: t.show ? { name: t.show.name, uri: t.show.uri } : null,
      sub: t.release_date };
  }
  const al = t.album || album;
  return { uri: t.uri, id: t.id, name: t.name, ms: t.duration_ms, explicit: t.explicit, playable: t.is_playable !== false,
    artists: (t.artists || []).map(a => ({ name: a.name, uri: a.uri })), album: al ? { name: al.name, uri: al.uri } : null,
    img: al?.images?.at(-1)?.url, big: al?.images?.[0]?.url };
}
const pageOf = pl => pl.tracks ?? pl.items; // playlist paging object
const itemOf = i => i.track ?? i.item;

/* ---------- playback ---------- */
const onTrack = [], onTick = []; // extras.js hooks: track changed / every frame
let player, deviceId, local = false, now = null, seeking = false, me = null, myLists = [];
const position = () => !now ? 0 : now.paused ? now.position : Math.min(now.duration, now.position + performance.now() - now.at);

let playerStarted = false;
function startPlayer() {
  if (playerStarted || IOS) return; // iPhone: the Spotify app plays; Pulse is its remote
  playerStarted = true;
  window.onSpotifyWebPlaybackSDKReady = () => {
    player = new Spotify.Player({ name: 'Pulse', getOAuthToken: cb => pulse.token().then(cb), volume: +$('vol').value });
    player.addListener('ready', ({ device_id }) => { deviceId = device_id; if (!now) status('READY · PICK SOMETHING'); });
    player.addListener('not_ready', () => { deviceId = null; status('OFFLINE · RECONNECTING'); });
    player.addListener('player_state_changed', s => {
      if (!s) { local = false; poll(); return; } // another device took over
      if (!local) { $('vol').value = savedVolume(); fill($('vol')); } // back in Pulse: its own volume again
      local = true;
      const t = s.track_window.current_track;
      setNow({ ...nowItem({ ...t, duration_ms: s.duration, type: t.type }), linked: t.linked_from?.uri,
        big: t.album?.images?.reduce((a, b) => (b.width ?? 0) > (a?.width ?? 0) ? b : a, null)?.url,
        duration: s.duration, position: s.position, at: performance.now(), paused: s.paused,
        shuffle: s.shuffle, repeat: ['off', 'context', 'track'][s.repeat_mode], device: 'Pulse', context: s.context?.uri });
    });
    player.addListener('account_error', () => toast('Spotify Premium is required to play music in Pulse.'));
    for (const ev of ['initialization_error', 'authentication_error', 'playback_error'])
      player.addListener(ev, ({ message }) => toast(`${ev.replace('_', ' ')}: ${message}`));
    player.connect();
  };
  document.head.append(h('script', { src: 'https://sdk.scdn.co/spotify-player.js' }));
}

// T() skips local files (they can't be played from here), but now-playing must still show them
const nowItem = t => T(t) ?? { uri: t.uri, id: t.id, name: t.name, artists: (t.artists || []).map(a => ({ name: a.name })), album: null };
let volBusyUntil = 0; // don't let polls fight a volume change in progress

// when Pulse isn't the active device, mirror whatever is playing elsewhere (Spotify Connect)
async function poll() {
  if (local || document.body.classList.contains('login')) return;
  try {
    const d = await api('/me/player?additional_types=episode');
    if (!d?.item) { if (!now?.restored) { setNow(null); restoreLast(); } return; } // nothing active anywhere: show the last song
    if (performance.now() > volBusyUntil) { $('vol').value = (d.device?.volume_percent ?? 80) / 100; fill($('vol')); }
    setNow({ ...nowItem(d.item), duration: d.item.duration_ms, position: d.progress_ms, at: performance.now(), paused: !d.is_playing,
      shuffle: d.shuffle_state, repeat: d.repeat_state, device: d.device?.name, context: d.context?.uri });
  } catch { /* offline or no player yet: try again next tick */ }
}
setInterval(poll, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); }); // back from the Spotify app

const after = p => p.then(() => setTimeout(poll, 400)).catch(toast);
const ctl = {
  toggle() {
    if (now?.restored) return resume(now);
    if (!now && IOS) return playOnPhone({});
    if (!now) return deviceId ? after(put('/me/player', { device_ids: [deviceId], play: true })) : toast('Pick something to play');
    local ? player.togglePlay() : after(put(`/me/player/${now.paused ? 'play' : 'pause'}`));
  },
  next: () => now?.restored ? resume(now) : local ? player.nextTrack() : after(post('/me/player/next')),
  prev: () => now?.restored ? resume(now) : local ? player.previousTrack() : after(post('/me/player/previous')),
  seek(ms) { if (!now) return; now.position = ms; now.at = performance.now(); if (now.restored) return; local ? player.seek(ms) : after(put(`/me/player/seek?position_ms=${ms | 0}`)); },
  volume: v => local ? player.setVolume(v) : put(`/me/player/volume?volume_percent=${Math.round(v * 100)}`).catch(toast),
  shuffle: () => now && !now.restored && after(put(`/me/player/shuffle?state=${!now.shuffle}`)),
  repeat: () => now && !now.restored && after(put(`/me/player/repeat?state=${{ off: 'context', context: 'track', track: 'off' }[now.repeat]}`)),
};

// iPhone: play wherever Spotify is active; if nothing is, wake the Spotify app on this phone
// (it starts the first song and hands control straight back), then give it the full request
async function playOnPhone(body) {
  try { await put('/me/player/play', body); setTimeout(poll, 600); return; }
  catch (e) { if (!/Spotify 404/.test(e.message)) return toast(e); } // 404 = no active device
  try { await pulse.wake(body.offset?.uri ?? body.uris?.[0] ?? body.context_uri ?? ''); } catch (e) { return toast(e); }
  for (let i = 0; i < 12; i++) {
    await new Promise(ok => setTimeout(ok, 500));
    try {
      const { devices } = await api('/me/player/devices');
      const d = devices.find(x => x.is_active) || devices.find(x => x.type === 'Smartphone');
      if (d) { await put(`/me/player/play?device_id=${d.id}`, body); setTimeout(poll, 600); return; }
    } catch {}
  }
  setTimeout(poll, 600); // Spotify is playing the first song at least
}

async function play(body) {
  if (IOS) return playOnPhone(body);
  player?.activateElement?.();
  // play where the music already is; otherwise in Pulse
  const target = now && !local && !now.restored ? '' : deviceId ? `?device_id=${deviceId}` : null;
  if (target === null) return toast('Player is still connecting…');
  try { await put('/me/player/play' + target, body); setTimeout(poll, 600); }
  catch (e) { toast(e); }
}
/* last song: saved locally, shown paused on the next launch, resumed from the same spot */
const lastKey = () => `pulse.last.${me?.id}`;
function saveLast() {
  if (!me || !now?.uri || now.restored) return;
  const { uri, id, name, artists, album, big, img, duration, context, episode } = now;
  localStorage.setItem(lastKey(), JSON.stringify({ uri, id, name, artists, album, big, img, duration, context, episode, position: position() }));
}
setInterval(saveLast, 5000);
addEventListener('beforeunload', saveLast);

async function restoreLast() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(lastKey())); } catch {}
  if (!snap) try { // first launch on this Mac: Spotify's own history
    const it = (await api('/me/player/recently-played?limit=1')).items?.[0];
    if (it) snap = { ...nowItem(it.track), duration: it.track.duration_ms, context: it.context?.uri, position: 0 };
  } catch {}
  if (snap && !now) setNow({ ...snap, paused: true, at: performance.now(), shuffle: false, repeat: 'off', device: null, restored: true });
}

async function resume(n) {
  if (IOS) return playOnPhone(n.context ? { context_uri: n.context, offset: { uri: n.uri }, position_ms: n.position | 0 } : { uris: [n.uri], position_ms: n.position | 0 });
  if (!deviceId) return toast('Player is still connecting…');
  player?.activateElement?.();
  const at = `/me/player/play?device_id=${deviceId}`, position_ms = n.position | 0;
  try { await put(at, n.context ? { context_uri: n.context, offset: { uri: n.uri }, position_ms } : { uris: [n.uri], position_ms }); }
  catch { // the playlist/album may be gone or not allow offsets: play just the song
    try { await put(at, { uris: [n.uri], position_ms }); } catch (e) { toast(e); }
  }
}

const playUris = (i, rows) => play({ uris: rows.slice(i, i + 100).map(r => r.uri) }); // ponytail: queues the next 100 only
const playIn = ctx => (i, rows) => play({ context_uri: ctx, offset: { uri: rows[i].uri } });

function status(text) { $('status').textContent = text; }

let lastUri = null;
function setNow(n) {
  now = n;
  Dither.playing = !!n && !n.paused;
  document.body.classList.toggle('paused', !n || n.paused);
  $('play').ariaLabel = !n || n.paused ? 'Play' : 'Pause';
  if (!n) {
    lastUri = null;
    $('seek').value = 0; fill($('seek')); $('cur').textContent = '0:00'; $('rem').textContent = '-0:00';
    $('title').textContent = 'NOTHING PLAYING'; $('artist').replaceChildren('Pick something to play'); $('like').hidden = true;
    status(deviceId ? 'READY · PICK SOMETHING' : 'CONNECTING…');
    navigator.mediaSession.playbackState = 'none';
    return markPlaying();
  }
  $('shuffle').classList.toggle('on', !!n.shuffle);
  $('repeat').classList.toggle('on', n.repeat !== 'off');
  $('repeatOne').hidden = n.repeat !== 'track';
  status(n.restored ? 'LAST PLAYED · PRESS PLAY' : `PLAYING ON ${(n.device || 'UNKNOWN DEVICE').toUpperCase()}`);
  navigator.mediaSession.playbackState = n.paused ? 'paused' : 'playing';
  if (n.uri === lastUri) return;
  lastUri = n.uri;
  onTrack.forEach(f => f(n));
  $('title').textContent = n.name;
  fillIn($('artist'), artistLinks(n.artists || []));
  setCover(n.big || n.img);
  likeButton(n);
  markPlaying();
  if (!$('pane-queue').hidden) renderQueue();
  navigator.mediaSession.metadata = new MediaMetadata({ title: n.name, artist: (n.artists || []).map(a => a.name).join(', '), album: n.album?.name || '',
    artwork: n.big ? [{ src: n.big, sizes: '640x640', type: 'image/jpeg' }] : [] });
}

function markPlaying() {
  for (const r of document.querySelectorAll('.trow'))
    r.classList.toggle('on', !!now && (r.dataset.uri === now.uri || r.dataset.uri === now.linked));
}

async function likeButton(n) {
  const b = $('like');
  b.hidden = n.episode || !n.id;
  if (b.hidden) return;
  const set = setHeart;
  set(false);
  try { const v = await lib.has(n.uri); if (now?.uri === n.uri) set(v); } catch {}
}
function setHeart(v) { const b = $('like'); b.classList.toggle('on', v); b.textContent = v ? '♥' : '♡'; b.ariaLabel = v ? 'Remove from Liked Songs' : 'Save to Liked Songs'; }
$('like').onclick = async () => {
  const cur = now;
  if (!cur?.id || cur.episode) return;
  const on = $('like').classList.contains('on');
  try {
    await (on ? lib.remove : lib.save)(cur.uri);
    if (now?.uri === cur.uri) setHeart(!on);
    toast(on ? 'Removed from Liked Songs' : 'Added to Liked Songs');
  } catch (e) { toast(e); }
};

for (const [a, fn] of [['play', () => ctl.toggle()], ['pause', () => ctl.toggle()], ['nexttrack', ctl.next], ['previoustrack', ctl.prev]])
  navigator.mediaSession.setActionHandler(a, fn);
navigator.mediaSession.setActionHandler('seekto', e => ctl.seek(e.seekTime * 1000));

// progress bar runs off the frame loop in dither.js
Dither.onFrame = () => {
  onTick.forEach(f => f());
  if (!now || seeking) return;
  const pos = position(), s = $('seek');
  s.max = now.duration; s.value = pos; fill(s);
  $('cur').textContent = fmt(pos); $('rem').textContent = '-' + fmt(now.duration - pos);
};

/* ---------- shared UI ---------- */
function goUri(uri) {
  const [, type, id] = uri.split(':');
  if (['album', 'artist', 'playlist', 'show'].includes(type)) go({ v: type, id });
}
function link(text, uri) {
  return h('a', { class: 'link', href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); goUri(uri); } }, text);
}
const artistLinks = artists => artists.flatMap((a, i) => [i ? ', ' : null, a.uri ? link(a.name, a.uri) : a.name]);

// touch long-press -> handler(eventLike); marks the element so the tap that follows is ignored
function longPress(fn) {
  let timer;
  const cancel = () => clearTimeout(timer);
  return {
    ontouchstart: e => {
      const el = e.currentTarget, t = e.touches[0];
      timer = setTimeout(() => { el.dataset.lp = '1'; fn({ preventDefault() {}, clientX: t.clientX, clientY: t.clientY }); }, 450);
    },
    ontouchmove: cancel, ontouchend: cancel, ontouchcancel: cancel,
  };
}
const afterLongPress = e => { const el = e.currentTarget; if (!el.dataset.lp) return false; delete el.dataset.lp; return true; };

function trackTable(playFn, opts = {}) {
  const rows = [], ul = h('ul', { class: 'tracks' + (opts.album === false ? ' noalbum' : '') });
  ul.add = more => {
    for (const t of more) {
      if (!t) continue;
      const i = rows.push(t) - 1;
      ul.append(h('li', { style: `--i:${Math.min(i % 50, 20)}` }, h('div', {
        class: 'row trow' + (t.playable === false ? ' off' : ''), role: 'button', tabIndex: 0, 'data-uri': t.uri,
        onclick: e => afterLongPress(e) || playFn(i, rows), onkeydown: e => e.key === 'Enter' && playFn(i, rows),
        oncontextmenu: e => trackMenu(e, t, opts, ul),
        ...(IOS ? longPress(e => trackMenu(e, t, opts, ul)) : {}),
        draggable: !t.episode,
        ondragstart: e => { e.dataTransfer.setData('text/uri-list', t.uri); e.dataTransfer.setData('pulse/pos', String(t.pos ?? '')); e.dataTransfer.effectAllowed = 'copyMove'; },
        ondragover: opts.reorder ? e => { if (e.dataTransfer.types.includes('pulse/pos')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } } : null,
        ondragleave: opts.reorder ? e => e.currentTarget.classList.remove('drop') : null,
        ondrop: opts.reorder ? e => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const from = +e.dataTransfer.getData('pulse/pos'); if (Number.isFinite(from) && from !== t.pos) opts.reorder(from, t.pos); } : null,
      },
        h('span', { class: 'num' }, i + 1), img(t.img, 'thumb'),
        h('div', { class: 'clip' }, h('span', {}, t.name, t.explicit ? h('i', { class: 'e' }, 'E') : null), h('small', {}, t.sub ?? artistLinks(t.artists), t.when ? ' · ' + ago(t.when) : null)),
        opts.album === false ? null : h('span', { class: 'dim clip' }, h('span', {}, t.album ? link(t.album.name, t.album.uri) : '')),
        h('span', { class: 'dim' }, fmt(t.ms)))));
    }
    markPlaying();
  };
  return ul;
}

// keep appending pages while this view is still on screen
async function morePages(next, table, map) {
  const mine = renderId;
  try {
    while (next && mine === renderId) { const d = await api(next); table.add(d.items.map((it, k) => map(it, (d.offset ?? 0) + k))); next = d.next; }
  } catch (e) { toast(e); }
}

function card(x) {
  if (!x) return null;
  const sub = {
    album: () => `${x.release_date?.slice(0, 4) ?? ''} · ${x.artists?.map(a => a.name).join(', ') ?? ''}`,
    playlist: () => 'By ' + (x.owner?.display_name ?? 'Spotify'),
    artist: () => 'Artist',
    show: () => x.publisher || 'Podcast',
  }[x.type]?.() ?? '';
  const open = () => goUri(x.uri);
  return h('div', { class: 'card', role: 'button', tabIndex: 0, onclick: open, onkeydown: e => e.key === 'Enter' && open() },
    h('div', { class: 'cimg' + (x.type === 'artist' ? ' round' : '') },
      img(x.images?.[1]?.url ?? x.images?.[0]?.url),
      h('button', { class: 'cplay', 'aria-label': 'Play ' + x.name, onclick: e => { e.stopPropagation(); play({ context_uri: x.uri }); } }, icon(PLAY_SVG))),
    h('b', {}, x.name), h('small', {}, sub));
}
const likedCard = () => h('div', { class: 'card', role: 'button', tabIndex: 0, onclick: () => go({ v: 'liked' }) },
  h('div', { class: 'cimg liked' }, '♥'), h('b', {}, 'Liked Songs'), h('small', {}, 'Your saved songs'));

const shelf = (title, items) => {
  const cards = items.map(card).filter(Boolean);
  return cards.length ? h('div', { class: 'shelf' }, h('h2', {}, title), h('div', { class: 'grid' }, cards)) : null;
};

function hero(cover, kind, title, meta) {
  return h('header', { class: 'hero' }, cover,
    h('div', { class: 'clip' }, h('small', {}, kind), h('h1', {}, title), h('p', { class: 'dim' }, meta)));
}
const bigPlay = fn => h('button', { class: 'bigplay', 'aria-label': 'Play', onclick: fn }, icon('<svg width="24" height="24" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>'));
const shuffleBtn = ctx => h('button', { class: 'btn', onclick: async () => {
  try { if (deviceId && (local || !now)) await put(`/me/player/shuffle?state=true&device_id=${deviceId}`); else await put('/me/player/shuffle?state=true'); }
  catch { /* no active device yet: play() below activates one */ }
  play({ context_uri: ctx });
} }, 'SHUFFLE');

// FOLLOW / SAVE style toggle for anything in the library
function toggle(uri, [off, on]) {
  const b = h('button', { class: 'btn' }, off);
  let state = false;
  const set = v => { state = v; b.textContent = v ? on : off; b.classList.toggle('on', v); };
  lib.has(uri).then(set).catch(() => {});
  b.onclick = async () => {
    try { await (state ? lib.remove : lib.save)(uri); set(!state); loadSidebar(); }
    catch (e) { toast(e); }
  };
  return b;
}

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

async function trackMenu(e, t, opts, table) {
  e.preventDefault();
  let liked = false;
  if (!t.episode) try { liked = await lib.has(t.uri); } catch {}
  const ownPl = opts.playlist && opts.playlist.owner?.id === me.id;
  menu(e, [
    ['Add to queue', () => post(`/me/player/queue?uri=${encodeURIComponent(t.uri)}`).then(() => toast('Added to queue'), toast)],
    !t.episode && [liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', () =>
      (liked ? lib.remove : lib.save)(t.uri).then(() => { toast(liked ? 'Removed from Liked Songs' : 'Added to Liked Songs'); if (now?.id === t.id) likeButton(now); }, toast)],
    !t.episode && ['Add to playlist…', () => addToPlaylist(t)],
    ownPl && ['Remove from this playlist', async () => {
      try {
        await del(`/playlists/${opts.playlist.id}/items`, { items: [{ uri: t.uri }] });
        table.querySelectorAll(`.trow[data-uri="${CSS.escape(t.uri)}"]`).forEach(r => r.closest('li').remove());
        toast('Removed from playlist');
      } catch (err) { toast(err); }
    }],
    '-',
    t.artists[0]?.uri && ['Go to ' + (t.episode ? 'podcast' : 'artist'), () => goUri(t.artists[0].uri)],
    !t.episode && t.album && ['Go to album', () => goUri(t.album.uri)],
    ['Copy link', () => navigator.clipboard.writeText(`https://open.spotify.com/${t.episode ? 'episode' : 'track'}/${t.id}`).then(() => toast('Link copied'))],
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

async function createPlaylist() {
  const name = await modal('NEW PLAYLIST', done => {
    const input = h('input', { class: 'search', placeholder: 'Playlist name', value: 'My Playlist' });
    return h('form', { style: 'display:grid;gap:14px', onsubmit: e => { e.preventDefault(); done(input.value.trim() || null); } },
      input, h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'CANCEL'), h('button', { class: 'btn on' }, 'CREATE')));
  });
  if (!name) return;
  try {
    const pl = await post('/me/playlists', { name, public: false });
    await loadSidebar(); go({ v: 'playlist', id: pl.id }); toast('Playlist created');
  } catch (e) { toast(e); }
}

async function addToPlaylist(t) {
  const editable = myLists.filter(p => p.owner?.id === me.id || p.collaborative);
  const id = await modal('ADD TO PLAYLIST', done => h('div', { class: 'scroll', style: 'display:grid;gap:2px' },
    editable.length ? editable.map(p => h('button', { class: 'row', onclick: () => done(p.id) },
      img(p.images?.at(-1)?.url, 'thumb'), h('div', { class: 'clip' }, h('span', {}, p.name), h('small', {}, (pageOf(p)?.total ?? 0) + ' songs'))))
      : h('p', { class: 'dim' }, 'You have no playlists yet. Create one with + in the sidebar.')));
  if (!id) return;
  try { await post(`/playlists/${id}/items`, { uris: [t.uri] }); toast('Added to playlist'); }
  catch (e) { toast(e); }
}

/* ---------- router ---------- */
const hist = []; let hpos = -1, renderId = 0;
function go(route, replace = false) {
  if (replace && hpos >= 0) hist[hpos] = route;
  else { hist.splice(hpos + 1); hist.push(route); hpos = hist.length - 1; }
  render();
}
async function render() {
  const route = hist[hpos], mine = ++renderId, view = $('view');
  $('back').disabled = hpos <= 0; $('fwd').disabled = hpos >= hist.length - 1;
  for (const n of document.querySelectorAll('.nav')) n.classList.toggle('on', n.dataset.v === route.v);
  for (const r of $('lists').querySelectorAll('.row')) r.classList.toggle('on', r.dataset.id === (route.v === 'liked' ? 'liked' : route.id));
  closeMenu();
  view.replaceChildren(h('div', { class: 'loading' }, 'LOADING'));
  try {
    const node = await VIEWS[route.v](route);
    if (mine !== renderId) return;
    view.replaceChildren(node); view.scrollTop = 0; markPlaying();
  } catch (e) {
    if (mine === renderId) view.replaceChildren(h('div', { class: 'empty' },
      /404/.test(e.message) && route.v === 'playlist' ? 'Spotify doesn’t let third-party apps open this playlist (Spotify-made playlists are blocked).' : e.message));
  }
}

/* ---------- views ---------- */
// follow `next` links until `max` items (endpoints with small page caps)
async function collect(url, max) {
  const out = [];
  while (url && out.length < max) { const d = await api(url); out.push(...d.items.filter(Boolean)); url = d.next; }
  return out;
}

function renderArtist(ar, releases, pages) {
  const id = ar.id, seen = new Set();
  const songs = pages.flatMap(p => p?.tracks?.items || [])
    .filter(t => t?.artists?.some(a => a.id === id))
    .filter(t => { const k = t.name.toLowerCase().replace(/\s*[-(\[].*$/, ''); return !seen.has(k) && seen.add(k); }) // one version per song
    .slice(0, 10);
  const table = trackTable(playUris); table.add(songs.map(t => T(t)));
  const own = releases.filter(r => r.artists?.some(a => a.id === id)); // album_group was removed, so check the credits
  const byDate = (a, b) => (b.release_date || '').localeCompare(a.release_date || '');
  return h('div', {},
    hero(img(ar.images?.[0]?.url, 'round'), 'ARTIST', ar.name, (ar.genres || []).slice(0, 3).join(' · ')),
    h('div', { class: 'actions' }, bigPlay(() => play({ context_uri: ar.uri })), toggle(ar.uri, ['FOLLOW', 'FOLLOWING'])),
    songs.length ? h('div', { class: 'shelf' }, h('h2', {}, 'POPULAR'), table) : null,
    shelf('ALBUMS', own.filter(r => r.album_type === 'album').sort(byDate)),
    shelf('SINGLES & EPS', own.filter(r => r.album_type !== 'album').sort(byDate)),
    shelf('APPEARS ON', releases.filter(r => !own.includes(r))));
}

const VIEWS = {
  async home() {
    const hr = new Date().getHours();
    const [recent, artists, tracks, albums] = await Promise.allSettled([
      api('/me/player/recently-played?limit=50'), api('/me/top/artists?limit=12&time_range=short_term'),
      api('/me/top/tracks?limit=10&time_range=short_term'), api('/me/albums?limit=12'),
    ]);
    const ok = r => r.status === 'fulfilled' ? r.value : null;
    const seen = new Set(), recentAlbums = (ok(recent)?.items || []).map(i => i.track.album).filter(a => a && !seen.has(a.id) && seen.add(a.id)).slice(0, 12);
    const top = ok(tracks)?.items?.map(t => T(t)) || [];
    const topTable = trackTable(playUris); topTable.add(top);
    return h('div', {},
      h('div', { class: 'hello' }, hr < 5 ? 'GOOD NIGHT' : hr < 12 ? 'GOOD MORNING' : hr < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING', me?.display_name ? `, ${me.display_name.toUpperCase()}` : ''),
      shelf('JUMP BACK IN', recentAlbums),
      top.length ? h('div', { class: 'shelf' }, h('h2', {}, 'ON REPEAT'), topTable) : null,
      shelf('YOUR TOP ARTISTS', ok(artists)?.items || []),
      shelf('YOUR ALBUMS', (ok(albums)?.items || []).map(i => i.album)));
  },

  async search({ q }) {
    if (!q) return h('div', { class: 'empty' }, 'Search for songs, artists, albums, playlists and podcasts.');
    const d = await api(`/search?type=track,artist,album,playlist,show&limit=10&q=${encodeURIComponent(q)}`);
    const songs = trackTable(playUris); songs.add((d.tracks?.items || []).map(t => T(t)));
    const has = x => (x?.items || []).filter(Boolean);
    return h('div', {},
      has(d.tracks).length ? h('div', { class: 'shelf' }, h('h2', {}, 'SONGS'), songs) : null,
      shelf('ARTISTS', has(d.artists)), shelf('ALBUMS', has(d.albums)),
      shelf('PLAYLISTS', has(d.playlists)), shelf('PODCASTS', has(d.shows)),
      !['tracks', 'artists', 'albums', 'playlists', 'shows'].some(k => has(d[k]).length) ? h('div', { class: 'empty' }, `No results for “${q}”.`) : null);
  },

  async library({ tab = 'playlists' }) {
    const tabs = { playlists: 'PLAYLISTS', albums: 'ALBUMS', artists: 'ARTISTS', shows: 'PODCASTS' };
    let items = [];
    if (tab === 'playlists') items = myLists;
    if (tab === 'albums') items = (await api('/me/albums?limit=50')).items.map(i => i.album);
    if (tab === 'artists') items = (await api('/me/following?type=artist&limit=50')).artists.items;
    if (tab === 'shows') items = (await api('/me/shows?limit=50')).items.map(i => i.show);
    return h('div', {},
      h('div', { class: 'hello' }, 'YOUR LIBRARY'),
      h('div', { class: 'chips' }, Object.entries(tabs).map(([k, label]) =>
        h('button', { class: 'btn' + (k === tab ? ' on' : ''), onclick: () => go({ v: 'library', tab: k }, true) }, label))),
      h('div', { class: 'grid' }, tab === 'playlists' ? likedCard() : null, items.map(card)),
      !items.length && tab !== 'playlists' ? h('div', { class: 'empty' }, 'Nothing saved here yet.') : null);
  },

  async history() {
    const d = await api('/me/player/recently-played?limit=50');
    const map = i => { const t = T(i.track); return t && { ...t, when: i.played_at }; };
    const table = trackTable(playUris); table.add(d.items.map(map));
    morePages(d.next, table, map);
    return h('div', {},
      hero(h('div', { class: 'liked' }, '↺'), 'HISTORY', 'Recently Played', 'Everything you played on any device, newest first'),
      d.items.length ? table : h('div', { class: 'empty' }, 'Nothing played yet.'));
  },

  async liked() {
    const d = await api('/me/tracks?limit=50');
    const table = trackTable(playUris, {}); table.add(d.items.map(i => T(i.track)));
    morePages(d.next, table, i => T(i.track));
    return h('div', {},
      hero(h('div', { class: 'liked' }, '♥'), 'PLAYLIST', 'Liked Songs', `${me.display_name} · ${d.total} songs`),
      h('div', { class: 'actions' }, bigPlay(() => playUris(0, d.items.map(i => T(i.track)).filter(Boolean)))),
      table);
  },

  async playlist({ id }) {
    const pl = await api(`/playlists/${id}`);
    const pg = pageOf(pl), listed = Array.isArray(pg?.items);
    const own = pl.owner?.id === me.id;
    const at = (i, pos) => { const t = T(itemOf(i)); return t && { ...t, pos }; };
    const table = trackTable(playIn(pl.uri), { playlist: pl, reorder: own || pl.collaborative ? (from, to) => reorderPlaylist(pl, from, to) : null });
    if (listed) { table.add(pg.items.map((it, k) => at(it, (pg.offset ?? 0) + k))); morePages(pg.next, table, at); }
    return h('div', {},
      hero(img(pl.images?.[0]?.url), pl.public ? 'PUBLIC PLAYLIST' : 'PLAYLIST', pl.name,
        [plain(pl.description), plain(pl.description) ? h('br') : null, pl.owner?.display_name, pg?.total != null ? ` · ${pg.total} songs` : '']),
      h('div', { class: 'actions' }, bigPlay(() => play({ context_uri: pl.uri })), shuffleBtn(pl.uri),
        own ? h('button', { class: 'btn', onclick: () => editPlaylist(pl) }, 'EDIT') : toggle(pl.uri, ['FOLLOW', 'FOLLOWING'])),
      !listed ? h('div', { class: 'empty' }, 'Spotify only shows the song list for playlists you own or collaborate on. Press play to listen.')
        : pg.total ? table : h('div', { class: 'empty' }, own ? 'Empty playlist. Right-click any song → Add to playlist.' : 'No songs.'));
  },

  async album({ id }) {
    const al = await api(`/albums/${id}`);
    const table = trackTable(playIn(al.uri), { album: false }); table.add(al.tracks.items.map(t => T(t, al)));
    morePages(al.tracks.next, table, t => T(t, al));
    return h('div', {},
      hero(img(al.images?.[0]?.url), al.album_type?.toUpperCase() || 'ALBUM', al.name,
        [...artistLinks(al.artists), ` · ${al.release_date?.slice(0, 4)} · ${al.total_tracks} songs`]),
      h('div', { class: 'actions' }, bigPlay(() => play({ context_uri: al.uri })), shuffleBtn(al.uri),
        toggle(al.uri, ['SAVE', 'SAVED'])),
      table,
      al.copyrights?.[0] ? h('p', { class: 'dim', style: 'margin-top:20px' }, al.copyrights[0].text) : null);
  },

  async artist({ id }) {
    // Spotify caps these endpoints at 10 per request (Feb 2026), so page through them
    const ar = await api(`/artists/${id}`); // the search below needs the name
    const [releases, ...pages] = await Promise.all([
      collect(`/artists/${id}/albums?include_groups=album,single,appears_on&limit=10`, 60).catch(() => []),
      // top-tracks is gone too: the best stand-in is a relevance-ranked search for this artist's songs
      ...[0, 10, 20].map(o => api(`/search?type=track&limit=10&offset=${o}&q=${encodeURIComponent(`artist:"${ar.name}"`)}`).catch(() => null)),
    ]);
    return renderArtist(ar, releases, pages);
  },

  async show({ id }) {
    const sh = await api(`/shows/${id}`);
    const map = e => e && T({ ...e, type: 'episode', show: sh });
    const table = trackTable(playIn(sh.uri), { album: false }); table.add(sh.episodes.items.map(map));
    morePages(sh.episodes.next, table, map);
    return h('div', {},
      hero(img(sh.images?.[0]?.url), 'PODCAST', sh.name, [sh.publisher, h('br'), plain(sh.description).slice(0, 280)]),
      h('div', { class: 'actions' }, toggle(sh.uri, ['FOLLOW', 'FOLLOWING'])),
      table);
  },
};

/* ---------- sidebar ---------- */
async function loadSidebar() {
  try {
    const items = []; let next = '/me/playlists?limit=50';
    while (next && items.length < 500) { const d = await api(next); items.push(...d.items.filter(Boolean)); next = d.next; }
    myLists = items;
  } catch (e) { toast(e); }
  const cur = hist[hpos];
  const row = (id, name, sub, thumb, route, i) => h('li', { style: `--i:${i}` },
    h('button', { class: 'row' + ((cur?.v === 'liked' ? 'liked' : cur?.id) === id ? ' on' : ''), 'data-id': id, onclick: () => go(route),
      ...dropTarget(id, route),
      oncontextmenu: route.v === 'playlist' ? e => menu(e, [['Play', () => play({ context_uri: `spotify:playlist:${id}` })], ['Copy link', () => navigator.clipboard.writeText(`https://open.spotify.com/playlist/${id}`)]]) : null },
      thumb, h('div', { class: 'clip' }, h('span', {}, name), h('small', {}, sub))));
  $('lists').replaceChildren(
    row('liked', 'Liked Songs', 'Playlist', h('div', { class: 'thumb liked', style: 'font-size:16px' }, '♥'), { v: 'liked' }, 0),
    ...myLists.map((p, i) => row(p.id, p.name, p.owner?.display_name ?? '', img(p.images?.at(-1)?.url, 'thumb'), { v: 'playlist', id: p.id }, i + 1)));
}

/* ---------- right panel ---------- */
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const p of ['playing', 'lyrics', 'queue', 'devices']) $('pane-' + p).hidden = p !== name;
  if (name === 'lyrics') renderLyrics();
  if (name === 'queue') renderQueue();
  if (name === 'devices') renderDevices();
}
const qrow = t => h('li', {}, h('div', { class: 'row qrow' }, img(t.img, 'thumb'), h('div', { class: 'clip' }, h('span', {}, t.name), h('small', {}, t.artists.map(a => a.name).join(', ')))));
async function renderQueue() {
  const pane = $('pane-queue');
  try {
    const d = await api('/me/player/queue');
    const cur = T(d?.currently_playing), next = (d?.queue || []).map(t => T(t)).filter(Boolean);
    fillIn(pane,
      h('h3', {}, 'NOW PLAYING'), cur ? qrow(cur) : h('p', { class: 'dim' }, 'Nothing playing.'),
      h('h3', {}, 'NEXT UP'), next.length ? next.map(qrow) : h('p', { class: 'dim' }, 'Queue is empty. Right-click a song → Add to queue.'));
  } catch (e) { pane.replaceChildren(h('p', { class: 'dim' }, e.message)); }
}
async function renderDevices() {
  const pane = $('pane-devices');
  try {
    const { devices } = await api('/me/player/devices');
    fillIn(pane, h('h3', {}, 'CONNECT TO A DEVICE'), devices.map(d => h('li', {}, h('button', {
      class: 'row dev' + (d.is_active ? ' on' : ''),
      onclick: async () => { try { await put('/me/player', { device_ids: [d.id], play: !!now && !now.paused }); setTimeout(() => { poll(); renderDevices(); }, 800); } catch (e) { toast(e); } },
    }, h('div', { class: 'clip' }, h('span', {}, d.name), h('small', {}, d.type + (d.is_active ? ' · ACTIVE' : ''))), h('span', { class: 'dim' }, d.volume_percent != null ? d.volume_percent + '%' : '')))),
    h('p', { class: 'dim', style: 'margin-top:12px' }, 'Open Spotify on your phone, speaker or another computer to see it here.'));
  } catch (e) { pane.replaceChildren(h('p', { class: 'dim' }, e.message)); }
}

/* ---------- wiring ---------- */
for (const n of document.querySelectorAll('.nav')) n.onclick = () => n.dataset.v === 'search' ? ($('search').focus(), go({ v: 'search', q: $('search').value.trim() })) : go({ v: n.dataset.v });
for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
$('status').onclick = () => showTab('devices');
$('back').onclick = () => { if (hpos > 0) { hpos--; render(); } };
$('fwd').onclick = () => { if (hpos < hist.length - 1) { hpos++; render(); } };
$('newPl').onclick = createPlaylist;

/* iPhone layout: tab bar + mini "now playing" bar; the player panel becomes a slide-up sheet */
const REDIRECT_URI = IOS ? 'pulse://callback' : 'http://127.0.0.1:8888/callback';
if (IOS) {
  const tab = (v, label) => h('button', { class: 'nav', 'data-v': v, onclick: () => go({ v }) }, label);
  document.body.append(
    h('div', { id: 'minibar', role: 'button', 'aria-label': 'Open player', onclick: e => { if (!e.target.closest('#mbPlay')) document.body.classList.add('sheet'); } },
      h('img', { id: 'mbArt', alt: '' }),
      h('div', { class: 'clip' }, h('b', { id: 'mbTitle' }, 'NOTHING PLAYING'), h('small', { id: 'mbArtist' })),
      h('button', { id: 'mbPlay', 'aria-label': 'Play or pause', onclick: () => ctl.toggle() }, '▶')),
    h('nav', { id: 'tabbar' }, tab('home', 'HOME'), tab('search', 'SEARCH'), tab('library', 'LIBRARY'), tab('history', 'HISTORY'), tab('stats', 'STATS')));
  document.querySelector('main').prepend(h('button', { id: 'sheetClose', 'aria-label': 'Close player', onclick: () => document.body.classList.remove('sheet') }, '⌄'));
  document.querySelector('.topbar').append($('settingsBtn')); // no sidebar on a phone
  for (const c of document.querySelectorAll('#login code')) c.textContent = REDIRECT_URI;
  $('search').placeholder = 'Search songs, artists, albums'; // no keyboard shortcuts on a phone
  let shown = '';
  onTick.push(() => { // mini bar mirrors the player; only touch the DOM when something changed
    const key = now ? `${now.uri}|${now.paused}` : '';
    if (key === shown) return;
    shown = key;
    $('mbArt').src = now?.img || now?.big || '';
    $('mbTitle').textContent = now?.name || 'NOTHING PLAYING';
    $('mbArtist').textContent = (now?.artists || []).map(a => a.name).join(', ');
    $('mbPlay').textContent = now && !now.paused ? '❚❚' : '▶';
  });
}

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
  searchTimer = setTimeout(() => go({ v: 'search', q }, hist[hpos]?.v === 'search'), 300);
};

$('play').onclick = () => ctl.toggle();
$('next').onclick = () => ctl.next();
$('prev').onclick = () => ctl.prev();
$('shuffle').onclick = () => ctl.shuffle();
$('repeat').onclick = () => ctl.repeat();
$('seek').onpointerdown = () => seeking = true;
$('seek').onpointerup = $('seek').onpointercancel = () => seeking = false;
$('seek').oninput = e => { fill(e.target); $('cur').textContent = fmt(+e.target.value); };
$('seek').onchange = e => { seeking = false; ctl.seek(+e.target.value); };
let volTimer;
$('vol').oninput = e => { fill(e.target); localStorage.setItem('pulse.volume', e.target.value); volBusyUntil = performance.now() + 3000; clearTimeout(volTimer); volTimer = setTimeout(() => ctl.volume(+e.target.value), 120); };

document.onkeydown = e => {
  if (e[MOD] && e.code === 'KeyK') { e.preventDefault(); return openPalette(); }
  if (e[MOD] && (e.code === 'KeyF' || e.code === 'KeyL')) { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (e[MOD] && e.shiftKey && e.code === 'KeyM') { e.preventDefault(); return setMini(!miniOn); }
  if (e[MOD] && e.code === 'BracketLeft') return $('back').click();
  if (e[MOD] && e.code === 'BracketRight') return $('fwd').click();
  if (e.target.tagName === 'INPUT' || document.querySelector('.modal')) return;
  if (e.code === 'Space') { e.preventDefault(); ctl.toggle(); }
  if (e[MOD] && e.code === 'ArrowRight') ctl.next();
  if (e[MOD] && e.code === 'ArrowLeft') ctl.prev();
  if (e[MOD] && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    const v = $('vol'); v.value = Math.max(0, Math.min(1, +v.value + (e.code === 'ArrowUp' ? .1 : -.1))); v.oninput({ target: v });
  }
  if (e.key === 'Escape') closeMenu();
};

/* ---------- auth / boot ---------- */
function showLogin(msg) {
  document.body.classList.add('login'); $('login').hidden = false;
  if (msg) $('loginMsg').textContent = msg;
}
// login screen has two states: connect (an app is configured) and setup (paste your own Client ID)
let builtIn = false;
function showConnect(msg) {
  showLogin(msg);
  $('setup').hidden = true; $('loginBtn').hidden = false; $('ownApp').hidden = false;
}
function showSetup(msg) {
  showLogin(msg ?? 'Use your own Spotify app: free, about 2 minutes, and only you (plus up to 4 people you invite) can use it.');
  $('setup').hidden = false; $('loginBtn').hidden = true; $('ownApp').hidden = true;
  $('backToConnect').hidden = !builtIn;
  $('clientId').focus();
}
$('ownApp').onclick = () => showSetup();
$('backToConnect').onclick = async () => { await pulse.useBuiltIn(); showConnect('Connect your Spotify Premium account to start listening.'); };
$('setup').onsubmit = async e => {
  e.preventDefault();
  try { await pulse.setClientId($('clientId').value); showConnect('Saved. Now connect your Spotify Premium account.'); }
  catch (err) { toast(err); }
};

async function boot() {
  document.body.classList.remove('login'); $('login').hidden = true;
  startPlayer();
  for (let wait = 2000; ; wait = Math.min(wait * 2, 30000)) {
    try { me = await api('/me'); break; }
    catch (e) {
      if (document.body.classList.contains('login')) return; // logged out: the login screen takes over
      if (/Spotify 403/.test(e.message)) { // dev-mode app: this account isn't on its user list
        await pulse.logout();
        return showConnect(builtIn && !(await pulse.clientInfo()).custom
          ? 'This Spotify account isn’t on Pulse’s invite list (Spotify allows 5 people per app). Ask the person who shared Pulse to add your email, or use your own Spotify app below.'
          : 'Spotify refused this account. In your app on developer.spotify.com, add this account’s email under User Management, then connect again.');
      }
      toast(`${e.message} · retrying in ${wait / 1000}s`);
      await new Promise(ok => setTimeout(ok, wait));
    }
  }
  $('me').textContent = me.display_name || me.id;
  if (me.product && me.product !== 'premium') toast('This account is not Premium: playback will not work.');
  go({ v: 'home' });
  loadSidebar();
  await poll();
  if (!now) restoreLast();
}

$('loginBtn').onclick = async () => {
  $('loginBtn').textContent = 'WAITING FOR BROWSER…';
  try { await pulse.login(); boot(); }
  catch (e) { toast(e); }
  finally { $('loginBtn').textContent = 'CONNECT SPOTIFY'; }
};
async function logout() { await pulse.logout(); player?.disconnect(); location.reload(); } // used by Settings

// Pulse's own volume is remembered; while another device plays, the slider shows that device's volume instead
const savedVolume = () => { const v = parseFloat(localStorage.getItem('pulse.volume')); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : .8; };
$('vol').value = savedVolume();
fill($('vol'));
(async () => {
  builtIn = (await pulse.clientInfo()).builtIn;
  if (!await pulse.configured()) return showSetup('One-time setup: Pulse needs a Spotify app to talk to Spotify.');
  let t; try { t = await pulse.token(); } catch { t = 'offline'; } // offline: boot keeps retrying
  t ? boot() : showConnect('Connect your Spotify Premium account to start listening.');
})();

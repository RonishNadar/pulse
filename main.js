const { app, BrowserWindow, Menu, components, ipcMain, shell, safeStorage } = require('electron');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The Spotify Client ID is entered on first launch and kept in userData/config.json
// (it is not a secret: PKCE flow, no client secret).
const CONFIG = path.join(app.getPath('userData'), 'config.json');
let CLIENT_ID = '';
try { CLIENT_ID = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).clientId || ''; } catch {}
const PORT = 8888;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state',
  'user-read-currently-playing', 'user-read-recently-played', 'user-top-read',
  'user-library-read', 'user-library-modify', 'user-follow-read', 'user-follow-modify',
  'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private',
  'ugc-image-upload', // playlist covers
].join(' ');
// a session granted fewer scopes (older Pulse) must log in again
const hasScopes = granted => SCOPES.split(' ').every(s => (granted || '').split(' ').includes(s));

const SESSION = path.join(app.getPath('userData'), 'session.bin');
let tok = null; // { access, refresh, scope, exp }

function save() {
  // refresh token is a long-lived credential: encrypt with the OS keychain
  if (tok && safeStorage.isEncryptionAvailable())
    fs.writeFileSync(SESSION, safeStorage.encryptString(JSON.stringify({ refresh: tok.refresh, scope: tok.scope })));
}
function restore() {
  try {
    const s = JSON.parse(safeStorage.decryptString(fs.readFileSync(SESSION)));
    tok = hasScopes(s.scope) ? { ...s, exp: 0 } : null;
  } catch { tok = null; }
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!r.ok) throw Object.assign(new Error(`Spotify token error ${r.status}: ${await r.text()}`), { status: r.status });
  const j = await r.json();
  tok = { access: j.access_token, refresh: j.refresh_token || tok?.refresh, scope: j.scope || tok?.scope, exp: Date.now() + (j.expires_in - 60) * 1000 };
  save();
  return tok.access;
}

let pending = null, authUrl = ''; // one login at a time
function login() {
  if (pending) { shell.openExternal(authUrl); return pending; } // clicked again: reopen the page
  pending = new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const url = authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, state,
    });

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') return res.writeHead(404).end();
      const code = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end(`<body style="font:16px monospace;background:#111;color:#eee;padding:40px">${code ? 'Connected. You can close this tab and return to Pulse.' : 'Login failed. Return to Pulse and try again.'}</body>`);
      server.close();
      if (!code) return reject(new Error(u.searchParams.get('error') || 'Login state mismatch'));
      try {
        resolve(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }));
        win?.focus();
      } catch (e) { reject(e); }
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => shell.openExternal(url));
  }).finally(() => { pending = null; });
  return pending;
}

// null = logged out (show login); throws = couldn't refresh right now (keep the session, retry later)
let refreshing = null;
async function token() {
  if (tok?.access && Date.now() < tok.exp) return tok.access;
  if (!tok?.refresh) return null;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh })
    .catch(e => {
      if (e.status === 400 || e.status === 401) { tok = null; fs.rmSync(SESSION, { force: true }); return null; } // revoked
      throw new Error('Couldn’t reach Spotify. Check your connection.');
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/* ---------- Last.fm scrobbling (desktop auth flow; requests signed here so the secret stays in this process) ---------- */
const LASTFM = path.join(app.getPath('userData'), 'lastfm.bin');
let lfm = null; // { key, secret, sk, user }
try { lfm = JSON.parse(safeStorage.decryptString(fs.readFileSync(LASTFM))); } catch {}
const saveLfm = () => lfm ? fs.writeFileSync(LASTFM, safeStorage.encryptString(JSON.stringify(lfm))) : fs.rmSync(LASTFM, { force: true });

async function lfmCall(method, params = {}, creds = lfm) {
  const p = { ...params, method, api_key: creds.key, ...(creds.sk ? { sk: creds.sk } : {}) };
  // signature: every param except format, sorted by name, name+value concatenated, then the secret; md5 hex
  p.api_sig = crypto.createHash('md5').update(Object.keys(p).sort().map(k => k + p[k]).join('') + creds.secret, 'utf8').digest('hex');
  p.format = 'json';
  const r = await fetch('https://ws.audioscrobbler.com/2.0/', { method: 'POST', body: new URLSearchParams(p) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw Object.assign(new Error(`Last.fm: ${j.message}`), { code: j.error });
  return j;
}

ipcMain.handle('lastfm:status', () => lfm?.sk ? { user: lfm.user } : null);
ipcMain.handle('lastfm:disconnect', () => { lfm = null; saveLfm(); });
ipcMain.handle('lastfm:connect', async (_, key, secret) => {
  key = String(key).trim(); secret = String(secret).trim();
  if (!/^[0-9a-f]{32}$/i.test(key) || !/^[0-9a-f]{32}$/i.test(secret)) throw new Error('Last.fm API key and secret are 32 letters and digits each.');
  const creds = { key, secret };
  const { token } = await lfmCall('auth.getToken', {}, creds);
  shell.openExternal(`https://www.last.fm/api/auth/?api_key=${key}&token=${token}`);
  // the user approves in the browser; poll until Last.fm hands out a session (token is valid for 60 min)
  for (let i = 0; i < 100; i++) {
    await new Promise(ok => setTimeout(ok, 3000));
    try {
      const { session } = await lfmCall('auth.getSession', { token }, creds);
      lfm = { key, secret, sk: session.key, user: session.name }; saveLfm(); win?.focus();
      return { user: session.name };
    } catch (e) { if (e.code !== 14) throw e; } // 14 = not yet authorised
  }
  throw new Error('Last.fm login timed out. Try again.');
});
ipcMain.handle('lastfm:nowPlaying', (_, t) => lfm?.sk && lfmCall('track.updateNowPlaying', t).catch(() => {}));
ipcMain.handle('lastfm:scrobble', (_, t) => lfm?.sk && lfmCall('track.scrobble', t));

/* ---------- open at login ---------- */
// macOS/Windows: the OS login-item API. Linux has none: an XDG autostart entry does the same job.
const AUTOSTART = path.join(app.getPath('home'), '.config', 'autostart', 'pulse.desktop');
ipcMain.handle('login:get', () => MAC || WIN ? app.getLoginItemSettings().openAtLogin : fs.existsSync(AUTOSTART));
ipcMain.handle('login:set', (_, on) => {
  if (MAC || WIN) return app.setLoginItemSettings({ openAtLogin: !!on, args: ['--login'] }); // args: Windows only
  if (!on) return fs.rmSync(AUTOSTART, { force: true });
  fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
  fs.writeFileSync(AUTOSTART, `[Desktop Entry]\nType=Application\nName=Pulse\nExec="${process.execPath}" --login\nX-GNOME-Autostart-enabled=true\n`);
});
ipcMain.handle('login:wasOpenedAtLogin', () => MAC ? !!app.getLoginItemSettings().wasOpenedAtLogin : process.argv.includes('--login'));

ipcMain.handle('configured', () => !!CLIENT_ID);
ipcMain.handle('setClientId', (_, id) => {
  id = String(id).trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error('That does not look like a Spotify Client ID (32 letters and digits).');
  CLIENT_ID = id;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ clientId: id }));
});
ipcMain.handle('login', login);
ipcMain.handle('token', token);
ipcMain.handle('logout', () => { tok = null; fs.rmSync(SESSION, { force: true }); });

// mini player: same window, shrunk and floating; full-size bounds restored on expand
let full = null;
ipcMain.handle('mini', (_, on) => {
  if (on) {
    full = win.getBounds();
    win.setMinimumSize(340, 240);
    win.setBounds({ x: full.x + full.width - 380, y: full.y + 24, width: 360, height: 256 }, true);
    win.setResizable(false);
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    if (MAC) win.setWindowButtonVisibility(false);
  } else {
    win.setResizable(true);
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    if (MAC) win.setWindowButtonVisibility(true);
    win.setMinimumSize(1040, 680);
    if (full) win.setBounds(full, true);
  }
});
ipcMain.handle('pin', (_, on) => win.setAlwaysOnTop(on, 'floating'));

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1040, minHeight: 680,
    backgroundColor: '#0d080d',
    // macOS: inset traffic lights. Windows/Linux: native controls drawn over our own dark top bar.
    ...(MAC ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0d080d', symbolColor: '#e8a8e8', height: 40 }, icon: path.join(__dirname, 'icon.png') }),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  // links open in the real browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (url.startsWith('https://')) shell.openExternal(url); });
}

// window controls follow the cover colour on Windows/Linux
ipcMain.on('chrome', (_, color, symbolColor) => { if (!MAC) win?.setTitleBarOverlay({ color, symbolColor }); });

if (!MAC) Menu.setApplicationMenu(null); // no File/Edit bar under the custom top bar; inputs keep Ctrl+C/V natively
app.whenReady().then(async () => {
  let drmError = null;
  try { await components.whenReady(); } // Widevine CDM must be ready before Spotify can stream
  catch (e) { drmError = `Spotify playback is unavailable: the DRM component failed to load (${e.message || e}). Check your connection and restart Pulse.`; }
  restore();
  createWindow();
  if (drmError) win.webContents.once('did-finish-load', () => win.webContents.executeJavaScript(`toast(${JSON.stringify(drmError)})`));
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

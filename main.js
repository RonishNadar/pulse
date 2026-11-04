const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('./library.js');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const DATA = app.getPath('userData');

let win;
const send = (channel, payload) => win?.webContents.send(channel, payload);

/* ---------- music library ---------- */
const library = new Library(DATA, send);
ipcMain.handle('library:get', () => library.snapshot());
ipcMain.handle('library:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a music folder', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return library.snapshot();
  for (const dir of r.filePaths) await library.addFolder(dir);
  return library.snapshot();
});
ipcMain.handle('library:removeFolder', (_, dir) => library.removeFolder(dir));
ipcMain.handle('library:rescan', () => library.scan());
ipcMain.handle('library:writeTags', (_, ids, patch, cover) => library.writeTags(ids, patch, cover));
ipcMain.handle('library:lyrics', (_, id) => library.sidecarLyrics(id));
ipcMain.handle('library:reveal', (_, id) => { const t = library.data.tracks[id]; if (t) shell.showItemInFolder(t.path); });

/* ---------- your data: likes, playlists, play history (one JSON file, written atomically) ---------- */
const STORE = path.join(DATA, 'pulse-data.json');
let store = { likes: {}, playlists: [], plays: [] };
try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE, 'utf8')) }; } catch {}
let storeTimer;
const flushStore = () => { clearTimeout(storeTimer); const tmp = STORE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, STORE); };
ipcMain.handle('store:get', () => store);
ipcMain.handle('store:set', (_, key, value) => { store[key] = value; clearTimeout(storeTimer); storeTimer = setTimeout(flushStore, 500); });
app.on('before-quit', flushStore);

// playlist covers you upload: copied into userData so they survive the original file moving
const COVERS = path.join(DATA, 'covers');
ipcMain.handle('cover:save', (_, bytes, ext) => {
  fs.mkdirSync(COVERS, { recursive: true });
  const name = crypto.randomBytes(8).toString('hex') + (ext === 'png' ? '.png' : '.jpg');
  fs.writeFileSync(path.join(COVERS, name), Buffer.from(bytes));
  return require('node:url').pathToFileURL(path.join(COVERS, name)).href;
});

/* ---------- Last.fm scrobbling (desktop auth flow; requests signed here so the secret stays in this process) ---------- */
const LASTFM = path.join(DATA, 'lastfm.bin');
let lfm = null; // { key, secret, sk, user }; only read when it exists, so the keychain is touched only by scrobblers
try { if (fs.existsSync(LASTFM)) lfm = JSON.parse(safeStorage.decryptString(fs.readFileSync(LASTFM))); } catch {}
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

/* ---------- mini player: same window, shrunk and floating; full-size bounds restored on expand ---------- */
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

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1040, minHeight: 680,
    backgroundColor: '#0d080d',
    // macOS: inset traffic lights. Windows/Linux: native controls drawn over our own dark top bar.
    ...(MAC ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0d080d', symbolColor: '#e8a8e8', height: 40 }, icon: path.join(__dirname, 'icon.png') }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }, // keep crossfades smooth when hidden
  });
  win.loadFile('index.html');
  // links open in the real browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (url.startsWith('https://')) shell.openExternal(url); });
}

// window controls follow the cover colour on Windows/Linux
ipcMain.on('chrome', (_, color, symbolColor) => { if (!MAC) win?.setTitleBarOverlay({ color, symbolColor }); });

if (!MAC) Menu.setApplicationMenu(null); // no File/Edit bar under the custom top bar; inputs keep Ctrl+C/V natively
app.whenReady().then(() => {
  createWindow();
  if (library.data.folders.length) library.scan(); // catch up on changes made while Pulse was closed
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

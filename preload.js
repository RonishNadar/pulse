const { contextBridge, ipcRenderer } = require('electron');

// a listener helper: returns nothing to the page that could reach ipcRenderer itself
const on = channel => fn => { ipcRenderer.on(channel, (_, payload) => fn(payload)); };

contextBridge.exposeInMainWorld('pulse', {
  platform: process.platform,
  library: {
    get: () => ipcRenderer.invoke('library:get'),
    addFolder: () => ipcRenderer.invoke('library:addFolder'),
    removeFolder: dir => ipcRenderer.invoke('library:removeFolder', dir),
    rescan: () => ipcRenderer.invoke('library:rescan'),
    writeTags: (ids, patch, cover) => ipcRenderer.invoke('library:writeTags', ids, patch, cover),
    lyrics: id => ipcRenderer.invoke('library:lyrics', id),
    reveal: id => ipcRenderer.invoke('library:reveal', id),
    onChanged: on('library:changed'),
    onProgress: on('library:progress'),
  },
  store: {
    get: () => ipcRenderer.invoke('store:get'),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  },
  saveCover: (bytes, ext) => ipcRenderer.invoke('cover:save', bytes, ext),
  mini: on => ipcRenderer.invoke('mini', on),
  pin: on => ipcRenderer.invoke('pin', on),
  chrome: (color, symbolColor) => ipcRenderer.send('chrome', color, symbolColor),
  lastfm: {
    status: () => ipcRenderer.invoke('lastfm:status'),
    connect: (key, secret) => ipcRenderer.invoke('lastfm:connect', key, secret),
    disconnect: () => ipcRenderer.invoke('lastfm:disconnect'),
    nowPlaying: t => ipcRenderer.invoke('lastfm:nowPlaying', t),
    scrobble: t => ipcRenderer.invoke('lastfm:scrobble', t),
  },
  loginItem: {
    get: () => ipcRenderer.invoke('login:get'),
    set: on => ipcRenderer.invoke('login:set', on),
    wasOpenedAtLogin: () => ipcRenderer.invoke('login:wasOpenedAtLogin'),
  },
});

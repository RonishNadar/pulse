const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  platform: process.platform,
  chrome: (color, symbolColor) => ipcRenderer.send('chrome', color, symbolColor),
  configured: () => ipcRenderer.invoke('configured'),
  setClientId: id => ipcRenderer.invoke('setClientId', id),
  login: () => ipcRenderer.invoke('login'),
  token: () => ipcRenderer.invoke('token'),
  logout: () => ipcRenderer.invoke('logout'),
  mini: on => ipcRenderer.invoke('mini', on),
  pin: on => ipcRenderer.invoke('pin', on),
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

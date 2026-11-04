# Pulse

A dithered desktop music player for Spotify. Electron (castLabs build, for Spotify's DRM), plain HTML/CSS/JS, no framework.

Pulse is an independent project and is not affiliated with or endorsed by Spotify.

## Features

- Home, search, library, history, stats, album / artist / playlist / podcast pages
- Playback inside the app (Spotify Premium), plus Spotify Connect control of your other devices
- Likes, follows, saves; create, edit and reorder playlists; drag songs onto playlists
- Time-synced lyrics from [LRCLIB](https://lrclib.net)
- Command palette (⌘K), mini player (⇧⌘M), media keys
- Dither styles: classic grid, noise, halftone, 1-bit, fixed or cover-matched colour
- Last.fm scrobbling, open at login, remembers your last song and volume

## Requirements

- macOS 13+ (Windows and Linux builds planned)
- Node.js and npm
- Spotify Premium
- A Spotify app of your own: create one at <https://developer.spotify.com/dashboard>, tick **Web API** and **Web Playback SDK**, and add the redirect URI `http://127.0.0.1:8888/callback`. Pulse asks for its Client ID on first launch.

## Build

```sh
./build.sh --setup-signing   # once per Mac: stable local code signature (stops repeated keychain prompts)
./build.sh --install         # builds dist/Pulse.app + dist/Pulse.dmg and copies the app to /Applications
```

Spotify only streams to apps signed with castLabs' free VMP service. Install it once:

```sh
python3 -m pip install --user castlabs-evs
python3 -m castlabs_evs.account signup
```

`build.sh` signs automatically when it's available.

## Spotify API limits

Apps in Spotify's development mode can't use recommendations, Spotify-made playlists, artist top tracks, new releases, lyrics, downloads, crossfade or queue reordering, and most list endpoints return at most 10 items per request (February 2026 changes). Pulse works around these where it can.

## Project layout

| File | What it does |
|---|---|
| `main.js` | Electron main process: window, Spotify login (PKCE), Last.fm signing, mini player, login item |
| `preload.js` | The small API the page may call |
| `index.html`, `style.css` | Layout and styling |
| `dither.js` | Dithering engine: background, cover dissolve, patterns |
| `app.js` | Spotify API, playback, views, library actions |
| `extras.js` | Command palette, lyrics, stats, playlist editing, scrobbling, settings |
| `build.sh` | Builds, signs and packages the macOS app |

## License

[MIT](LICENSE) © 2026 Ronish Nadar

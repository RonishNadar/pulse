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

- macOS 13+, Windows 10/11 (x64), or Linux (x64 / arm64, glibc desktop)
- Node.js and npm
- Spotify Premium
- A Spotify app: create one at <https://developer.spotify.com/dashboard>, tick **Web API** and **Web Playback SDK**, and add the redirect URI `http://127.0.0.1:8888/callback`.

### Build types

| Type | How | Who can use it |
|---|---|---|
| **Friends build** | `./build.sh --client-id <ID>`, or put the ID in `spotify_client_id.txt` (git-ignored) | You plus up to 4 people you add under **User Management** in your Spotify dashboard. They just click Connect. |
| **Public build** | `./build.sh --public` | Anyone, but each person creates their own free Spotify app and pastes its Client ID on first launch. |

Spotify limits apps in development mode to 5 users, and lifting that needs Spotify's approval for large businesses, so a single Client ID can't serve everyone. Any build also lets a person switch to their own Spotify app (login screen or Settings → Account).

## Build

```sh
./build.sh --setup-signing   # once per Mac: stable local code signature (stops repeated keychain prompts)
./build.sh --install         # macOS: dist/Pulse.app + dist/Pulse.dmg, copied to /Applications
./build.sh --windows         # Windows: dist/Pulse-win-x64.zip (portable: unzip, run Pulse.exe)
./build.sh --linux           # Linux: dist/Pulse-linux-x64.tar.gz + -arm64 (run ./install.sh inside)
```

Windows and Linux packages build from any OS (macOS included): the script downloads castLabs' runtime for that platform and checks it against their published checksums.

Spotify only streams to apps signed with castLabs' free VMP service. Install it once:

```sh
python3 -m pip install --user castlabs-evs
python3 -m castlabs_evs.account signup
```

`build.sh` signs macOS and Windows builds automatically when it's available. Linux has no VMP, so Linux builds need no signing.

## iPhone

Spotify only streams to its own app on iOS (its web player doesn't support phones, and iOS has no Widevine), so Pulse for iPhone is a remote: you browse and pick in Pulse, and the Spotify app plays in the background. The Spotify app must be installed.

```sh
brew install xcodegen
cd ios && xcodegen && open Pulse.xcodeproj   # then pick your team under Signing & Capabilities and Run
```

In your Spotify dashboard, also add the redirect URI `pulse://callback` and, under iOS, the bundle ID `com.ronishnadar.pulse`. A free Apple ID installs to your own phone for 7 days at a time; the Apple Developer Program makes it a year and enables TestFlight.

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
| `build.sh` | Builds, signs and packages for macOS, Windows and Linux |

## License

[MIT](LICENSE) © 2026 Ronish Nadar

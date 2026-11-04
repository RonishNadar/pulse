# Pulse

A dithered music player for the music files on your computer. Electron, plain HTML/CSS/JS, no framework.

## Features

- Library from the folders you choose: albums, artists, songs, genres and a folder view. New and changed files are picked up automatically.
- Crossfade (off to 12 s) and gapless playback: songs from the same album always flow straight into each other.
- Up Next queue: play next, add to queue, drag to reorder, shuffle and repeat.
- Tag editor: fix a song's or a whole album's title, artist, album, track numbers, year, genre and album art. Changes are written into the files.
- Playlists (with your own or dithered covers), Liked Songs, play history and listening stats, all kept on your computer.
- Time-synced lyrics from a `.lrc` file next to the song, or from [LRCLIB](https://lrclib.net).
- Command palette (⌘K), mini player (⇧⌘M), media keys, Last.fm scrobbling, open at login.
- Dither styles: classic grid, noise, halftone, 1-bit, dithered album art, cover-matched or fixed colour. Albums without art get a generated dithered cover.

Plays MP3, AAC/M4A, FLAC, OGG Vorbis, Opus and WAV. ALAC and AIFF are listed but can't be played (Chromium has no decoder for them).

## Build

```sh
npm install
./build.sh --setup-signing   # once per Mac: stable local code signature
./build.sh --install         # macOS: dist/Pulse.app + dist/Pulse.dmg, copied to /Applications
./build.sh --windows         # Windows: dist/Pulse-win-x64.zip (portable: unzip, run Pulse.exe)
./build.sh --linux           # Linux: dist/Pulse-linux-x64.tar.gz + -arm64 (run ./install.sh inside)
```

Windows and Linux packages build from any OS: the script downloads Electron's runtime for that platform and checks it against the published checksums.

## Where things live

Your music is never moved or copied. Pulse keeps its index, cover-art cache, playlists, likes and play history in the app's data folder (`~/Library/Application Support/Pulse` on macOS).

| File | What it does |
|---|---|
| `main.js` | Electron main process: window, data store, Last.fm signing, mini player, login item |
| `library.js` | Folder scanning, tag reading/writing ([taglib-wasm](https://github.com/CharlesWiltgen/taglib-wasm)), art cache, folder watching |
| `preload.js` | The small API the page may call |
| `index.html`, `style.css` | Layout and styling |
| `dither.js` | Dithering engine: background, cover dissolve, patterns |
| `app.js` | Library index, playback engine (crossfade/gapless), queue, views |
| `extras.js` | Command palette, lyrics, stats, playlist and tag editing, scrobbling, settings |
| `build.sh` | Builds, signs and packages for macOS, Windows and Linux |

## License

[MIT](LICENSE) © 2026 Ronish Nadar

// Music library (main process): scans folders, reads tags with taglib-wasm, caches the index and
// cover art in userData, watches folders for changes, and writes tag edits back to files.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// what Chromium's <audio> can play (ALAC and AIFF can't, see `playable`)
const EXTS = new Set(['.mp3', '.m4a', '.aac', '.mp4', '.flac', '.ogg', '.oga', '.opus', '.wav']);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'artwork'];
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

class Library {
  constructor(dir, emit) {
    this.dir = dir;
    this.emit = emit; // (channel, payload) -> renderer
    this.file = path.join(dir, 'library.json');
    this.artDir = path.join(dir, 'art');
    fs.mkdirSync(this.artDir, { recursive: true });
    this.data = { version: 1, folders: [], tracks: {} };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch {}
    this.watchers = new Map();
    this.scanning = null;
    this.rescanTimer = null;
    this.taglib = import('taglib-wasm/simple'); // ESM; loads WASM once
    for (const f of this.data.folders) this.watch(f);
  }

  // what the renderer sees: tracks with file:// URLs for audio and art
  snapshot() {
    const tracks = Object.values(this.data.tracks).map(t => ({
      ...t,
      url: pathToFileURL(t.path).href,
      artUrl: t.art ? pathToFileURL(path.join(this.artDir, t.art)).href : null,
    }));
    return { folders: this.data.folders, tracks, scanning: !!this.scanning };
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  async addFolder(dir) {
    dir = path.resolve(dir);
    // nested folders would be scanned twice: keep only the outermost
    if (this.data.folders.some(f => dir === f || dir.startsWith(f + path.sep))) return this.snapshot();
    this.data.folders = this.data.folders.filter(f => !f.startsWith(dir + path.sep)).concat(dir);
    this.watch(dir);
    this.save();
    return this.scan();
  }

  removeFolder(dir) {
    this.data.folders = this.data.folders.filter(f => f !== dir);
    this.watchers.get(dir)?.close(); this.watchers.delete(dir);
    for (const [id, t] of Object.entries(this.data.tracks)) if (t.path.startsWith(dir + path.sep)) delete this.data.tracks[id];
    this.save();
    this.emit('library:changed', this.snapshot());
    return this.snapshot();
  }

  watch(dir) {
    if (this.watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true }, (_, name) => {
        if (name && !EXTS.has(path.extname(name).toLowerCase()) && path.extname(name)) return; // ignore non-audio files
        clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => this.scan(), 2500); // settle: a copy fires many events
      });
      w.on('error', () => { this.watchers.delete(dir); });
      this.watchers.set(dir, w);
    } catch { /* folder gone or unwatchable: manual rescan still works */ }
  }

  // one scan at a time; a request during a scan runs once more afterwards
  scan() {
    if (this.scanning) { this.again = true; return this.scanning; }
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
      if (this.again) { this.again = false; this.scan(); }
    });
    return this.scanning;
  }

  async doScan() {
    const found = [];
    const walk = async d => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) found.push(p);
      }
    };
    for (const f of this.data.folders) await walk(f);

    // reuse cached entries whose file hasn't changed; read only new/changed files
    const byPath = new Map(Object.values(this.data.tracks).map(t => [t.path, t]));
    const todo = [], keep = {};
    for (const p of found) {
      let st; try { st = await fsp.stat(p); } catch { continue; }
      const old = byPath.get(p);
      if (old && old.mtime === st.mtimeMs && old.size === st.size) keep[old.id] = old;
      else todo.push({ p, st });
    }
    this.emit('library:progress', { done: 0, total: todo.length });
    const { readMetadataBatch } = await this.taglib;
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      const res = await readMetadataBatch(chunk.map(c => c.p), { concurrency: 8 }).catch(() => ({ items: [] }));
      const byP = new Map(res.items.map(it => [it.path, it]));
      for (const { p, st } of chunk) {
        const t = await this.toTrack(p, st, byP.get(p));
        keep[t.id] = t;
      }
      this.emit('library:progress', { done: Math.min(i + 100, todo.length), total: todo.length });
    }
    const changed = todo.length || Object.keys(keep).length !== Object.keys(this.data.tracks).length;
    this.data.tracks = keep;
    if (changed) { this.save(); this.emit('library:changed', this.snapshot()); }
    this.emit('library:progress', null);
    return this.snapshot();
  }

  async toTrack(p, st, item) {
    const ok = item?.status === 'ok' ? item.data : null;
    const tags = ok?.tags || {}, props = ok?.properties || {};
    const first = v => (Array.isArray(v) ? v[0] : v) || '';
    const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
    const dir = path.dirname(p);
    const artists = list(tags.artist);
    const t = {
      id: sha(p), path: p, mtime: st.mtimeMs, size: st.size, added: st.birthtimeMs || st.mtimeMs,
      title: first(tags.title) || path.basename(p, path.extname(p)),
      artist: artists.join(', ') || 'Unknown Artist',
      artists: artists.length ? artists : ['Unknown Artist'],
      album: first(tags.album) || path.basename(dir),
      albumArtist: first(tags.albumArtist) || artists[0] || 'Unknown Artist',
      track: +tags.track || +String(tags.trackNumber || '').split('/')[0] || 0,
      disc: +tags.discNumber || +tags.disc || 0,
      year: +tags.year || +String(first(tags.date)).slice(0, 4) || 0,
      genre: first(tags.genre),
      duration: props.durationMs ? props.durationMs / 1000 : props.duration || 0,
      codec: props.codec || path.extname(p).slice(1).toUpperCase(),
      lossless: !!props.isLossless, bitrate: props.bitrate || 0, sampleRate: props.sampleRate || 0,
      // Chromium can't decode ALAC (it lives in .m4a too)
      playable: !/alac/i.test(props.codec || ''),
      art: null,
    };
    const pic = (tags.pictures || []).find(x => x.type === 'FrontCover') || tags.pictures?.[0];
    if (pic?.data?.length) t.art = await this.storeArt(Buffer.from(pic.data), pic.mimeType);
    else t.art = await this.folderArt(dir);
    return t;
  }

  async storeArt(buf, mime) {
    const name = sha(buf) + (/png/.test(mime || '') ? '.png' : '.jpg');
    const out = path.join(this.artDir, name);
    if (!fs.existsSync(out)) await fsp.writeFile(out, buf);
    return name;
  }

  async folderArt(dir) {
    let names; try { names = await fsp.readdir(dir); } catch { return null; }
    const hit = names.find(n => COVER_NAMES.includes(path.parse(n).name.toLowerCase()) && /\.(jpe?g|png)$/i.test(n));
    if (!hit) return null;
    try { return await this.storeArt(await fsp.readFile(path.join(dir, hit)), hit); } catch { return null; }
  }

  // tag edits: patch = { title, artist, album, albumArtist, track, disc, year, genre }; cover = { data, mime }
  async writeTags(ids, patch, cover) {
    const { applyTagsToFile, applyCoverArt } = await this.taglib;
    const tags = {};
    for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre']) if (patch[k] != null) tags[k] = String(patch[k]);
    for (const k of ['track', 'disc', 'year']) if (patch[k] != null && patch[k] !== '') tags[k] = +patch[k] || 0;
    if (tags.disc != null) { tags.discNumber = tags.disc; delete tags.disc; }
    const failed = [];
    for (const id of ids) {
      const t = this.data.tracks[id];
      if (!t) continue;
      try {
        if (Object.keys(tags).length) await applyTagsToFile(t.path, tags);
        if (cover) { // applyCoverArt returns the new file bytes: write them atomically
          const bytes = await applyCoverArt(t.path, new Uint8Array(cover.data), cover.mime);
          const tmp = t.path + '.pulse-tmp';
          await fsp.writeFile(tmp, bytes);
          await fsp.rename(tmp, t.path);
        }
      } catch (e) { failed.push(`${path.basename(t.path)}: ${e.message}`); }
    }
    await this.scan(); // picks up the changed files (mtime moved)
    if (failed.length) throw new Error(`Couldn’t update ${failed.length} file(s). ${failed[0]}`);
    return this.snapshot();
  }

  // lyrics next to the song: Song.lrc (synced) or Song.txt
  async sidecarLyrics(id) {
    const t = this.data.tracks[id];
    if (!t) return null;
    const base = t.path.slice(0, -path.extname(t.path).length);
    for (const [ext, synced] of [['.lrc', true], ['.txt', false]]) {
      try { return { text: await fsp.readFile(base + ext, 'utf8'), synced }; } catch {}
    }
    return null;
  }
}

module.exports = { Library };

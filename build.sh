#!/usr/bin/env bash
# Builds Pulse, the same app on every OS:
#   macOS:   dist/Pulse.app + dist/Pulse.dmg                       (default; needs a Mac)
#   Windows: dist/Pulse-win-x64.zip  (portable: unzip, run Pulse.exe)  (--windows)
#   Linux:   dist/Pulse-linux-<arch>.tar.gz (+ install.sh inside)       (--linux; x64 + arm64)
#
#   ./build.sh                   # macOS
#   ./build.sh --install         # macOS, then copy to /Applications
#   ./build.sh --setup-signing   # once per Mac: a fixed local signing certificate,
#                                # so macOS stops asking for your password after rebuilds
#   ./build.sh --windows         # from any OS with curl/unzip/zip
#   ./build.sh --linux           # from any OS with curl/unzip/tar
#   ./build.sh --linux --arch x64
#
# Build type (any platform):
#   friends build: your Spotify Client ID is built in; you + up to 4 invited people just click Connect
#                  (Spotify caps development-mode apps at 5 users; add them in your dashboard's User Management)
#   public build:  nothing built in; each person enters their own Client ID on first launch
#   --client-id <ID>   friends build with this ID
#   --public           public build
#   (neither)          friends build if spotify_client_id.txt exists here, else public
#
# Needs: Node/npm (the castLabs Electron, which carries the Widevine DRM Spotify needs).
# Windows/Linux runtimes are downloaded from castLabs' releases (checksum-checked, cached in .cache/).
# castLabs EVS (pip install castlabs-evs, sign up once) VMP-signs macOS and Windows builds;
# Spotify won't stream from an unsigned one. Linux has no VMP, so nothing to sign there.
set -euo pipefail
cd "$(dirname "$0")"
die() { echo "ERROR: $*" >&2; exit 1; }

INSTALL=false; SETUP=false; TARGET=mac; ARCHES=""; CLIENT_ID=""; PUBLIC=false
SIGN_ID="Pulse Local Signing"
while [ $# -gt 0 ]; do
    case "$1" in
        --install) INSTALL=true ;;
        --setup-signing) SETUP=true ;;
        --windows) TARGET=win ;;
        --linux) TARGET=linux ;;
        --arch) ARCHES="$2"; shift ;;
        --client-id) CLIENT_ID="$2"; shift ;;
        --public) PUBLIC=true ;;
        *) die "unknown option $1 (see the top of build.sh)" ;;
    esac
    shift
done

TITLE="Pulse"; ID="com.ronishnadar.pulse"
FILES="package.json main.js preload.js index.html style.css dither.js app.js extras.js"
command -v npm >/dev/null || die "no npm: https://nodejs.org"
[ -d node_modules/electron ] || npm install --silent
VERSION="$(node -p 'require("./package.json").version')"
EVER="$(node -p 'require("./node_modules/electron/package.json").version')"   # e.g. 44.10.1+wvcus
BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
mkdir -p dist .cache

# build type: a built-in Client ID goes into the app as build.json (not a secret: PKCE, no client secret)
if $PUBLIC; then CLIENT_ID=""
elif [ -z "$CLIENT_ID" ] && [ -s spotify_client_id.txt ]; then CLIENT_ID="$(tr -d ' \t\r\n' < spotify_client_id.txt)"; fi
[ -z "$CLIENT_ID" ] || [[ "$CLIENT_ID" =~ ^[0-9a-fA-F]{32}$ ]] || die "Client ID must be 32 hex characters"
if [ -n "$CLIENT_ID" ]; then
    printf '{"clientId":"%s"}\n' "$CLIENT_ID" > "$BUILD/build.json"; KIND="friends build, Client ID ••••${CLIENT_ID: -4}"
else
    printf '{}\n' > "$BUILD/build.json"; KIND="public build, no built-in Client ID"
fi
echo "Build type: $KIND"

vmp_sign() {   # $1 = folder holding the .app / .exe
    if python3 -c 'import castlabs_evs' 2>/dev/null; then
        python3 -m castlabs_evs.vmp sign-pkg "$1" || die "VMP signing failed (python3 -m castlabs_evs.account reauth?)"
    else
        echo "note: castlabs-evs not installed, skipping VMP signing: Spotify won't stream from this build" >&2
    fi
}

# ── Windows / Linux: castLabs runtime + our files, packaged as an archive ──
if [ "$TARGET" != mac ]; then
    [ -n "$ARCHES" ] || { [ "$TARGET" = win ] && ARCHES=x64 || ARCHES="x64 arm64"; }
    for a in $ARCHES; do
        case "$a" in x64|arm64) ;; *) die "--arch must be x64 or arm64" ;; esac
        plat=$([ "$TARGET" = win ] && echo win32 || echo linux)
        zipname="electron-v$EVER-$plat-$a.zip"
        base="https://github.com/castlabs/electron-releases/releases/download/v$EVER"
        if [ ! -s ".cache/$zipname" ]; then
            [ -s ".cache/SHASUMS256-$EVER.txt" ] || curl -fsSL -o ".cache/SHASUMS256-$EVER.txt" "$base/SHASUMS256.txt" || die "can't fetch castLabs checksums"
            curl -fL --progress-bar -o ".cache/$zipname.part" "$base/$zipname" || die "download failed: $base/$zipname"
            want="$(grep -F "$zipname" ".cache/SHASUMS256-$EVER.txt" | grep -v symbols | awk '{print $1}' | head -1)"
            got="$( (sha256sum ".cache/$zipname.part" 2>/dev/null || shasum -a 256 ".cache/$zipname.part") | awk '{print $1}')"
            [ -n "$want" ] && [ "$want" = "$got" ] || { rm -f ".cache/$zipname.part"; die "checksum mismatch for $zipname"; }
            mv ".cache/$zipname.part" ".cache/$zipname"
        fi

        name="$TITLE-$TARGET-$a"; OUT="$BUILD/$name"
        rm -rf "$OUT"; mkdir -p "$OUT"
        unzip -q ".cache/$zipname" -d "$OUT"
        rm -f "$OUT/resources/default_app.asar"
        mkdir -p "$OUT/resources/app"
        cp $FILES "$OUT/resources/app/"
        cp assets/icon.png "$OUT/resources/app/icon.png"   # window/taskbar icon
        cp "$BUILD/build.json" "$OUT/resources/app/"

        if [ "$TARGET" = win ]; then
            mv "$OUT/electron.exe" "$OUT/$TITLE.exe"
            vmp_sign "$OUT"
            cat > "$OUT/Read Me First.txt" <<README
$TITLE: a dithered Spotify player (Windows)

Run: open "$TITLE.exe". Keep it in this folder with the other files.

First launch: the app isn't from the Microsoft Store, so Windows SmartScreen may warn.
  Click "More info", then "Run anyway". It only asks once.

Needs: Spotify Premium, and a Spotify Client ID (the app explains how on first launch).
README
            rm -f "dist/$name.zip"
            (cd "$BUILD" && zip -qry -9 "$OLDPWD/dist/$name.zip" "$name")
            echo "Built: dist/$name.zip ($(du -h "dist/$name.zip" | cut -f1))"
        else
            mv "$OUT/electron" "$OUT/pulse"
            cp assets/icon.png "$OUT/pulse.png"
            cat > "$OUT/install.sh" <<'INSTALL'
#!/bin/sh
# Installs Pulse for this user: ~/.local/share/pulse plus an app-menu entry. Run it from this folder.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/pulse"
rm -rf "$DEST"; mkdir -p "$DEST"; cp -R "$HERE/." "$DEST/"
# Electron sandboxes itself with user namespaces. Where the system forbids that (e.g. Ubuntu 24.04+),
# its helper must be root-owned and setuid instead; that one step needs your password.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] || \
   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then
    echo "Setting up Electron's sandbox helper (sudo):"
    sudo chown root:root "$DEST/chrome-sandbox" && sudo chmod 4755 "$DEST/chrome-sandbox"
fi
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
cp "$DEST/pulse.png" "$HOME/.local/share/icons/hicolor/512x512/apps/pulse.png"
cat > "$HOME/.local/share/applications/pulse.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pulse
Comment=Dithered Spotify player
Exec="$DEST/pulse" %U
Icon=pulse
Terminal=false
Categories=AudioVideo;Audio;Player;
StartupWMClass=Pulse
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Installed. Open Pulse from your app menu, or run: $DEST/pulse"
INSTALL
            chmod +x "$OUT/install.sh" "$OUT/pulse"
            cat > "$OUT/README.txt" <<README
$TITLE: a dithered Spotify player (Linux)

Install: ./install.sh   (puts it in ~/.local/share/pulse and adds it to your app menu)
Or run it in place: ./pulse

Needs: Spotify Premium, and a Spotify Client ID (the app explains how on first launch).
Saved logins use your desktop keyring (GNOME Keyring / KWallet) when one is running.
README
            rm -f "dist/$name.tar.gz"
            # macOS's bsdtar would embed Mac-only metadata (xattrs) that GNU tar on Linux warns about
            if tar --version | grep -q bsdtar; then XT="--no-xattrs --no-mac-metadata"; else XT=""; fi
            COPYFILE_DISABLE=1 tar $XT -C "$BUILD" -czf "dist/$name.tar.gz" "$name"
            echo "Built: dist/$name.tar.gz ($(du -h "dist/$name.tar.gz" | cut -f1))"
        fi
    done
    exit 0
fi

# ── macOS ──
[ "$(uname)" = Darwin ] || die "the macOS app needs a Mac (use --windows or --linux here)"

# The keychain remembers "Always Allow" per signing identity. Ad-hoc signatures change
# every build, so macOS asks for the password again; a fixed self-signed cert doesn't.
if $SETUP; then
    security find-certificate -c "$SIGN_ID" >/dev/null 2>&1 && { echo "\"$SIGN_ID\" already exists"; exit 0; }
    T="$BUILD/cert"; mkdir -p "$T"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$SIGN_ID" \
        -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
        -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null || die "openssl failed"
    openssl pkcs12 -export -name "$SIGN_ID" -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/id.p12" -passout pass:pulse
    security import "$T/id.p12" -k ~/Library/Keychains/login.keychain-db -P pulse -T /usr/bin/codesign >/dev/null
    echo "macOS now asks once to trust it for code signing (your password)."
    security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$T/cert.pem"
    echo "Done: \"$SIGN_ID\" is in your login keychain (only usable for signing). Now run ./build.sh --install"
    exit 0
fi

SRC="node_modules/electron/dist/Electron.app"
[ -d "$SRC" ] || die "no $SRC: npm install failed?"

# .app: the Electron runtime with our files in Resources/app
APP="dist/$TITLE.app"; C="$APP/Contents"
rm -rf "$APP"
ditto "$SRC" "$APP"
rm -f "$C/Resources/default_app.asar"
mkdir -p "$C/Resources/app"
cp $FILES "$BUILD/build.json" "$C/Resources/app/"
cp assets/AppIcon.icns "$C/Resources/electron.icns"
P="$C/Info.plist"
plutil -replace CFBundleName -string "$TITLE" "$P"
plutil -replace CFBundleDisplayName -string "$TITLE" "$P"
plutil -replace CFBundleIdentifier -string "$ID" "$P"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$P"
plutil -replace CFBundleVersion -string "$(date +%Y%m%d%H%M)" "$P"

vmp_sign dist
if security find-identity -v -p codesigning | grep -q "$SIGN_ID"; then
    codesign --force --deep -s "$SIGN_ID" "$APP"
else
    echo "note: no \"$SIGN_ID\" certificate (./build.sh --setup-signing), signing ad-hoc: macOS will ask for your password after each rebuild" >&2
    codesign --force --deep -s - "$APP"   # ad-hoc: Apple Silicon runs only signed code
fi

# disk image to share: the app, an Applications shortcut, a note for Gatekeeper
STAGE="$BUILD/dmg"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$TITLE.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read Me First.txt" <<README
$TITLE: a dithered Spotify player

Install: drag "$TITLE" onto "Applications".

First launch: the app isn't from the App Store, so macOS asks once.
  Open it from Applications; if macOS says it can't be opened, click Done.
  Then System Settings > Privacy & Security > "Open Anyway".
  Or in Terminal: xattr -dr com.apple.quarantine "/Applications/$TITLE.app"

Needs: Spotify Premium, and a Spotify Client ID (the app explains how on first launch).
README
rm -f "dist/$TITLE.dmg"
hdiutil create -quiet -volname "$TITLE" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "dist/$TITLE.dmg"
echo "Built: $APP, dist/$TITLE.dmg ($(du -h "dist/$TITLE.dmg" | cut -f1))"

if $INSTALL; then
    rm -rf "/Applications/$TITLE.app"
    ditto "$APP" "/Applications/$TITLE.app"
    echo "Installed: /Applications/$TITLE.app"
fi

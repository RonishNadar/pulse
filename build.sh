#!/usr/bin/env bash
# Builds Pulse:
#   macOS: dist/Pulse.app + dist/Pulse.dmg
#
#   ./build.sh              # build
#   ./build.sh --install    # build, then copy to /Applications
#   ./build.sh --setup-signing   # once per Mac: a fixed local signing certificate,
#                                # so macOS stops asking for your password after rebuilds
#
# Needs: Node/npm (installs the castLabs Electron, which carries the Widevine
# DRM Spotify needs). Windows/Linux builds come later from the same code.
# Optional: castLabs EVS (pip install castlabs-evs, then sign up once) for
# VMP signing; if Spotify refuses to stream from the unsigned app, that's why.
set -euo pipefail
cd "$(dirname "$0")"
die() { echo "ERROR: $*" >&2; exit 1; }

INSTALL=false; SETUP=false
SIGN_ID="Pulse Local Signing"
while [ $# -gt 0 ]; do
    case "$1" in
        --install) INSTALL=true ;;
        --setup-signing) SETUP=true ;;
        *) die "unknown option $1 (see the top of build.sh)" ;;
    esac
    shift
done
[ "$(uname)" = Darwin ] || die "this builds the macOS app; run it on a Mac"

# The keychain remembers "Always Allow" per signing identity. Ad-hoc signatures change
# every build, so macOS asks for the password again; a fixed self-signed cert doesn't.
if $SETUP; then
    security find-certificate -c "$SIGN_ID" >/dev/null 2>&1 && { echo "\"$SIGN_ID\" already exists"; exit 0; }
    T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
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
command -v npm >/dev/null || die "no npm: https://nodejs.org"
[ -d node_modules/electron/dist ] || npm install --silent

TITLE="Pulse"; ID="com.ronishnadar.pulse"
VERSION="$(node -p 'require("./package.json").version')"
SRC="node_modules/electron/dist/Electron.app"
[ -d "$SRC" ] || die "no $SRC: npm install failed?"
BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
mkdir -p dist

# ── .app: the Electron runtime with our files in Resources/app ──
APP="dist/$TITLE.app"; C="$APP/Contents"
rm -rf "$APP"
ditto "$SRC" "$APP"
rm -f "$C/Resources/default_app.asar"
mkdir -p "$C/Resources/app"
cp package.json main.js preload.js index.html style.css dither.js app.js extras.js "$C/Resources/app/"
cp assets/AppIcon.icns "$C/Resources/electron.icns"
P="$C/Info.plist"
plutil -replace CFBundleName -string "$TITLE" "$P"
plutil -replace CFBundleDisplayName -string "$TITLE" "$P"
plutil -replace CFBundleIdentifier -string "$ID" "$P"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$P"
plutil -replace CFBundleVersion -string "$(date +%Y%m%d%H%M)" "$P"

if python3 -c 'import castlabs_evs' 2>/dev/null; then
    python3 -m castlabs_evs.vmp sign-pkg dist || die "VMP signing failed (castlabs_evs.account reauth?)"
else
    echo "note: castlabs-evs not installed, skipping VMP signing" >&2
fi
if security find-identity -v -p codesigning | grep -q "$SIGN_ID"; then
    codesign --force --deep -s "$SIGN_ID" "$APP"
else
    echo "note: no \"$SIGN_ID\" certificate (./build.sh --setup-signing), signing ad-hoc: macOS will ask for your password after each rebuild" >&2
    codesign --force --deep -s - "$APP"   # ad-hoc: Apple Silicon runs only signed code
fi

# ── disk image to share: the app, an Applications shortcut, a note for Gatekeeper ──
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

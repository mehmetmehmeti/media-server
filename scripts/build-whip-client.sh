#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$ROOT_DIR/.tools"
SRC_DIR="$TOOLS_DIR/simple-whip-client"
BIN_DIR="$TOOLS_DIR/bin"

mkdir -p "$TOOLS_DIR" "$BIN_DIR"

missing=()
for pkg in \
  gstreamer-webrtc-1.0 \
  gstreamer-sdp-1.0 \
  gstreamer-video-1.0 \
  libsoup-3.0 \
  json-glib-1.0; do
  if ! pkg-config --exists "$pkg"; then
    missing+=("$pkg")
  fi
done

if (( ${#missing[@]} > 0 )); then
  cat >&2 <<EOF
Missing build dependencies: ${missing[*]}

Install them on Ubuntu with:
  sudo apt-get install -y libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev libsoup-3.0-dev libjson-glib-dev
EOF
  exit 1
fi

if [[ ! -d "$SRC_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/meetecho/simple-whip-client.git "$SRC_DIR"
fi

if ! git -C "$SRC_DIR" apply --reverse --check "$SCRIPT_DIR/whip-consent.patch" 2>/dev/null; then
  git -C "$SRC_DIR" apply "$SCRIPT_DIR/whip-consent.patch"
fi

make -C "$SRC_DIR"
temporary="$(mktemp "$BIN_DIR/whip-client.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
install -m 755 "$SRC_DIR/whip-client" "$temporary"
mv -f "$temporary" "$BIN_DIR/whip-client"

cat <<EOF
Built libsoup3 WHIP client:
  $BIN_DIR/whip-client

Use this binary instead of Ubuntu's /usr/bin/whip-client, which links libsoup2
and conflicts with GStreamer's libsoup3 WebRTC/NICE plugins.
EOF

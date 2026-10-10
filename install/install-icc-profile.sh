#!/usr/bin/env bash
# Install the N123NCA_GS1 display colour profile on the X12 (GNOME + colord).
# Profile measured and published by NotebookCheck (X12 Detachable Gen 1 review);
# a mirror ships in this repo at color/N123NCA_GS1.icm (see color/README.md).
# Run this ON the X12 (not over SSH if you want the vcgt to load into the live session;
# colord assignment itself works over SSH, the gamma LUT loads on the next GNOME login).
#
# Usage, on the X12:
#   bash install-icc-profile.sh /path/to/N123NCA_GS1.icm
set -euo pipefail

SRC="${1:-N123NCA_GS1.icm}"
[ -f "$SRC" ] || { echo "profile not found: $SRC" >&2; exit 1; }

DEST_DIR="$HOME/.local/share/icc"
mkdir -p "$DEST_DIR"
cp -f "$SRC" "$DEST_DIR/"
BASENAME="$(basename "$SRC")"
echo "copied to $DEST_DIR/$BASENAME"

# Import into colord (registers the profile so GNOME can see it).
colormgr import-profile "$DEST_DIR/$BASENAME" || true

# Find the built-in display device object path.
DEV="$(colormgr get-devices-by-kind display | awk -F': *' '/Object Path/{print $2; exit}')"
[ -n "${DEV:-}" ] || { echo "no display device found in colord" >&2; exit 1; }
echo "display device: $DEV"

# Resolve the profile object path by its filename.
PROF="$(colormgr get-profiles | awk -v f="$BASENAME" -F': *' '
  /Object Path/{p=$2} /Filename/ && index($0,f){print p; exit}')"
[ -n "${PROF:-}" ] || { echo "profile not registered yet; open Settings > Color and add it manually" >&2; exit 1; }
echo "profile object: $PROF"

colormgr device-add-profile "$DEV" "$PROF" || true
colormgr device-make-profile-default "$DEV" "$PROF"
echo "assigned as default. The vcgt calibration loads on the next GNOME login"
echo "(log out/in, or reboot). Verify in Settings > Color."

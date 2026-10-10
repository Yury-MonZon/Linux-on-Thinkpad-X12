#!/usr/bin/env bash
# Install the X12's factory Dolby speaker tuning as EasyEffects presets.
# RUN THIS ON THE X12 (it reads the live PipeWire speaker sink for autoload).
# The X12's LAN connection is used for pacman/git; this does NOT touch the YOTA modem.
#
# Usage, on the X12, from the folder that holds the XML:
#   bash install-dolby-speakers.sh [X12_Dolby_DEV_0287_SUBSYS_17AA508B.xml]
set -euo pipefail

XML="${1:-X12_Dolby_DEV_0287_SUBSYS_17AA508B.xml}"
[ -f "$XML" ] || { echo "tuning XML not found: $XML" >&2; exit 1; }
XML_ABS="$(readlink -f "$XML")"

# 1. Dependencies (EasyEffects 8.x is in the Arch/CachyOS repo; converter needs numpy/scipy).
need=(easyeffects python-numpy python-scipy git); missing=()
for p in "${need[@]}"; do pacman -Qq "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ "${#missing[@]}" -gt 0 ]; then
    echo ">> installing: ${missing[*]}"
    sudo pacman -S --needed --noconfirm "${missing[@]}"
fi

# 2. Get the converter.
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
git clone --depth 1 https://github.com/antoinecellerier/speaker-tuning-to-easyeffects "$work/st"
cd "$work/st"

# 3. Generate presets. Laptop pose carries the --autoload binding (sets the
#    speaker sink's default preset + the fallback), tablet pose is added too so
#    you can switch to it by hand when detached.
# No dynamic leveler (autogain). Instead, Dolby's own static volmax boost (+6 dB
# at the regulator input) is kept, and we top it up to cancel the FIR's ~6.96 dB
# headroom exactly, so corrected output matches bypass loudness with no pumping.
python3 dolby_to_easyeffects.py "$XML_ABS" --endpoint internal_speaker --mode laptop --all-profiles --disable autogain --autoload
python3 dolby_to_easyeffects.py "$XML_ABS" --endpoint internal_speaker --mode tablet --all-profiles --disable autogain

# Static makeup to unity: set the multiband-compressor (regulator) input-gain.
# MAKEUP_DB is the total static gain; raise it a few dB if you want it hotter.
MAKEUP_DB="${MAKEUP_DB:-7.0}"
python3 - "$HOME/.local/share/easyeffects/output" "$MAKEUP_DB" <<'PYEOF'
import json, sys, glob, os
d, g = sys.argv[1], float(sys.argv[2])
for f in glob.glob(os.path.join(d, '*.json')):
    j = json.load(open(f)); o = j.get('output', {})
    for k in o.get('plugins_order', []):
        if k.startswith('multiband_compressor'):
            o[k]['input-gain'] = g
    json.dump(j, open(f, 'w'), indent=4)
print(f"static makeup set: regulator input-gain = {g:+.2f} dB on all presets")
PYEOF

# 4. Start EasyEffects' background service now and on every login.
mkdir -p "$HOME/.config/autostart"
desktop=/usr/share/applications/com.github.wwmm.easyeffects.desktop
if [ -f "$desktop" ]; then
    sed 's/^Exec=.*/Exec=easyeffects --gapplication-service/' "$desktop" \
        > "$HOME/.config/autostart/easyeffects-service.desktop"
fi
easyeffects --gapplication-service >/dev/null 2>&1 &

echo
echo "Done. Default on login: Dolby-Laptop-Dynamic-Balanced (bound to the speakers)."
echo "Open EasyEffects to switch profile (Movie/Music/Voice) or the Tablet variants."
echo "If it sounds unchanged, in EasyEffects > Output make sure a Dolby-* preset is"
echo "loaded, and under Preferences enable 'Launch Service at System Startup'."
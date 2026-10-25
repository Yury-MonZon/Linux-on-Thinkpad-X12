#!/bin/bash
# Install the ThinkPad X12 driver fixes from the signed pacman repo [x12].
#
# The fixes are the package kernel-fixes-x12 (kernel-fixes/PKGBUILD): the patched iosm,
# intel-ipu6, ov8856 and hid-lenovo drivers for exactly one linux-cachyos release, installed to
# extramodules, the way CachyOS ships linux-cachyos-zfs. GitHub Actions builds and signs it for
# every new linux-cachyos (.github/workflows/kernel-fixes.yml); pacman then updates the kernel
# and its fixes together. If a new kernel arrives before its fixes are published, pacman
# refuses that update ("breaks dependency ... required by kernel-fixes-x12") rather than
# install a kernel without them; try again an hour later.
#
# For: ThinkPad X12 Detachable Gen 1 with linux-cachyos from [cachyos-v4].
# Usage: install/install-kernel-fixes-x12.sh
set -eu
[ "$EUID" = 0 ] || exec sudo "$0" "$@"
here=$(dirname "$(readlink -f "$0")")/../kernel-fixes
fpr=07855C682C5245C90583F02356F85504502ECF43
url=https://github.com/Yury-MonZon/Linux-on-Thinkpad-X12/releases/download/x12-repo

grep -qx 'ThinkPad X12 Detachable Gen 1' /sys/class/dmi/id/product_version ||
  { echo "this is not a ThinkPad X12 Detachable Gen 1" >&2; exit 1; }
[ "$(pacman -Qi linux-cachyos 2>/dev/null | sed -n 's/^Architecture *: //p')" = x86_64_v4 ] ||
  { echo "needs linux-cachyos from [cachyos-v4] (x86_64_v4)" >&2; exit 1; }

# The repo key: the file must be exactly the key with this fingerprint
got=$(gpg --show-keys --with-colons "$here/x12-repo-key.asc" | awk -F: '/^fpr/{print $10; exit}')
[ "$got" = "$fpr" ] || { echo "x12-repo-key.asc is not key $fpr" >&2; exit 1; }
pacman-key --add "$here/x12-repo-key.asc"
pacman-key --lsign-key "$fpr"

if ! grep -q '^\[x12\]' /etc/pacman.conf; then
  cp -a /etc/pacman.conf "/etc/pacman.conf.bak-$(date +%Y%m%d)"
  cat >> /etc/pacman.conf <<EOF

# ThinkPad X12 driver fixes (kernel-fixes-x12), github.com/Yury-MonZon/Linux-on-Thinkpad-X12
[x12]
SigLevel = Required
Server = $url
EOF
fi

# A full update plus the package, never a partial upgrade
pacman -Syu --needed kernel-fixes-x12

#!/bin/bash
# Install the X12 kernel driver fixes as DKMS packages (kernel 7.0 and newer).
# Each package in dkms/ gets a copy of dkms/x12-dkms-build and goes to /usr/src/<name>-<version>;
# DKMS then builds it for every installed kernel it applies to, and again after kernel updates.
# Usage: install/install-dkms-x12.sh [package ...]    (default: every package in dkms/)
set -eu
[ "$EUID" = 0 ] || exec sudo "$0" "$@"
cd "$(dirname "$(readlink -f "$0")")/../dkms"
pkgs=("$@")
[ ${#pkgs[@]} = 0 ] && pkgs=($(find . -mindepth 2 -maxdepth 2 -name dkms.conf -printf '%h\n' | cut -c3- | sort))
for p in "${pkgs[@]}"; do
  ver=$(sed -n 's/^PACKAGE_VERSION="\(.*\)"/\1/p' "$p/dkms.conf")
  dst=/usr/src/$p-$ver
  dkms remove "$p/$ver" --all >/dev/null 2>&1 || true
  [ -d "$dst" ] && rm -r -- "$dst"
  install -d "$dst"
  install -m644 "$p"/* "$dst"/
  install -m755 x12-dkms-build "$dst"/x12-dkms-build
  install -m644 cachyos-kernel-keys.asc "$dst"/cachyos-kernel-keys.asc
  dkms add "$p/$ver"
  echo "dkms-x12: added $p/$ver"
done
dkms autoinstall
dkms status | grep -- '-x12/'

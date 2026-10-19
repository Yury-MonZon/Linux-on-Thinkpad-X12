## 13. Kernel driver fixes (DKMS)

Four kernel drivers need patches on the X12.
Each one is a DKMS package, so it is rebuilt automatically for every new kernel (7.0 and newer).

| Package | Driver | What it fixes | Section |
|---|---|---|---|
| `ov8856-x12` | `ov8856`, rear camera sensor | Sensor power on ACPI machines, Bayer order, runtime PM order, power off over suspend and hibernation, probe waits for intel-ipu6 | 4 |
| `ipu6-x12` | `intel-ipu6`, rear camera image unit | Firmware authentication after hibernation | 4 |
| `hid-lenovo-x12` | `hid-lenovo`, Folio keyboard | FnLock, mute LEDs and Fn/Ctrl swap lost after a USB reset (hibernation); `fn_ctrl_swap` sysfs attribute | 2 |
| `iosm-x12` | `iosm`, LTE modem | Suspend and resume error handling | 7 |

The packages and their patches are in `dkms/` next to this guide.

### How the packages build

- The packages do not ship driver source.
  `x12-dkms-build` fetches the source that matches each kernel, applies the package's patch and builds it.
- For a CachyOS kernel it fetches from the CachyOS release tag, so the driver matches the running kernel exactly: `7.2.9-1-cachyos` uses the tag `cachyos-7.2.9-1` of [CachyOS/linux](https://github.com/CachyOS/linux).
  Other kernels, or a release without a tag, use the stable tree at the same version.
- It fetches the driver's `Makefile`, the sources it names and every local header they include.
- Downloads are retried on network errors (three attempts per file, a few seconds apart).
  Every fetched source is also kept in `/var/cache/x12-dkms/<patch name>/<kernel>/`, the three newest kernels per package.
  If neither tree can be reached, for example with the network down during an update or a CachyOS release whose tag is not published yet, it builds from the newest cached source of the same kernel series: `7.2.11-1-cachyos` from the `7.2.9-1-cachyos` source.
  A new series (7.3) never uses 7.2 source; without a source that kernel keeps the stock driver.
- `BUILD_EXCLUSIVE_KERNEL_MIN="7.0"`: older kernels (the 6.18 LTS kernel) keep their stock drivers.
- If a future kernel changes a driver so much that the patch no longer applies, the build fails for that kernel only.
  That kernel keeps the stock driver; see "When a new kernel breaks a patch" below.
- The modules go to `updates/dkms/`, which `depmod` prefers over the stock drivers.
  DKMS signs them with its own key (`/var/lib/dkms/mok.key`).
  This kernel is not locked down (`/sys/kernel/security/lockdown` shows `[none]`), so they load with Secure Boot on.

`dkms/x12-dkms-build`, shared by all four packages:

```bash
#!/bin/bash
# Build a patched in-tree driver for one kernel, for DKMS (ThinkPad X12 fixes).
# Fetches the driver source that matches the kernel: the CachyOS release tag for CachyOS
# kernels (7.2.9-1-cachyos -> github.com/CachyOS/linux tag cachyos-7.2.9-1), otherwise the
# stable tree at the same version. Then applies the package's patch and builds in ./src.
# Downloads are retried on network errors. Every fetched source is kept in
# /var/cache/x12-dkms/<patch name>/<kernel>/; if neither tree can be reached (no network,
# or the CachyOS tag is not published yet), the newest cached source of the same kernel
# series (7.2.x) is used instead.
# If no source is available or the patch no longer applies, the build fails and that
# kernel keeps the stock driver.
# Usage (from dkms.conf): x12-dkms-build <kernelver> <kernel_source_dir>
# Package settings in ./x12-dkms.conf:
#   KPATH    driver directory in the kernel tree, e.g. drivers/media/pci/intel/ipu6
#   SOURCES  files to fetch besides the Makefile; empty = every .c named in the Makefile
#   OBJ_M    if set, write a Makefile with "obj-m := $OBJ_M" instead of fetching the upstream one
#   PATCH    patch file (paths relative to KPATH, applied with -p1)
set -eu
kver=$1
ksrc=$2
cd "$(dirname "$0")"
. ./x12-dkms.conf

cache=/var/cache/x12-dkms/${PATCH%.patch}
keep=3                                  # cached kernel versions kept per package

# get <url> <file>: download; returns 0, or 22 when the server says the file does not exist
# (HTTP 4xx, no retry), or curl's error after several attempts on network errors
get() {
    local try rc
    for try in 1 2 3; do
        rc=0
        curl -sfL --connect-timeout 15 --retry 2 --retry-connrefused -o "$2" "$1" || rc=$?
        if [ "$rc" = 0 ] || [ "$rc" = 22 ]; then return "$rc"; fi
        rm -f "$2"
        [ "$try" = 3 ] || sleep $((try * 5))
    done
    return "$rc"
}

fetch_tree() {    # fetch_tree <url of KPATH> <suffix>: fill ./src from one tree; fails on any error
    local url=$1 suffix=$2 f h new rc
    rm -rf src
    mkdir src
    fetch() {     # fetch <file name in KPATH>; 22 = no such file in this tree
        get "$url/$1$suffix" "src/$1"
    }
    if [ -n "${OBJ_M:-}" ]; then
        echo "obj-m := $OBJ_M" > src/Makefile
    else
        fetch Makefile || return 1
    fi
    for f in ${SOURCES:-$(grep -oE '[A-Za-z0-9_-]+\.o' src/Makefile | sed 's/\.o$/.c/' | sort -u)}; do
        rc=0
        fetch "$f" || rc=$?
        if [ "$rc" = 22 ]; then
            # composite targets such as iosm.o have no .c, but named SOURCES must exist
            [ -z "${SOURCES:-}" ] || return 1
        elif [ "$rc" != 0 ]; then
            return 1
        fi
    done
    # Local headers, followed until nothing new turns up
    while :; do
        new=0
        for h in $(grep -ho '#include "[^"/]*"' src/*.c src/*.h 2>/dev/null | cut -d'"' -f2 | sort -u); do
            if [ -e "src/$h" ] || [ -e "src/$h.missing" ]; then continue; fi
            rc=0
            fetch "$h" || rc=$?
            if [ "$rc" = 22 ]; then : > "src/$h.missing"; elif [ "$rc" != 0 ]; then return 1; fi
            new=1
        done
        [ "$new" = 0 ] && break
    done
    rm -f src/*.missing
}

# Pick the source tree once, so files never come from two different trees
from=
case $kver in
    *-cachyos*)
        u="https://raw.githubusercontent.com/CachyOS/linux/cachyos-${kver%%-cachyos*}/$KPATH"
        fetch_tree "$u" "" && from=$u ;;
esac
if [ -z "$from" ]; then
    base=${kver%%-*}; base=${base%.0}   # 7.2.9-1-cachyos -> 7.2.9
    u="https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/$KPATH"
    fetch_tree "$u" "?h=v$base" && from=$u
fi

if [ -n "$from" ]; then
    echo "x12-dkms-build: $KPATH for $kver from ${from%/$KPATH}"
    # Keep this source for builds that cannot reach either tree, and drop the oldest copies
    rm -rf "${cache:?}/$kver"
    mkdir -p "$cache/$kver"
    cp -a src/. "$cache/$kver/"
    ls -1 "$cache" | sort -V | head -n -"$keep" | while read -r old; do rm -rf "${cache:?}/$old"; done
else
    # Newest cached source of the same series: 7.2.11-1-cachyos may use 7.2.9-1-cachyos
    series=$(echo "$kver" | cut -d. -f1-2)
    old=$( (ls -1 "$cache" 2>/dev/null || true) | grep -F "$series." | sort -V | tail -n 1)
    if [ -z "$old" ]; then
        echo "x12-dkms-build: $KPATH for $kver: cannot fetch the source and nothing cached for $series.x" >&2
        exit 1
    fi
    echo "x12-dkms-build: $KPATH for $kver: cannot fetch the source, using the cached source of $old"
    rm -rf src
    mkdir src
    cp -a "$cache/$old/." src/
fi

patch -s -d src -p1 < "$PATCH"

llvm=$(grep -qs '^CONFIG_CC_IS_CLANG=y' "$ksrc/.config" && echo LLVM=1 || true)
make -C "$ksrc" M="$PWD/src" $llvm modules
```

Each package directory holds a `dkms.conf`, an `x12-dkms.conf` for the build script, and the patch.
For example `dkms/ipu6-x12/`:

`dkms.conf`:

```
PACKAGE_NAME="ipu6-x12"
PACKAGE_VERSION="2.0"
# ThinkPad X12: rear camera (IPU6) firmware authentication after hibernation
# x12-dkms-build fetches the driver source matching each kernel (CachyOS tag or stable tree)
# and applies ipu6-hibernate.patch. Kernel 7.0 and newer only.
BUILT_MODULE_NAME[0]="intel-ipu6"
BUILT_MODULE_LOCATION[0]="src/"
DEST_MODULE_LOCATION[0]="/kernel/drivers/media/pci/intel/ipu6"
BUILT_MODULE_NAME[1]="intel-ipu6-isys"
BUILT_MODULE_LOCATION[1]="src/"
DEST_MODULE_LOCATION[1]="/kernel/drivers/media/pci/intel/ipu6"
MAKE[0]="bash ./x12-dkms-build ${kernelver} ${kernel_source_dir}"
BUILD_EXCLUSIVE_KERNEL_MIN="7.0"
AUTOINSTALL="yes"
```

`x12-dkms.conf`:

```
KPATH=drivers/media/pci/intel/ipu6
SOURCES=""
OBJ_M=""
PATCH=ipu6-hibernate.patch
```

`ov8856-x12` and `hid-lenovo-x12` build a single file, so they set `SOURCES` (`ov8856.c`, `hid-lenovo.c`) and `OBJ_M` (`ov8856.o`, `hid-lenovo.o`).

### Install

Needs `dkms`, `curl`, `patch` and the headers of each kernel (`linux-cachyos-headers`).
`install/install-dkms-x12.sh` copies each package and the build script to `/usr/src/<name>-<version>`, registers it and builds it for every installed kernel:

```bash
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
  dkms add "$p/$ver"
  echo "dkms-x12: added $p/$ver"
done
dkms autoinstall
dkms status | grep -- '-x12/'
```

```
sudo pacman -S --needed dkms curl patch linux-cachyos-headers
sudo install/install-dkms-x12.sh               # or name packages: ... ipu6-x12 ov8856-x12
modinfo -n ov8856 intel-ipu6 hid-lenovo iosm   # expect .../updates/dkms/...
```

Reboot to load the new drivers.
The pacman hook that ships with `dkms` rebuilds them after every kernel update.

### When a new kernel breaks a patch

- `dkms status` shows the package without "installed" for that kernel, and the update prints the build error.
  The full log is in `/var/lib/dkms/<package>/<version>/build/make.log` for a failed build, and in `/var/lib/dkms/<package>/<version>/<kernel>/x86_64/log/make.log` for a successful one.
- `cannot fetch the source and nothing cached` means neither tree could be reached and there is no cached source for that kernel series, the patch is fine.
  This happened on 2026-10-19 with the `7.2.11-1-cachyos` update, before the cache existed: the downloads failed during the update and all four packages kept the stock drivers until they were rebuilt.
  Rebuild before rebooting, then rebuild the UKIs so the initramfs picks up the new modules:

  ```
  sudo dkms autoinstall -k <kernel version>
  sudo mkinitcpio -P
  ```
- `using the cached source of ...` in the log is not an error: the module was built from the previous kernel's driver source.
  Rebuild once the network is back to use the exact source (`dkms install` does not rebuild a module that is already installed):

  ```
  sudo dkms build --force <package>/<version> -k <kernel version>
  sudo dkms install --force <package>/<version> -k <kernel version>
  ```
- That kernel runs the stock driver meanwhile, without the fix.
- If upstream has merged the fix, remove the package: `sudo dkms remove <package>/<version> --all`.
  DKMS restores the stock module.

---

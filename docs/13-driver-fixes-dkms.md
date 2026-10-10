## 13. Kernel driver fixes (DKMS)

Four kernel drivers need patches on the X12.
Each one is a DKMS package, so it is rebuilt automatically for every new kernel (7.0 and newer).

| Package | Driver | What it fixes | Section |
|---|---|---|---|
| `ov8856-x12` | `ov8856`, rear camera sensor | Sensor power on ACPI machines, Bayer order, runtime PM order, power off over suspend and hibernation | 4 |
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
# If the source cannot be fetched or the patch no longer applies, the build fails and that
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

rm -rf src
mkdir src

# Pick the source tree once, so files never come from two different trees
probe=Makefile
[ -n "${OBJ_M:-}" ] && probe=${SOURCES%% *}
url=
case $kver in
    *-cachyos*)
        u="https://raw.githubusercontent.com/CachyOS/linux/cachyos-${kver%%-cachyos*}/$KPATH"
        curl -sfI --retry 2 "$u/$probe" >/dev/null && url=$u ;;
esac
if [ -z "$url" ]; then
    base=${kver%%-*}; base=${base%.0}   # 7.2.9-1-cachyos -> 7.2.9
    url="https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/$KPATH"
    suffix="?h=v$base"
fi
echo "x12-dkms-build: $KPATH for $kver from ${url%/$KPATH}"

fetch() {    # fetch <file name in KPATH>; fails if the file does not exist there
    curl -sfL --retry 2 -o "src/$1" "$url/$1${suffix:-}"
}

if [ -n "${OBJ_M:-}" ]; then
    echo "obj-m := $OBJ_M" > src/Makefile
else
    fetch Makefile
fi
files=${SOURCES:-$(grep -oE '[A-Za-z0-9_-]+\.o' src/Makefile | sed 's/\.o$/.c/' | sort -u)}
for f in $files; do
    fetch "$f" || true                  # composite targets such as iosm.o have no .c
done
# Local headers, followed until nothing new turns up
while :; do
    new=0
    for h in $(grep -ho '#include "[^"/]*"' src/*.c src/*.h 2>/dev/null | cut -d'"' -f2 | sort -u); do
        if [ -e "src/$h" ] || [ -e "src/$h.missing" ]; then continue; fi
        fetch "$h" || : > "src/$h.missing"
        new=1
    done
    [ "$new" = 0 ] && break
done
rm -f src/*.missing

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
  The full log is in `/var/lib/dkms/<package>/<version>/build/make.log`.
- That kernel runs the stock driver meanwhile, without the fix.
- If upstream has merged the fix, remove the package: `sudo dkms remove <package>/<version> --all`.
  DKMS restores the stock module.

---

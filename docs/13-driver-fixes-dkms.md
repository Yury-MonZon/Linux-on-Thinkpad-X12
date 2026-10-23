## 13. Kernel driver fixes (DKMS)

Four kernel drivers need patches on the X12.
Each one is a DKMS package, so it is rebuilt automatically for every new kernel (7.0 and newer).

| Package | Driver | What it fixes | Section |
|---|---|---|---|
| `ov8856-x12` | `ov8856`, rear camera sensor | Sensor power on ACPI machines, Bayer order, runtime PM order, power off over suspend and hibernation, probe waits for intel-ipu6 | 4 |
| `ipu6-x12` | `intel-ipu6`, rear camera image unit | Firmware authentication after hibernation | 4 |
| `hid-lenovo-x12` | `hid-lenovo`, Folio keyboard | FnLock, mute LEDs and Fn/Ctrl swap lost after a USB reset (hibernation); `fn_ctrl_swap` sysfs attribute | 2 |
| `iosm-x12` | `iosm`, LTE modem | Suspend and resume error handling, reset of a modem that crashed or does not start, hibernation with runtime PM | 7 |

The packages and their patches are in `dkms/` next to this guide.

### How the packages build

- The packages do not ship driver source.
  `x12-dkms-build` fetches the source that matches each kernel, applies the package's patch and builds it.
- For a CachyOS kernel it uses the CachyOS release tag, so the driver matches the running kernel exactly: `7.2.9-1-cachyos` uses the tag `cachyos-7.2.9-1` of [CachyOS/linux](https://github.com/CachyOS/linux).
  Other kernels use the stable tree at the same version, file by file from git.kernel.org.
  A CachyOS kernel never falls back to the stable tree: that is a different kernel.
- The CachyOS tag comes as a git partial clone that holds only the driver folders (`git clone --depth 1 --filter=blob:none --no-checkout`, then `git sparse-checkout` of the driver folder): a few requests and about 14 MB for one driver, 29 MB for all four.
  The tags are signed by the CachyOS kernel maintainers; `git verify-tag` checks the signature against the two CachyOS kernel signing keys in `dkms/cachyos-kernel-keys.asc`, the `validpgpkeys` of the `linux-cachyos` PKGBUILD (Peter Jung `E8B9AA39F054E30E8290D492C3C4820857F654FE`, Eric Naim `E18447AC260021D31F3FF6C4C8A2A4774B8B63C4`), and git's hashes carry it to every file.
  One clone per kernel, in `/var/cache/x12-dkms/cachyos-git/<tag>/`, serves all four packages; each adds its own driver folder.
- If GitHub refuses (a rate limit, the network down), the clone is retried up to 5 rounds, 60 s apart.
  After that the script downloads the release tarball the CachyOS kernel package itself is built from (`cachyos-7.2.9-1.tar.gz`, about 270 MB) with its signature and checks it with `gpgv` against the same keys; it is kept in `/var/cache/x12-dkms/cachyos-tarball/` for the other packages of the same kernel.
  Clones and tarballs of kernels that are no longer installed are deleted.
  For testing, `X12_DKMS_SOURCE=tarball` skips the clone.
- Tested 2026-10-23: all four modules built from the signed tag are identical to the ones built from the old file-by-file download (same `srcversion`), and so is iosm built from the tarball; a tag without the keys ("No public key") and a tarball with another release's signature ("BAD signature") are rejected.
- Before 2026-10-23 the sources were fetched file by file from GitHub's raw file server, about 80 requests per kernel update, and any HTTP error counted as a missing file: a GitHub rate limit (HTTP 429) dropped `iosm_ipc_pcie.c` from a build and overwrote the cached source with the incomplete one.
  Only HTTP 404 counts as a missing file now (stable tree).
- A source the patch applies to is kept in `/var/cache/x12-dkms/<patch name>/<kernel>/`, the three newest kernels per package.
  If no source can be fetched at all, for example with the network down during an update, it builds from the cached source of the same kernel, or else the newest one of the same series and flavour: `7.2.11-1-cachyos` from the `7.2.9-1-cachyos` source, never from a stable-tree one.
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
# Fetches the driver source that matches the kernel, applies the package's patch and builds
# it in ./src.
#   CachyOS kernels (7.2.9-1-cachyos): the CachyOS release tag cachyos-7.2.9-1 of
#   github.com/CachyOS/linux, as a git partial clone that holds only the driver folders
#   (about 14 MB, a few requests). The tag is signed; it is checked against the CachyOS kernel
#   signing keys (cachyos-kernel-keys.asc, the validpgpkeys of linux-cachyos). One clone per
#   kernel serves all packages. When GitHub refuses, up to 5 rounds 60 s apart; then the
#   signed release tarball the CachyOS kernel package is built from (about 270 MB).
#   Never the stable tree: that is a different kernel.
#   Other kernels: the stable tree at the same version, file by file from git.kernel.org.
# Only HTTP 404 counts as a file the tree does not have. A source the patch applies to is kept
# in /var/cache/x12-dkms/<patch name>/<kernel>/; with no source at all (no network), the cached
# source of the same kernel is used, or else the newest one of the same series and flavour.
# If no source is available or the patch no longer applies, the build fails and that
# kernel keeps the stock driver.
# Usage (from dkms.conf): x12-dkms-build <kernelver> <kernel_source_dir>
# Package settings in ./x12-dkms.conf:
#   KPATH    driver directory in the kernel tree, e.g. drivers/media/pci/intel/ipu6
#   SOURCES  files to fetch besides the Makefile; empty = every .c named in the Makefile
#   OBJ_M    if set, write a Makefile with "obj-m := $OBJ_M" instead of fetching the upstream one
#   PATCH    patch file (paths relative to KPATH, applied with -p1)
# Testing: X12_DKMS_SOURCE=tarball skips the git clone of a CachyOS kernel.
set -eu
kver=$1
ksrc=$2
cd "$(dirname "$0")"
. ./x12-dkms.conf

cache=/var/cache/x12-dkms/${PATCH%.patch}
keep=3                                  # cached kernel versions kept per package
clones=/var/cache/x12-dkms/cachyos-git        # partial clones of CachyOS tags, per kernel
tarballs=/var/cache/x12-dkms/cachyos-tarball   # CachyOS release tarballs, per kernel
rounds=5 pause=60                       # git rounds before the tarball, seconds apart

# get <url> <file>: download; returns 0, or 22 when the server says the file does not exist
# (HTTP 404, no retry), or 1 after several attempts on network errors and other HTTP errors
# (a rate limit such as HTTP 429 must not look like a missing file)
get() {
    local try code
    for try in 1 2 3; do
        code=$(curl -sL --connect-timeout 15 --retry 2 --retry-connrefused \
               -w '%{http_code}' -o "$2" "$1") || code=000
        case $code in
            200) return 0 ;;
            404) rm -f "$2"; return 22 ;;
        esac
        rm -f "$2"
        [ "$try" = 3 ] || sleep $((try * 5))
    done
    echo "x12-dkms-build: download failed (HTTP $code): $1" >&2
    return 1
}

# fetch_tree <url of KPATH> <suffix>: fill ./src from one tree; fails on any error.
# A url that is a local directory (an unpacked tarball) is copied from instead.
fetch_tree() {
    local url=$1 suffix=$2 f h new rc
    rm -rf src
    mkdir src
    fetch() {     # fetch <file name in KPATH>; 22 = no such file in this tree
        if [ -d "$url" ]; then
            [ -f "$url/$1" ] || return 22
            cp "$url/$1" "src/$1"
        else
            get "$url/$1$suffix" "src/$1"
        fi
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

# gitsrc <tag>: $clones/<tag>, a partial clone of the CachyOS tag with $KPATH checked out.
# The clone is made once per kernel, its tag signature checked against the CachyOS kernel
# signing keys; later packages only add their driver folder.
gitsrc() {
    local tag=$1 d=$clones/$1 g
    if [ ! -d "$d/.git" ]; then
        rm -rf "$d"
        mkdir -p "$clones"
        git -c advice.detachedHead=false clone -q --depth 1 --filter=blob:none --no-checkout \
            --branch "$tag" https://github.com/CachyOS/linux.git "$d" || { rm -rf "$d"; return 1; }
        g=$(mktemp -d)
        gpg --homedir "$g" -q --import cachyos-kernel-keys.asc 2>/dev/null
        if ! GNUPGHOME=$g git -C "$d" verify-tag "$tag" ||
           [ "$(git -C "$d" rev-parse "$tag^{commit}")" != "$(git -C "$d" rev-parse HEAD)" ]; then
            echo "x12-dkms-build: $tag: bad tag signature" >&2
            rm -rf "$d" "$g"
            return 1
        fi
        rm -rf "$g"
        git -C "$d" sparse-checkout set --no-cone "/$KPATH/" || return 1
    else
        git -C "$d" sparse-checkout add "/$KPATH/" || return 1
    fi
    git -C "$d" checkout -q || return 1       # fetches the files of the driver folders
    [ -d "$d/$KPATH" ]
}

# The CachyOS release tarball for tag $1, checked against the CachyOS kernel signing keys
tarball() {
    local tag=$1 tmp
    tmp=$(mktemp -d)
    mkdir -p "$tarballs"
    if [ ! -f "$tarballs/$tag.tar.gz" ]; then
        local rel=https://github.com/CachyOS/linux/releases/download/$tag/$tag.tar.gz
        echo "x12-dkms-build: downloading $rel"
        get "$rel" "$tmp/$tag.tar.gz" && get "$rel.asc" "$tmp/$tag.tar.gz.asc" || { rm -rf "$tmp"; return 1; }
        gpg --homedir "$tmp" --dearmor < cachyos-kernel-keys.asc > "$tmp/keyring.gpg"
        if ! gpgv --keyring "$tmp/keyring.gpg" "$tmp/$tag.tar.gz.asc" "$tmp/$tag.tar.gz"; then
            echo "x12-dkms-build: $tag.tar.gz: bad signature" >&2
            rm -rf "$tmp"
            return 1
        fi
        rm -f "$tarballs"/*.tar.gz     # one kernel's tarball is enough
        mv "$tmp/$tag.tar.gz" "$tarballs/"
    fi
    mkdir "$tmp/x"
    tar xzf "$tarballs/$tag.tar.gz" -C "$tmp/x" "$tag/$KPATH" &&
        fetch_tree "$tmp/x/$tag/$KPATH" ""
    local rc=$?
    rm -rf "$tmp"
    return $rc
}

# Clones and tarballs of kernels that are no longer installed are not needed again
for f in "$clones"/cachyos-* "$tarballs"/cachyos-*.tar.gz; do
    [ -e "$f" ] || continue
    t=$(basename "$f" .tar.gz)
    [ -d "/usr/lib/modules/${t#cachyos-}-cachyos" ] || rm -rf "$f"
done

# One tree per kernel, so files never come from two different trees
fetched=0
case $kver in
    *-cachyos*)
        flavour=-cachyos
        tag=cachyos-${kver%%-cachyos*}
        # Another package of this kernel already needed the tarball: use it straight away
        if [ "${X12_DKMS_SOURCE:-}" != tarball ] && [ ! -f "$tarballs/$tag.tar.gz" ]; then
            for ((r = 1; r <= rounds; r++)); do
                if gitsrc "$tag" && fetch_tree "$clones/$tag/$KPATH" ""; then fetched=1; break; fi
                [ "$r" = "$rounds" ] || { echo "x12-dkms-build: round $r of $rounds failed, next in $pause s"; sleep "$pause"; }
            done
        fi
        if [ "$fetched" = 1 ]; then
            echo "x12-dkms-build: $KPATH for $kver from the signed tag $tag (git)"
        elif tarball "$tag"; then
            echo "x12-dkms-build: $KPATH for $kver from the signed release tarball $tag.tar.gz"
            fetched=1
        fi ;;
    *)
        flavour=
        base=${kver%%-*}; base=${base%.0}   # 7.2.9-1 -> 7.2.9
        u="https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/$KPATH"
        if fetch_tree "$u" "?h=v$base"; then
            echo "x12-dkms-build: $KPATH for $kver from ${u%/$KPATH}"
            fetched=1
        fi ;;
esac

if [ "$fetched" = 0 ]; then
    # The cached source of this kernel, or else the newest one of the same series and flavour:
    # 7.2.11-1-cachyos may use 7.2.9-1-cachyos, never a stable-tree source
    series=$(echo "$kver" | cut -d. -f1-2)
    if [ -d "$cache/$kver" ]; then
        old=$kver
    else
        old=$( (ls -1 "$cache" 2>/dev/null || true) | grep -F "$series." |
               if [ -n "$flavour" ]; then grep -e "$flavour"; else grep -v -e -cachyos; fi |
               sort -V | tail -n 1)
    fi
    if [ -z "$old" ]; then
        echo "x12-dkms-build: $KPATH for $kver: cannot fetch the source and nothing cached for $series.x$flavour" >&2
        exit 1
    fi
    echo "x12-dkms-build: $KPATH for $kver: cannot fetch the source, using the cached source of $old"
    rm -rf src
    mkdir src
    cp -a "$cache/$old/." src/
fi

# Cache the source only once the patch applies to it, so a bad download never replaces a good copy
rm -rf src.orig
cp -a src src.orig
patch -s -d src -p1 < "$PATCH"
if [ "$fetched" = 1 ]; then
    rm -rf "${cache:?}/$kver"
    mkdir -p "$cache/$kver"
    cp -a src.orig/. "$cache/$kver/"
    ls -1 "$cache" | sort -V | head -n -"$keep" | while read -r old; do rm -rf "${cache:?}/$old"; done
fi
rm -rf src.orig

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

Needs `dkms`, `curl`, `git`, `gnupg`, `patch` and the headers of each kernel (`linux-cachyos-headers`).
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
  install -m644 cachyos-kernel-keys.asc "$dst"/cachyos-kernel-keys.asc
  dkms add "$p/$ver"
  echo "dkms-x12: added $p/$ver"
done
dkms autoinstall
dkms status | grep -- '-x12/'
```

```
sudo pacman -S --needed dkms curl git gnupg patch linux-cachyos-headers
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

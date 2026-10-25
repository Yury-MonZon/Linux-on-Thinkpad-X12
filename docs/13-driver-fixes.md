## 13. Kernel driver fixes (kernel-fixes-x12)

Four kernel drivers need patches on the X12.
They ship as one package, `kernel-fixes-x12`, from the signed pacman repo `[x12]` of this project.
For ThinkPad X12 Detachable Gen 1 with `linux-cachyos` from `[cachyos-v4]`.

| Driver | Device | What the patch fixes | Patch | Section |
|---|---|---|---|---|
| `ov8856` | rear camera sensor | Sensor power on ACPI machines, Bayer order, runtime PM order, power off over suspend and hibernation, probe waits for intel-ipu6 | `ov8856-x12.patch` | 4 |
| `intel-ipu6`, `intel-ipu6-isys` | rear camera image unit | Firmware authentication after hibernation | `ipu6-hibernate.patch` | 4 |
| `hid-lenovo` | Folio keyboard | FnLock, mute LEDs and Fn/Ctrl swap lost after a USB reset (hibernation); `fn_ctrl_swap` sysfs attribute | `hid-lenovo-reset-resume.patch` | 2 |
| `iosm` | LTE modem | Suspend and resume error handling, reset of a modem that crashed or does not start, hibernation with runtime PM | `iosm-pm.patch` | 7 |

The patches, the PKGBUILD and the build script are in `kernel-fixes/`.

### How it works

It is the way CachyOS ships extra kernel modules such as `linux-cachyos-zfs`:

- The package is built for exactly one `linux-cachyos` release and depends on it (`depends=(linux-cachyos=7.3.0-4)`).
  pacman updates the kernel and its fixes together, in one transaction.
- The drivers go to `/usr/lib/modules/<kernel>/extramodules/`, which `depmod` prefers over the stock drivers (`/usr/lib/depmod.d/search.conf`: `search updates extramodules built-in`).
  pacman's own hooks then run `depmod` and rebuild the boot image.
- The driver sources come from the same release tarball `linux-cachyos` is built from, `cachyos-<release>.tar.gz` of [CachyOS/linux](https://github.com/CachyOS/linux), with the same `source=` and `validpgpkeys` as CachyOS's own PKGBUILD.
  makepkg checks the tarball's signature against the two CachyOS kernel signing keys (Peter Jung `E8B9AA39F054E30E8290D492C3C4820857F654FE`, Eric Naim `E18447AC260021D31F3FF6C4C8A2A4774B8B63C4`).
  CachyOS publishes only these fingerprints; the keys come from a keyserver by fingerprint, and makepkg accepts the signature from exactly these keys.
- They are built against `linux-cachyos-headers` of the same release, so a package can be ready before its kernel is installed.

`.github/workflows/kernel-fixes.yml` builds the package for every new `linux-cachyos` in `[cachyos-v4]`, hourly, signs it with this project's own repo key and publishes it as the release `x12-repo`, which is the `[x12]` repo.
CachyOS's keys are only used to check CachyOS's signatures on what the package is built from; everything in `[x12]` is signed with the repo key only.

| | |
|---|---|
| Repo key | `07855C682C5245C90583F02356F85504502ECF43` (`kernel-fixes/x12-repo-key.asc`), "Linux-on-Thinkpad-X12 kernel-fixes-x12 repo" |
| Repo | `https://github.com/Yury-MonZon/Linux-on-Thinkpad-X12/releases/download/x12-repo` |

This is an unofficial package, not affiliated with CachyOS.

### Install

```
install/install-kernel-fixes-x12.sh
```

It checks that the machine is an X12 Detachable Gen 1 with the `x86_64_v4` kernel, that `x12-repo-key.asc` is the key above, adds that key to pacman (`pacman-key --add`, `--lsign-key`), adds the repo to `/etc/pacman.conf` (backup `/etc/pacman.conf.bak-<date>`):

```
[x12]
SigLevel = Required
Server = https://github.com/Yury-MonZon/Linux-on-Thinkpad-X12/releases/download/x12-repo
```

and runs `pacman -Syu --needed kernel-fixes-x12`.
Reboot to load the fixed drivers, then check:

```
modinfo -n iosm intel-ipu6 ov8856 hid-lenovo   # expect .../extramodules/...
```

A key added with `pacman-key --lsign-key` is trusted by pacman for any repo, as with every third-party repo.

### When a new kernel comes out

- Normally the workflow has published the fixes for it within the hour, and the update installs both.
- If the kernel reaches your mirror first, pacman refuses the whole update with a dependency error that names `kernel-fixes-x12` and `linux-cachyos=<old>`.
  Nothing is installed; try again later.
- The reverse can happen too: `[x12]` already has the fixes for a kernel your mirror does not have yet, and pacman reports that `linux-cachyos=<new>` cannot be satisfied.
  Same thing, try again later.
- Either way, a kernel without its fixes is never installed.

### Build it yourself

For the installed kernel, if `[x12]` does not have it (otherwise wait for the workflow):

```
sudo pacman -S --needed base-devel clang llvm lld aria2
kernel-fixes/build-kernel-fixes-x12 "$(pacman -Q linux-cachyos | cut -d' ' -f2)"
sudo pacman -U ~/.cache/kernel-fixes-x12/kernel-fixes-x12-<release>.<fixrel>-x86_64.pkg.tar.zst
```

The script takes the headers package from pacman's cache (or downloads it with `pacman -Sw`), the CachyOS kernel keys by fingerprint from a keyserver, and keeps the tarball (about 270 MB) in `~/.cache/kernel-fixes-x12/src/`.
GitHub limits each download connection (about 60 KB/s on bad days); with `aria2c` installed it downloads over 8 connections, through makepkg's `DLAGENTS`.
`_fixrel` in the PKGBUILD numbers the package for the same kernel: bump it when a patch changes, and the workflow publishes `<release>.<fixrel+1>`.

### When a patch stops applying

- The workflow fails for that kernel (the run log shows the rejected hunk), so `[x12]` gets no package for it, and pacman keeps refusing that kernel update until the patch is fixed.
- Fix the patch against the new driver, bump `_fixrel`, push; the workflow publishes it.
- If upstream has merged a fix, drop its patch from the package.
  Once all four are upstream: `sudo pacman -R kernel-fixes-x12`, and remove `[x12]` from `/etc/pacman.conf`.

### Why not DKMS

Until 2026-10-25 these were four DKMS packages that downloaded the driver source from GitHub while building, during the kernel update.
On 2026-10-19 (`7.2.11-1-cachyos`) and 2026-10-25 (`7.3.0-4-cachyos`) GitHub could not be reached at that moment: the builds failed, pacman only printed a warning, and the new kernel booted with the stock drivers; on 2026-10-25 an s2idle suspend then hung.
Usual DKMS packages ship their source instead, but a failed DKMS build still lets the kernel install.
The package above fails before anything is installed.

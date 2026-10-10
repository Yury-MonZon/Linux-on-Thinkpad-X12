# Linux on the ThinkPad X12 Detachable Gen 1

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Setup notes, scripts, hooks and driver patches to get the Lenovo ThinkPad X12
Detachable Gen 1 fully working on Linux (tested on CachyOS with GNOME on Wayland).

Tested on: machine type 20UV (X12 Detachable Gen 1), i5-1140G7, BIOS R1GET68W,
CachyOS + GNOME (Wayland), kernels linux-cachyos 7.2 and linux-cachyos-lts 6.18.
Most of it is distribution-agnostic (systemd, PAM, udev, PipeWire, thinkfan).

## If you cannot turn Secure Boot off (locked BIOS)

Many of these machines ship with the BIOS Secure Boot controls greyed out: you
cannot enter Setup Mode, clear the keys, or disable Secure Boot without the
supervisor password, and on a second-hand or company unit you usually do not
have it. **You do not need it.** This guide is built to run with Secure Boot
left fully enabled and enforcing:

- The boot chain is `shim` (Microsoft-signed, trusted by the firmware db) then a
  signed Unified Kernel Image then systemd-boot. Your own key is enrolled in MOK
  through shim, so nothing in the BIOS has to change. See
  [docs/01-secure-boot.md](docs/01-secure-boot.md).
- Kernel command line and UKIs are signed automatically on every kernel update.
- Even the F11 recovery path (a CachyOS live image on the internal disk) boots
  under enforced Secure Boot with no supervisor password. See
  [docs/11-f11-recovery-live.md](docs/11-f11-recovery-live.md).

So if your only blocker is "I can't disable Secure Boot", start at section 1 and
ignore every instruction elsewhere on the internet that tells you to turn it off.

Do not try to guess the supervisor password: too many attempts can lock the
machine permanently.

## What works

| Area | Status | Notes |
| --- | --- | --- |
| Secure Boot with locked BIOS | works | shim + signed UKI + systemd-boot, MOK-enrolled key |
| Keyboard backlight (Fn+Space) | works | 3 steps with a matching on-screen display (Folio) |
| FnLock and Fn/Ctrl swap | works | set in the Folio firmware, reapplied on connect |
| Fingerprint | works | including the GNOME auth dialog and after resume |
| Face unlock (IR camera) | works | Visage on the built-in IR camera, about 1.6 s per unlock |
| Front webcam | works | full frame rate kept in dim light |
| Rear camera (OV8856) | works | patched driver + libcamera gain model + PipeWire |
| GPU (HuC, VA-API) | works | hardware video decode in mpv and Firefox |
| Fan | works | quieter curve with thinkfan |
| LTE modem + GPS (Fibocom L850-GL) | works | with FCC unlock |
| Speakers | works | factory Dolby tuning reproduced in EasyEffects |
| F11 recovery (live image) | works | CachyOS live on the internal disk, no USB |

For the short list of things that do not work and what to avoid, see
[docs/08-what-does-not-work.md](docs/08-what-does-not-work.md).

## Layout

```
docs/      the guide, one file per section (start with 00-overview.md)
bin/       helpers that install to /usr/local/bin
etc/       pacman hooks and other /etc drop-ins
patches/   driver patches (ov8856, libcamera, PipeWire)
install/   one-shot installers (F11 live image, speakers, color profile)
presets/   EasyEffects speaker presets (EQ + dynamics; generate the FIR locally)
color/     mirrored display ICC profile (source and credit in color/README.md)
```

## The guide

- [00 Overview](docs/00-overview.md)
- [01 Secure Boot with shim + systemd-boot (locked BIOS)](docs/01-secure-boot.md)
- [02 Keyboard: backlight OSD, FnLock, Fn/Ctrl swap](docs/02-keyboard.md)
- [03 Fingerprint and face unlock](docs/03-auth-fingerprint-face.md)
- [04 Cameras: front webcam and rear camera](docs/04-cameras.md)
- [05 GPU: HuC, PSR2 and hardware video](docs/05-gpu-video.md)
- [06 Quieter fan curve with thinkfan](docs/06-fan-thinkfan.md)
- [07 LTE modem (Fibocom L850-GL) and GPS](docs/07-lte-modem-gps.md)
- [08 What does not work (and what to avoid)](docs/08-what-does-not-work.md)
- [09 Optional extras](docs/09-extras.md)
- [10 Speaker correction (Dolby tuning via EasyEffects)](docs/10-speakers-dolby.md)
- [11 F11 recovery: a CachyOS live image on the internal disk](docs/11-f11-recovery-live.md)

## A note on the audio and color assets

The EasyEffects **speaker presets** in `presets/` are the EQ, leveler and
dynamics tuning (plus the custom Bright profile). The convolver **FIR** they use
is Dolby's proprietary speaker correction, so it is not shipped;
`install/install-dolby-speakers.sh` and section 10 show how to generate it from
the Dolby driver on your own machine.

The **display ICC profile** in `color/` is mirrored from NotebookCheck's X12
review (their measurement, profiled with X-Rite i1Profiler) so it does not get
lost to link rot. See `color/README.md` for the source link and credit.

## Safety

These steps touch the boot chain, firmware-visible keyboard settings, kernel
modules and partitions. Read each section before running it, keep a backup, and
take a snapshot first (`bin/create_snapshot`). Use at your own risk.

## License

MIT for the scripts and documentation (see [LICENSE](LICENSE)). The files under
`patches/` are diffs against upstream projects and remain under those projects'
licenses when applied.

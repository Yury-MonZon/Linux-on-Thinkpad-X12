## 7. LTE modem (Fibocom L850-GL) and GPS

### Situation

- WWAN models have a Fibocom L850-GL (Intel XMM7360, PCI ID `8086:7360`) on PCIe.
- The in-kernel `iosm` driver binds it and creates `wwan0` (network), `wwan0at0`, `wwan0at1` (AT) and `wwan0xmmrpc0` (RPC).
- ModemManager 1.24.x (current repo version) stops with "Intel XMM7360 in RPC mode not supported".
  Support arrived in the 1.25 development series (1.25.95 or newer; 1.26 stable once released).
- The modem is FCC-locked: until unlocked, enabling fails with "Modem is FCC locked."
- SIM: one nano-SIM tray on the side. There is no eSIM inside the modem (no second SIM slot: `AT+GTDUALSIM` is not supported).
  Lenovo's eSIM option was a removable Gemalto eUICC card in the tray; a third-party removable eSIM card can replace it
  (managing its profiles through the modem: see "Removable eSIM card (9eSIM) with lpac" below).
- The antennas run along the top (camera) edge; GPS shares the WWAN antennas.

### Install ModemManager 1.25.95 (no library downgrade)

The AUR package `modemmanager-dev` depends on `libmbim-dev`/`libqmi-dev`, which are older than the repo `libmbim` 1.34 / `libqmi` 1.38.
ModemManager only needs libmbim >= 1.32 and libqmi >= 1.37.95, so build it against the repo libraries.
The build also adds [`patches/modemmanager-xmm-signal-quality.patch`](../patches/modemmanager-xmm-signal-quality.patch)
(a realistic signal percentage on LTE, see "Mobile signal" below), made against ModemManager commit `61e2f69d` (the AUR package's `_commit`):

```
git clone https://aur.archlinux.org/modemmanager-dev.git
cd modemmanager-dev
cp /path/to/Linux-on-Thinkpad-X12/patches/modemmanager-xmm-signal-quality.patch .
sed -i -e 's/^  libmbim-dev$/  libmbim/' -e 's/^  libqmi-dev$/  libqmi/' \
       -e 's/^pkgrel=.*/pkgrel=2/' \
       -e 's|^source=(\(.*\))$|source=(\1 modemmanager-xmm-signal-quality.patch)|' \
       -e "s|^b2sums=('\([0-9a-f]*\)')$|b2sums=('\1' 'SKIP')|" PKGBUILD
printf '\nprepare() {\n  cd ModemManager\n  patch -Np1 -i "$srcdir/modemmanager-xmm-signal-quality.patch"\n}\n' >> PKGBUILD
makepkg -s --nocheck
sudo pacman -U libmm-glib-dev-*.pkg.tar.zst modemmanager-dev-*.pkg.tar.zst   # answer yes to replacing modemmanager/libmm-glib
sudo systemctl enable --now ModemManager
mmcli -L     # -> [Fibocom] L850 LTE Module
```

Undo: `sudo pacman -S modemmanager libmm-glib`.

### FCC unlock

ModemManager ships an unlock script for this modem but does not enable it by default (regulatory reasons). Enable it:

```
sudo ln -s /usr/share/ModemManager/fcc-unlock.available.d/8086:7360 /etc/ModemManager/fcc-unlock.d/8086:7360
sudo reboot                               # not 'systemctl restart ModemManager', see "Restarting ModemManager needs a reboot"
mmcli -m any | grep -E 'state|power'     # after the reboot: state: enabled, power state: on
```

The script needs `xxd` and performs the challenge/response unlock over `wwan0xmmrpc0`. It then runs automatically at every boot.

### Insert a SIM and connect

- Insert the SIM with the computer **powered off**. The modem does not notice a SIM inserted while running or asleep.
- Check: `mmcli -m any` (registration should become `home` or `roaming`), `mmcli -i any` (SIM details).
- Create the connection with the APN also set as the **initial EPS bearer** APN (and roaming allowed for a roaming or travel SIM):

  ```
  nmcli connection add type gsm ifname '*' con-name lte apn <your-apn> \
      gsm.initial-eps-bearer-configure yes gsm.initial-eps-bearer-apn <your-apn> \
      gsm.home-only no
  ```

  A connection made in GNOME Settings > Mobile Network lacks the initial EPS part; add it with
  `nmcli connection modify <name> gsm.initial-eps-bearer-configure yes gsm.initial-eps-bearer-apn <your-apn>` (and `gsm.home-only no` when roaming).

  Why: for this modem, ModemManager 1.25.95 sends the APN to the modem (RPC `UtaMsCallPsAttachApnConfigReq`) only when it sets the initial EPS bearer, never when connecting.
  Without it the modem refuses the data attach, and connecting fails with `Connecting timed out (waiting for attach-allowed)`, then `Serial command timed out` on every retry.
  With roaming not allowed it fails with `Registered in roaming network, and roaming not allowed`.
- After failed attempts the modem's RPC channel can stay stuck (`Serial command timed out` even with correct settings): fix the settings, then reboot.
  Tested here: after a reboot, a roaming eSIM profile (APN `globaldata`) connected on its own over LTE, at about 27 Mbit/s.

- "SIM wrong" / registration `denied` means the network rejects the SIM (for example an expired or inactive SIM), not a Linux problem.
  `sudo mmcli -m any --3gpp-scan` should still list the nearby networks, which proves the radio and antennas work.
- After power-on the modem stays at registration `idle` and does not search for a network on its own.
  An autoconnecting NetworkManager mobile connection registers it when it connects; without one (for example, to use a roaming SIM without data), register by hand:

  ```
  sudo mmcli -m any --3gpp-register-home     # automatic network selection; also registers when roaming
  ```

- After sleep, ModemManager re-detects the modem with a new number (`/Modem/1`, `/Modem/2`, ...), so use `mmcli -m any` rather than `-m 0`.
  Signal polling and GPS are off on the new modem object; turn them on again (Satellite and geoclue do this themselves).
  A brief s2idle sleep was survived fine here, and the modem even re-registered on its own.

### Mobile signal

- Without the patch, the signal percentage (`mmcli -m any`, GNOME's signal bars) is far too low on LTE:
  ModemManager takes it from `AT+CSQ`, where this modem puts the LTE RSRP on the old GSM RSSI scale,
  so a usable -100 dBm shows as about 22 % while data runs fine.
- `modemmanager-xmm-signal-quality.patch` (built in above) reads `AT+XCESQ?` instead and takes the worse of
  RSRP (-140 to -44 dBm) and SNR (-23 to 40 dB), each over its full 3GPP range: the way ModemManager already rates MBIM and QMI modems.
  Example: RSRP -101 dBm and SNR -3 dB give 31 %.
  Without LTE values (3G/2G, or `+XCESQ` fails) it falls back to the old `+CSQ` value.
- The percentage is still coarse. For real values, turn on signal polling (resets when ModemManager restarts):

  ```
  sudo mmcli -m any --signal-setup=3
  watch -n 3 mmcli -m any --signal-get
  ```

- How to read the LTE values:

  | Value | Good | Fair | Poor |
  |---|---|---|---|
  | RSRP (strength) | above -90 dBm | -90 to -105 dBm | below -110 dBm |
  | RSRQ (quality) | above -10 dB | -10 to -15 dB | below -15 dB |
  | s/n (SNR) | above 10 dB | 0 to 10 dB | below 0 dB |

- Position matters a lot: the antennas are along the top (camera) edge and the back is metal.
  Measured on the same spot and network: lying flat on a desk -99 to -110 dBm, SNR -3 to 0 dB; top edge toward the window -87 dBm, SNR 7 dB.
- Covering the top edge with a hand should change RSRP noticeably; if it does not, check the antenna cables (red = main, blue = auxiliary, under the screen).
- To compare with a phone, make sure both are on the same operator: different operators use different towers.

### GPS

- The modem has GPS (`gps-raw`, `gps-nmea`) and works without a SIM.
- Satellite (Flathub: `page.codeberg.tpikonen.satellite`) shows satellites, signal bars, fix and position, and records GPX tracks.
  It talks to ModemManager directly.
- CLI:

  ```
  mmcli -m any --location-enable-gps-raw --location-enable-gps-nmea
  watch -n 5 mmcli -m any --location-get
  mmcli -m any --location-disable-gps-nmea --location-disable-gps-raw   # when done, saves power
  ```

- Do not use `--location-set-gps-refresh-rate`: here it silently switched GPS off again.
- GPS and mobile signal together:

  ```
  watch -n 3 'mmcli -m any --signal-get | grep -E "rsrp|rsrq|s/n"; mmcli -m any --location-get | grep -E "GSV|GGA"'
  ```

  - `$GPGSV` (GPS), `$GLGSV` (GLONASS), `$GAGSV` (Galileo): satellites in view; the last number of each satellite group is its signal in dB (30+ is good).
  - `$GNGGA`: field 7 is the fix (0 = none, 1 = fix), field 8 the number of satellites used; coordinates appear in fields 3-6 once there is a fix.
- The local desktop user may read the location without sudo (polkit `allow_active`).
  Over SSH this fails with "not authorized for 'org.freedesktop.ModemManager1.Location'".
  To allow your user from any session, `/etc/polkit-1/rules.d/50-x12-modem-location.rules` (mode 644, applies immediately):

  ```js
  // ThinkPad X12: let <your-user> read the modem's GPS/location via ModemManager from any session (e.g. SSH).
  polkit.addRule(function(action, subject) {
      if (action.id == "org.freedesktop.ModemManager1.Location" && subject.user == "<your-user>") {
          return polkit.Result.YES;
      }
  });
  ```

- First fix from cold can take 5-15 minutes; keep the top edge toward the sky. Indoors, expect no fix.
  By a window it heard GPS and GLONASS satellites at 22-35 dB within minutes, but needs about 4 for a fix.

### Boot hangs with the modem enabled

Symptom (2026-11-02): the boot froze a few seconds in, at a different point each time (Plymouth spinner, "Virtual Console Setup", mounting `/boot` and `/home`), with a garbled screen and the fan at full, under the normal and the LTS kernel, leaving no log.
With Wireless WAN off in the BIOS it booted fine.

- Cause: the modem had no driver bound and was on runtime PM `auto` (the PCI rule in section 12), so it runtime-suspended and the firmware's RTD3 held it in reset; the system then hangs (see "Driver fix: hibernation with the modem on runtime PM auto" below for the mechanism).
  The modem is left without a driver when `iosm` cannot start it (it had logged "modem did not start, resetting it" at every boot that day, after a lot of failed attach and network-selection attempts), or when `iosm` is not loaded.
- Fix: keep the modem on `on`: `etc/udev/rules.d/80-x12-pci-runtime-pm.rules` skips it before the generic `auto` rule, and `iosm-x12` forbids runtime PM on a modem it could not start. With it, the same modem booted cleanly.
- Do not blacklist `iosm` to test the modem: with the rule on `auto`, that alone hangs the system every boot.
- If the boot hangs anyway: Wireless WAN off in the BIOS boots; it also cuts the card's power, which a power-off on AC does not.
- The hangs also came back on later boots with the modem on `on`, as a hard freeze (no watchdog report, Caps Lock dead) at random points, once with a second L850-GL card.
  A suspected cause: the modem keeps its power through a reboot and can still run the previous session, with the previous kernel's shared memory addresses; once the driver enables bus mastering it can write into memory the new kernel uses.
  The modem has no IOMMU protection by default here (its group is `identity`, the kernel's IOMMU is off unless `intel_iommu=on`).
  `iosm-x12` now clears bus mastering at shutdown and reboot (`.shutdown`), and at probe resets a modem still in an old session (crashed, or IPC state not `UNINIT`) before enabling bus mastering ("modem still in an old session ..., resetting it").
  Not yet confirmed to end the hangs.

  Debug boot entry used to look at a hang (no `quiet splash nowatchdog`; lockup and hung-task panics into EFI pstore; `iosm` debug messages), built from the current kernel and signed:

  ```
  tr ' ' '\n' < /etc/kernel/cmdline | grep -vxE 'quiet|nowatchdog|splash' | tr '\n' ' ' > /var/tmp/x12-debug-cmdline
  echo 'loglevel=7 ignore_loglevel plymouth.enable=0 printk.devkmsg=on softlockup_panic=1 nmi_watchdog=panic hung_task_panic=1 sysctl.kernel.panic_on_rcu_stall=1 panic=0 efi_pstore.pstore_disable=0 iosm.dyndbg=+p' | sudo tee -a /var/tmp/x12-debug-cmdline
  sudo mkinitcpio -k /boot/vmlinuz-linux-cachyos --cmdline /var/tmp/x12-debug-cmdline -U /boot/EFI/rescue/x12-debug.efi
  printf 'title   X12 debug (WWAN hang)\nefi     /EFI/rescue/x12-debug.efi\nsort-key zz-x12-debug\n' | sudo tee /boot/loader/entries/x12-debug.conf
  ```

  On the hangs seen here it printed nothing after the freeze: the whole machine stops, so the watchdogs and SysRq cannot run either.

### Restarting ModemManager needs a reboot

- ModemManager can set up this modem only once per power-on. After any restart of ModemManager
  (`systemctl restart`, a package upgrade, a crash, or `x12-esim` stopping it), its start fails:
  `Failed to complete init sequence: Serial command timed out`, then `modem is unusable`, and the kernel logs `iosm ... msg timeout`.
  Only a reboot brings mobile data back: at boot `iosm-x12` resets a modem still in an old session (see "Driver fix: a modem that does not start").
- ModemManager's XMM7360 code always runs the full RPC setup (`sms-init`, `cbs-init`, `net-open`, ...) and has no matching
  close or shutdown calls. On a modem that is already set up, the modem still answers those first calls exactly as on a fresh
  boot (byte-identical success replies), but the first call after `net-open` never gets an answer.
  With `net-set-radio-signal-reporting` removed from the sequence, the next call (`call-cs-init`) hung instead.
- Calls tried after stopping ModemManager, before starting it again (`UtaModeSetReq` mode 0, `UtaMsNetPowerDownReq`, `UtaBootPrepareShutdownReq`):
  mode 0 is refused, net-power-down crashes the modem firmware, and boot-prepare-shutdown is accepted but the next start still hangs.
  The older `xmm7360-pci` project had the same limit: its example reset the modem through ACPI `_RST` before every new setup.
- The way ModemManager stops does not matter. Upstream ModemManager (main, checked 2026-11-03) runs the same setup sequence.

### Do not send raw AT commands to the modem

- Stopping ModemManager and talking to `/dev/wwan0at1` directly upset this modem every time it was tried here:
  - `AT+CFUN=0` crashed the modem firmware (kernel: `iosm ... confused phase`, `PORT open refused, phase A-CD_READY`).
    The next suspend then froze the whole system; only a forced power-off recovered it.
  - Even read-only queries and a network scan left the modem stuck afterwards (`iosm ... msg timeout`, ModemManager "modem is unusable").
- Use `mmcli` only.
  If the modem gets stuck, reboot: with `iosm-x12`, the driver resets a modem that has crashed or does not answer at probe (see below);
  a crashed modem is also reset when something opens it again, for example switching mobile off and on in GNOME.
  Do not reload or unbind `iosm` instead: with no driver bound to the modem the laptop has frozen here.
  Powering off does not always help: on AC the card keeps its power, and its firmware stays crashed.

### Removable eSIM card (9eSIM) with lpac

A removable eSIM card (9eSIM, 5ber, eSTK.me and similar) in the SIM tray can be managed through the modem with [lpac](https://github.com/estkme-group/lpac) and its AT driver, but stock lpac does not work with this modem:

- The XMM7360 answers `AT+CGLA` with only the status word (`+CGLA: 4,"9000"`) when the APDU has no Le byte.
  lpac sends the ES10 commands without Le, so every command comes back empty and lpac fails with `es10c_get_eid`.
  With `00` appended the same command returns the data (`+CGLA: 46,"BF3E125A10<EID>9000"`).
- `lpac driver apdu list` only looks in `/dev/serial/by-id`, so EasyLPAC never offers `/dev/wwan0at*`.

[`patches/lpac-xmm7360-le.patch`](../patches/lpac-xmm7360-le.patch) fixes both (against lpac 2.3.0): it appends Le=00 to case-3 APDUs and also lists the WWAN AT ports.
Build the AUR package with it:

```
git clone https://aur.archlinux.org/lpac.git
cd lpac
cp /path/to/Linux-on-Thinkpad-X12/patches/lpac-xmm7360-le.patch .
sed -i -e 's/^pkgrel=.*/pkgrel=2/' \
       -e 's|^source=(\(.*\))|source=(\1 lpac-xmm7360-le.patch)|' \
       -e "s|^sha256sums=('\([0-9a-f]*\)')|sha256sums=('\1' 'SKIP')|" PKGBUILD
printf '\nprepare() {\n    cd "$pkgbase"\n    patch -Np1 -i "$srcdir/lpac-xmm7360-le.patch"\n}\n' >> PKGBUILD
makepkg -si
```

[`bin/x12-esim`](../bin/x12-esim) (install to `/usr/local/bin`, mode 755) wraps this.
It checks that the installed lpac has the patch, waits for ModemManager to finish bringing the modem up, stops it, gives lpac a time limit, and prints readable results.
It leaves ModemManager stopped: **reboot afterwards** to use mobile data again (see below).

```
x12-esim info                                        # EID, free memory
x12-esim list                                        # ICCID, state, provider, nickname
x12-esim download 'LPA:1$<smdp-address>$<matching-id>' [confirmation-code]   # single quotes: the code contains $
x12-esim enable <iccid>                              # also: disable, delete
x12-esim nickname <iccid> <name>
```

`info`, `list`, `download` and `enable` were tested with the script; the other commands pass straight through to lpac.

Reboot after every eSIM session:

- After lpac has used the AT port, the modem stops answering ModemManager until a reboot
  (`Serial command timed out`, `modem is unusable`, kernel `iosm ... msg timeout`). Starting ModemManager again does not help:
  ModemManager cannot set up the modem a second time (see "Restarting ModemManager needs a reboot").
- The modem reads the SIM only at power-up, so an enabled or switched profile takes effect only after a reboot.
  Before it, the modem still reports the old profile (or the placeholder SIM).
  If a reboot does not pick it up, power off with the charger unplugged: on AC the modem card keeps its power.

Deleting a profile you no longer use:

```
x12-esim list                 # find its ICCID
x12-esim disable <iccid>      # only if its state is "enabled"
x12-esim delete <iccid>
```

- The card refuses to delete the enabled profile: disable it first, or enable another one (which disables the current one).
- Deleting is permanent. Most providers do not allow the same profile to be downloaded again, so a new activation code is needed. To keep a profile for later, only disable it.

Without the script (the AT ports are root-only, and ModemManager must not use the port at the same time):

```
sudo systemctl stop ModemManager
export LPAC_APDU=at LPAC_APDU_AT_DEVICE=/dev/wwan0at1
sudo -E lpac chip info                  # EID, free memory
sudo -E lpac profile list
sudo -E lpac profile download -a 'LPA:1$<smdp-address>$<matching-id>'   # single quotes: the code contains $
sudo -E lpac profile enable <iccid>
sudo reboot                             # not 'systemctl start ModemManager': the modem needs a reboot
```

- Tested here with a 9eSIM card: `chip info`, `profile list` and a download attempt (which reached the SM-DP+ server and authenticated the card) ran cleanly, with no `iosm` errors.
- The warnings in the previous section still apply: keep ModemManager stopped for the whole eSIM session rather than stopping and starting it around each command, and do not send other raw AT commands.
  Manual AT probing (`AT+CSIM`, logical channels) while ModemManager was being restarted around it crashed the modem firmware here (`msg timeout`, then `PORT open refused, phase A-CD_READY`), and the system hung soon after.
- With a profile-less card the modem reports a placeholder SIM (ICCID `89111111111111111111`, IMSI `111111111111111`); that is normal.
- `es9p_authenticate_client: EID doesn't match the expected value, or there is no pending RSP session` comes from the provider's server, not lpac:
  the activation code is bound to another device's EID or was already used. Ask the provider to reissue it for the card's EID.

### Driver fix: suspend and resume error handling

The X12 firmware enables WWAN power management (`\_SB.PC00.RP01._S0W` returns 4), so `iosm` runs a sleep handshake with the modem on every suspend.
When the modem does not answer, as after the firmware crash above, the driver mishandles it:

1. A handshake that times out leaves the driver's host power state at "waiting to sleep".
   Every later resume and suspend then refuses to run, and every message to the modem is held back for good, so the modem is dead until a reboot.
2. The suspend callback ignores the handshake result and always reports success.
3. An interrupted wait counts as a successful one (`wait_for_completion_interruptible_timeout` returns a negative number).
4. The wait reuses its completion without resetting it, so a late answer from one suspend can fake success for the next.
5. The BIOS power mode answer (`_DSM`) is read as an integer without checking its type.

None of these triggered in normal use here; they matter once the modem stops answering.
`iosm-x12` (section 13) fixes all five, a modem that does not start, and hibernation with runtime PM on the modem (below).
A suspend still goes ahead when the modem does not answer (blocking it would keep the laptop awake in a bag); the driver logs "CP did not enter host sleep" instead.

### Driver fix: a modem that does not start

The firmware does not cut the modem's power on a restart, nor on a shutdown while on AC.
The modem keeps running, often with its firmware crashed (iosm phase `CD_READY`, a core dump waiting), and the next boot finds it unusable:

- In the run phase, the modem does not answer the driver's IPC init request: `iosm ... A-RUN: ipc_status(0) ne. IPC_MEM_DEVICE_IPC_INIT`, and ModemManager finds no modem.
- In the crash phases, the driver only logs "reset Modem to collect CD" at debug level and binds without resetting anything.
  Nothing collects the core dump either: the devlink interface for that is only registered when the modem boots into its BOOT stage.

Either way the modem stayed dead until its power was really cut, which on the X12 only happened when a hibernation hang forced a power-off.
On 2026-10-23 that was every boot for half a day.

`iosm-x12` makes both cases fail the driver's init, and probe then resets the modem with `pci_reset_function_locked()` and tries once more.
On the X12 that is the firmware's ACPI `_RST` for the WWAN slot (`reset_method`: `acpi bus`), which restarts the modem firmware.
After the reset the modem boots into its BOOT stage and reaches the run phase about 14 s later:

```
iosm 0000:08:00.0: A-RUN: ipc_status(0) ne. IPC_MEM_DEVICE_IPC_INIT
iosm 0000:08:00.0: failed to initialize the imem
iosm 0000:08:00.0: modem did not start, resetting it
iosm 0000:08:00.0: resetting
iosm 0000:08:00.0: reset done
wwan wwan0: port wwan0xmmrpc0 attached
```

The same by hand, without the fix: `echo 0000:08:00.0 > /sys/bus/pci/drivers/iosm/unbind`, `echo 1 > /sys/bus/pci/devices/0000:08:00.0/reset`, `echo 0000:08:00.0 > /sys/bus/pci/drivers/iosm/bind`.

### Driver fix: the mobile switch in GNOME crashes the modem

- GNOME's Mobile Network switch makes NetworkManager soft-block every WWAN rfkill, including the ThinkPad one (`tpacpi_wwan_sw`).
  thinkpad_acpi passes it to the firmware's `HKEY.SWAN`, which only drives GPIO pad `0x0908000F` (not the card's power or reset pins,
  which `_RST` drives): most likely the slot's `W_DISABLE#`. The card keeps its power and stays on the PCIe bus.
- About 0.25 s later the modem firmware has crashed: `iosm` reports `IOSM_EVENT=CD_READY`, before ModemManager has sent it anything;
  ModemManager's own power-down (`+CFUN=4`) then times out after 30 s ("failed setting power state 'low'").
- Switching on again cannot work: `iosm` refuses every port open of a crashed modem (`PORT open refused, phase A-CD_READY`),
  and ModemManager and NetworkManager retry thousands of times a second (several CPU cores busy, the journal flooded)
  until the switch goes off again or the system reboots.

`iosm-x12` recovers a crashed modem the way a reboot does: when a port open is refused because the modem crashed,
it rebinds the driver (`device_reprobe()`, from a work item that remove does not wait for), and probe resets the modem (see above).
That happens when the switch goes on again, after `W_DISABLE#` is released; at most once per 30 s, and the refusal message is rate-limited.
Measured on 2026-11-04, switching on about 20 s after switching off:

```
22:20:34.16 iosm 0000:08:00.0: PORT open refused, phase A-CD_READY
22:20:34.16 iosm 0000:08:00.0: modem crashed, resetting it
22:20:34.22 iosm 0000:08:00.0: modem still in an old session (stage BADC0DED, IPC state 2), resetting it
22:20:34.84 iosm 0000:08:00.0: reset done
22:21:03    ModemManager: creating modem with plugin 'Intel' (its usual port probing takes about 20 s)
22:21:28    NetworkManager: mobile data connected
```

ModemManager failed to enable twice in that minute instead of looping. Off for longer than 30 s, data is back about 50 s after switching on.

### Driver fix: hibernation with the modem on runtime PM "auto"

With `power/control` set to `auto` on the modem, hibernation hung the system with a garbled frozen screen, and the modem firmware was crashed afterwards.
Section 12's rule now keeps the modem on `on` anyway: the same mechanism (an unbound modem runtime-suspending) also hangs the boot when `iosm` cannot start the modem, see "Boot hangs" below.

- Before hibernating, `iosm` unregisters its PCI driver (`pm_notify` on `PM_HIBERNATION_PREPARE`) and registers it again afterwards.
  Upstream added that in 2025 (commit `0b6f6593aa8c`): after a restore the modem is back in its bootloader and needs a full relaunch, which the driver cannot do without a large rewrite.
- Unbinding drops the runtime PM reference the PCI core holds for a bound driver, so with `auto` the unbound modem runtime suspends and its root port `00:1c.0` follows.
  The firmware's RTD3 power resource (`\_SB.PC00.RP01.PXP`) then holds the modem in reset and asserts `FULL_CARD_POWER_OFF#`.
  The card's 3.3 V supply is not switched: on the board, `VCC3B_WWAN` is `VCC3B` through a 0 Ω jumper (R4501).
- The hibernation freeze resumes the root port, which releases the reset and power-off pins, but leaves the unbound modem in runtime suspend (`pci_pm_freeze()` only resumes devices that have a driver).
  The PCI core's view of the modem no longer matches the hardware, and the system hangs.

Tests on 2026-10-23, with the kernel's hibernation test mode (`pm_test=devices`):

| iosm | Modem | Root port | Result |
|---|---|---|---|
| unbound | runtime suspended, powered off | runtime suspended | hang (also with `iosm` not involved at all) |
| unbound | runtime suspended, still powered | kept `on` | passes |
| unbound, powered off and back on at runtime (no hibernation) | | | works, also 0.3 s apart |
| `iosm-x12`, normal unbind and rebind | `auto` | `auto` | passes; a real hibernate and resume too |

`iosm-pm.patch` keeps the modem runtime-active while the driver is unregistered for hibernation (`pm_runtime_get_sync()` before unregistering, `pm_runtime_put()` after registering again), so the root port never powers it off.
The PCI core part (an unbound, runtime-suspended device left suspended while its parent is resumed at freeze) is a separate upstream report.

`kernel-fixes/iosm-pm.patch` (in `kernel-fixes-x12`, section 13):

```diff
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_imem.c work/iosm_ipc_imem.c
--- a/iosm_ipc_imem.c
+++ b/iosm_ipc_imem.c
@@ -259,7 +259,7 @@
 	return hpda_pending;
 }
 
-void ipc_imem_ipc_init_check(struct iosm_imem *ipc_imem)
+bool ipc_imem_ipc_init_check(struct iosm_imem *ipc_imem)
 {
 	int timeout = IPC_MODEM_BOOT_TIMEOUT;
 
@@ -281,7 +281,7 @@
 			ipc_doorbell_fire(ipc_imem->pcie, IPC_DOORBELL_IRQ_IPC,
 					  IPC_MEM_DEVICE_IPC_RUNNING);
 
-			return;
+			return true;
 		}
 		msleep(20);
 	} while (--timeout);
@@ -292,6 +292,7 @@
 		ipc_mmio_get_ipc_state(ipc_imem->mmio));
 
 	ipc_uevent_send(ipc_imem->dev, UEVENT_MDM_TIMEOUT);
+	return false;
 }
 
 /* Analyze the packet type and distribute it. */
@@ -1031,9 +1032,9 @@
 	return NULL;
 }
 
-void ipc_imem_pm_suspend(struct iosm_imem *ipc_imem)
+bool ipc_imem_pm_suspend(struct iosm_imem *ipc_imem)
 {
-	ipc_protocol_suspend(ipc_imem->ipc_protocol);
+	return ipc_protocol_suspend(ipc_imem->ipc_protocol);
 }
 
 void ipc_imem_pm_s2idle_sleep(struct iosm_imem *ipc_imem, bool sleep)
@@ -1305,9 +1306,13 @@
 		/* Verify the exepected initial state. */
 		if (ipc_imem->ipc_requested_state ==
 		    ipc_mmio_get_ipc_state(ipc_imem->mmio)) {
-			ipc_imem_ipc_init_check(ipc_imem);
-
-			return 0;
+			/* A modem in the run phase that does not answer will
+			 * not start: fail, so the caller can reset it.
+			 */
+			if (ipc_imem_ipc_init_check(ipc_imem) ||
+			    phase != IPC_P_RUN)
+				return 0;
+			break;
 		}
 		dev_err(ipc_imem->dev,
 			"ipc_status(%d) != IPC_MEM_DEVICE_IPC_UNINIT",
@@ -1315,10 +1320,11 @@
 		break;
 	case IPC_P_CRASH:
 	case IPC_P_CD_READY:
-		dev_dbg(ipc_imem->dev,
-			"Modem is in phase %d, reset Modem to collect CD",
-			phase);
-		return 0;
+		/* Nothing resets the modem from here and it stays unusable:
+		 * fail, so the caller can reset it.
+		 */
+		dev_warn(ipc_imem->dev, "modem crashed (phase %d)", phase);
+		break;
 	default:
 		dev_err(ipc_imem->dev, "unexpected operation phase %d", phase);
 		break;
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_imem.h work/iosm_ipc_imem.h
--- a/iosm_ipc_imem.h
+++ b/iosm_ipc_imem.h
@@ -401,8 +401,10 @@
  * ipc_imem_pm_suspend - The HAL shall ask the shared memory layer
  *			 whether D3 is allowed.
  * @ipc_imem:	Pointer to imem data-struct
+ *
+ * Returns: true if CP accepted host sleep, false otherwise.
  */
-void ipc_imem_pm_suspend(struct iosm_imem *ipc_imem);
+bool ipc_imem_pm_suspend(struct iosm_imem *ipc_imem);
 
 /**
  * ipc_imem_pm_resume - The HAL shall inform the shared memory layer
@@ -562,7 +564,7 @@
  *			     set CP to runtime with the context information
  * @ipc_imem:	Pointer to imem data-struct
  */
-void ipc_imem_ipc_init_check(struct iosm_imem *ipc_imem);
+bool ipc_imem_ipc_init_check(struct iosm_imem *ipc_imem);
 
 /**
  * ipc_imem_channel_init - Initialize the channel list with UL/DL pipe pairs.
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_imem_ops.c work/iosm_ipc_imem_ops.c
--- a/iosm_ipc_imem_ops.c
+++ b/iosm_ipc_imem_ops.c
@@ -290,8 +290,11 @@
 
 	/* The PORT interface is only supported in the runtime phase. */
 	if (ipc_imem_phase_update(ipc_imem) != IPC_P_RUN) {
-		dev_err(ipc_imem->dev, "PORT open refused, phase %s",
-			ipc_imem_phase_get_string(ipc_imem->phase));
+		dev_err_ratelimited(ipc_imem->dev, "PORT open refused, phase %s",
+				    ipc_imem_phase_get_string(ipc_imem->phase));
+		if (ipc_imem->phase == IPC_P_CRASH ||
+		    ipc_imem->phase == IPC_P_CD_READY)
+			ipc_pcie_recover(ipc_imem->pcie);
 		return NULL;
 	}
 
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_pcie.c work/iosm_ipc_pcie.c
--- a/iosm_ipc_pcie.c
+++ b/iosm_ipc_pcie.c
@@ -6,6 +6,7 @@
 #include <linux/acpi.h>
 #include <linux/bitfield.h>
 #include <linux/module.h>
+#include <linux/pm_runtime.h>
 #include <linux/suspend.h>
 #include <net/rtnetlink.h>
 
@@ -20,6 +21,8 @@
 static guid_t wwan_acpi_guid = GUID_INIT(0xbad01b75, 0x22a8, 0x4f48, 0x87, 0x92,
 				       0xbd, 0xde, 0x94, 0x67, 0x74, 0x7d);
 static bool pci_registered;
+/* The modem kept runtime-active while the driver is unregistered for hibernation */
+static struct pci_dev *hibernation_pdev;
 
 static void ipc_pcie_resources_release(struct iosm_pcie *ipc_pcie)
 {
@@ -115,8 +118,9 @@
 		goto irq_acquire_fail;
 	}
 
-	/* Enable bus-mastering for the IOSM IPC device. */
-	pci_set_master(pci);
+	/* Bus mastering is enabled by the caller, once the modem is known not
+	 * to run a previous session.
+	 */
 
 	/* Enable LTR if possible
 	 * This is needed for L1.2!
@@ -244,7 +248,8 @@
 		goto default_ret;
 	}
 
-	object = acpi_evaluate_dsm(handle_acpi, &wwan_acpi_guid, 0, 3, NULL);
+	object = acpi_evaluate_dsm_typed(handle_acpi, &wwan_acpi_guid, 0, 3,
+					 NULL, ACPI_TYPE_INTEGER);
 	if (!object)
 		goto default_ret;
 
@@ -257,6 +262,88 @@
 	return sleep_state;
 }
 
+/* Reset the modem function (the platform reset of the WWAN slot), which
+ * restarts the modem firmware. Bus mastering is turned off first and stays
+ * off; the PCI resources are released around the reset and requested again.
+ * On failure no resources are held. Called from probe with the device lock
+ * held.
+ */
+static int ipc_pcie_reset(struct iosm_pcie *ipc_pcie)
+{
+	struct pci_dev *pci = ipc_pcie->pci;
+	int ret;
+
+	pci_clear_master(pci);
+	ipc_pcie_resources_release(ipc_pcie);
+
+	ret = pci_reset_function_locked(pci);
+	if (ret) {
+		dev_err(ipc_pcie->dev, "modem reset failed: %d", ret);
+		return ret;
+	}
+
+	if (ipc_pcie_resources_request(ipc_pcie))
+		return -EIO;
+
+	return 0;
+}
+
+/* A modem that kept its power through a reboot can still run its previous
+ * session: with the shared memory addresses of the previous kernel, it must
+ * not get bus mastering, or it writes into memory this kernel now uses.
+ * A modem started for this probe reports the IPC state UNINIT.
+ * Returns true if it has to be reset first.
+ */
+static bool ipc_pcie_modem_in_old_session(struct iosm_pcie *ipc_pcie)
+{
+	enum ipc_mem_device_ipc_state state;
+	enum ipc_mem_exec_stage stage;
+	struct iosm_mmio *mmio;
+	bool old;
+
+	mmio = ipc_mmio_init(ipc_pcie->scratchpad, ipc_pcie->dev);
+	if (!mmio)
+		return false;	/* unknown, left to the normal start */
+
+	stage = ipc_mmio_get_exec_stage(mmio);
+	state = ipc_mmio_get_ipc_state(mmio);
+	kfree(mmio);
+
+	old = stage == IPC_MEM_EXEC_STAGE_CRASH ||
+	      stage == IPC_MEM_EXEC_STAGE_CD_READY ||
+	      (stage == IPC_MEM_EXEC_STAGE_RUN &&
+	       state != IPC_MEM_DEVICE_IPC_UNINIT);
+	if (old)
+		dev_warn(ipc_pcie->dev,
+			 "modem still in an old session (stage %X, IPC state %d), resetting it",
+			 stage, state);
+
+	return old;
+}
+
+/* A modem that kept its power through a reboot keeps running its previous
+ * session and does not answer the IPC init request. Resetting the function
+ * restarts the modem firmware. Called from probe with the device lock held.
+ */
+static int ipc_pcie_reset_retry(struct iosm_pcie *ipc_pcie)
+{
+	struct pci_dev *pci = ipc_pcie->pci;
+
+	if (ipc_pcie_reset(ipc_pcie))
+		return -EIO;
+
+	pci_set_master(pci);
+
+	ipc_pcie->imem = ipc_imem_init(ipc_pcie, pci->device,
+				       ipc_pcie->scratchpad, ipc_pcie->dev);
+	if (!ipc_pcie->imem) {
+		ipc_pcie_resources_release(ipc_pcie);
+		return -EIO;
+	}
+
+	return 0;
+}
+
 static int ipc_pcie_probe(struct pci_dev *pci,
 			  const struct pci_device_id *pci_id)
 {
@@ -312,20 +399,31 @@
 	if (ipc_pcie_resources_request(ipc_pcie))
 		goto resources_req_fail;
 
+	if (ipc_pcie_modem_in_old_session(ipc_pcie) && ipc_pcie_reset(ipc_pcie))
+		goto resources_req_fail;
+
+	/* Enable bus-mastering for the IOSM IPC device. */
+	pci_set_master(pci);
+
 	/* Establish the link to the imem layer. */
 	ipc_pcie->imem = ipc_imem_init(ipc_pcie, pci->device,
 				       ipc_pcie->scratchpad, ipc_pcie->dev);
 	if (!ipc_pcie->imem) {
-		dev_err(ipc_pcie->dev, "failed to init imem");
-		goto imem_init_fail;
+		dev_warn(ipc_pcie->dev, "modem did not start, resetting it");
+		if (ipc_pcie_reset_retry(ipc_pcie)) {
+			dev_err(ipc_pcie->dev, "failed to init imem");
+			goto resources_req_fail;
+		}
 	}
 
 	return 0;
 
-imem_init_fail:
-	ipc_pcie_resources_release(ipc_pcie);
 resources_req_fail:
 set_mask_fail:
+	/* An unbound modem must not runtime-suspend: its root port follows,
+	 * the platform's RTD3 holds the card in reset, and the system hangs.
+	 */
+	pm_runtime_forbid(&pci->dev);
 	pci_disable_device(pci);
 pci_enable_fail:
 	kfree(ipc_pcie);
@@ -379,8 +477,14 @@
 
 int __maybe_unused ipc_pcie_suspend(struct iosm_pcie *ipc_pcie)
 {
-	/* The HAL shall ask the shared memory layer whether D3 is allowed. */
-	ipc_imem_pm_suspend(ipc_pcie->imem);
+	/* The HAL shall ask the shared memory layer whether D3 is allowed.
+	 * A modem that does not answer must not block system suspend, so
+	 * only report it.
+	 */
+	if (!ipc_imem_pm_suspend(ipc_pcie->imem)) {
+		dev_warn(ipc_pcie->dev, "CP did not enter host sleep");
+		return 0;
+	}
 
 	dev_dbg(ipc_pcie->dev, "SUSPEND done");
 	return 0;
@@ -441,10 +545,74 @@
 
 static SIMPLE_DEV_PM_OPS(iosm_ipc_pm, ipc_pcie_suspend_cb, ipc_pcie_resume_cb);
 
+/* A modem whose firmware crashed stays crashed until it is reset; on the
+ * X12 its W_DISABLE# line (the ThinkPad WWAN rfkill) crashes it. Recover it
+ * like a reboot does: rebind the driver, and probe resets the crashed modem.
+ * Triggered when a port is opened, so not while W_DISABLE# still holds it.
+ * The work item is not the driver's own, as remove cannot wait for a work
+ * that removes the driver; at most one recovery per RECOVER_INTERVAL.
+ */
+#define RECOVER_INTERVAL (30 * HZ)
+
+static DEFINE_SPINLOCK(recover_lock);
+static struct pci_dev *recover_pdev;
+static unsigned long recover_last;
+static bool recover_done_once;
+
+static void ipc_pcie_recover_work(struct work_struct *work)
+{
+	struct pci_dev *pci;
+	int ret;
+
+	spin_lock(&recover_lock);
+	pci = recover_pdev;
+	spin_unlock(&recover_lock);
+
+	if (pci) {
+		dev_warn(&pci->dev, "modem crashed, resetting it");
+		ret = device_reprobe(&pci->dev);
+		if (ret)
+			dev_err(&pci->dev, "modem recovery failed: %d", ret);
+		pci_dev_put(pci);
+	}
+
+	spin_lock(&recover_lock);
+	recover_pdev = NULL;
+	spin_unlock(&recover_lock);
+}
+
+static DECLARE_WORK(recover_work, ipc_pcie_recover_work);
+
+void ipc_pcie_recover(struct iosm_pcie *ipc_pcie)
+{
+	spin_lock(&recover_lock);
+	if (recover_pdev || (recover_done_once &&
+			     time_before(jiffies, recover_last + RECOVER_INTERVAL))) {
+		spin_unlock(&recover_lock);
+		return;
+	}
+	recover_pdev = pci_dev_get(ipc_pcie->pci);
+	recover_last = jiffies;
+	recover_done_once = true;
+	spin_unlock(&recover_lock);
+
+	schedule_work(&recover_work);
+}
+
+/* The modem keeps its power through a reboot and would go on running this
+ * session with this kernel's shared memory addresses. Stop it writing to
+ * memory; the next probe finds it in the old session and resets it.
+ */
+static void ipc_pcie_shutdown(struct pci_dev *pci)
+{
+	pci_clear_master(pci);
+}
+
 static struct pci_driver iosm_ipc_driver = {
 	.name = KBUILD_MODNAME,
 	.probe = ipc_pcie_probe,
 	.remove = ipc_pcie_remove,
+	.shutdown = ipc_pcie_shutdown,
 	.driver = {
 		.pm = &iosm_ipc_pm,
 	},
@@ -532,10 +700,31 @@
 	dev_kfree_skb(skb);
 }
 
+static int ipc_pcie_hold_active(struct device *dev, void *_unused)
+{
+	/* Unbinding the driver drops the runtime PM reference the PCI core
+	 * holds for it. If user space allowed runtime PM (power/control =
+	 * auto), the unbound modem then runtime suspends, its root port
+	 * follows, and with WWAN RTD3 the platform asserts reset and
+	 * FULL_CARD_POWER_OFF#. The hibernation freeze then resumes the root
+	 * port, which releases them, but does not resume the unbound modem,
+	 * so the PCI core's view of it no longer matches the hardware; on
+	 * the ThinkPad X12 that hangs the system. Keep the modem active
+	 * until the driver is registered again.
+	 */
+	pm_runtime_get_sync(dev);
+	hibernation_pdev = pci_dev_get(to_pci_dev(dev));
+
+	return 1;	/* one modem */
+}
+
 static int pm_notify(struct notifier_block *nb, unsigned long mode, void *_unused)
 {
 	if (mode == PM_HIBERNATION_PREPARE || mode == PM_RESTORE_PREPARE) {
 		if (pci_registered) {
+			if (driver_for_each_device(&iosm_ipc_driver.driver, NULL,
+						   NULL, ipc_pcie_hold_active) < 0)
+				pr_warn(KBUILD_MODNAME ": modem may power off while unbound\n");
 			pci_unregister_driver(&iosm_ipc_driver);
 			pci_registered = false;
 		}
@@ -551,6 +740,11 @@
 				pci_registered = true;
 			}
 		}
+		if (hibernation_pdev) {
+			pm_runtime_put(&hibernation_pdev->dev);
+			pci_dev_put(hibernation_pdev);
+			hibernation_pdev = NULL;
+		}
 	}
 
 	return 0;
@@ -578,6 +772,7 @@
 
 static void __exit iosm_ipc_driver_exit(void)
 {
+	cancel_work_sync(&recover_work);
 	unregister_pm_notifier(&pm_notifier);
 
 	if (pci_registered)
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_pcie.h work/iosm_ipc_pcie.h
--- a/iosm_ipc_pcie.h
+++ b/iosm_ipc_pcie.h
@@ -206,5 +206,12 @@
  * @ipc_pcie:	Pointer to struct iosm_pcie
  */
 void ipc_pcie_config_aspm(struct iosm_pcie *ipc_pcie);
+/**
+ * ipc_pcie_recover - Reset a modem whose firmware crashed
+ * @ipc_pcie:	Pointer to struct iosm_pcie
+ *
+ * Rebinds the driver from a work item; probe resets the crashed modem.
+ */
+void ipc_pcie_recover(struct iosm_pcie *ipc_pcie);
 
 #endif
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_pm.c work/iosm_ipc_pm.c
--- a/iosm_ipc_pm.c
+++ b/iosm_ipc_pm.c
@@ -73,6 +73,11 @@
 	bool ret_val = false;
 
 	if (ipc_pm->ap_state != IPC_MEM_DEV_PM_ACTIVE) {
+		/* Drop a completion left over from an earlier wait that timed
+		 * out just before CP answered.
+		 */
+		reinit_completion(&ipc_pm->host_sleep_complete);
+
 		/* Complete all memory stores before setting bit */
 		smp_mb__before_atomic();
 
@@ -84,9 +89,12 @@
 		/* Complete all memory stores after setting bit */
 		smp_mb__after_atomic();
 
-		if (!wait_for_completion_interruptible_timeout
-		   (&ipc_pm->host_sleep_complete,
-		    msecs_to_jiffies(IPC_PM_ACTIVE_TIMEOUT_MS))) {
+		/* CP may have become active before the bit was set, in which
+		 * case nobody completes the wait.
+		 */
+		if (ipc_pm->ap_state != IPC_MEM_DEV_PM_ACTIVE &&
+		    !wait_for_completion_timeout(&ipc_pm->host_sleep_complete,
+						 msecs_to_jiffies(IPC_PM_ACTIVE_TIMEOUT_MS))) {
 			dev_err(ipc_pm->dev,
 				"PM timeout. Expected State:%d. Actual: %d",
 				IPC_MEM_DEV_PM_ACTIVE, ipc_pm->ap_state);
diff --color -ruN -x '*.o' -x '*.ko' -x '*.mod' -x '*.mod.c' -x '.*' -x modules.order -x Module.symvers orig/iosm_ipc_protocol.c work/iosm_ipc_protocol.c
--- a/iosm_ipc_protocol.c
+++ b/iosm_ipc_protocol.c
@@ -177,7 +177,7 @@
 bool ipc_protocol_suspend(struct iosm_protocol *ipc_protocol)
 {
 	if (!ipc_pm_prepare_host_sleep(&ipc_protocol->pm))
-		goto err;
+		return false;
 
 	ipc_task_queue_send_task(ipc_protocol->imem,
 				 ipc_protocol_tq_wakeup_dev_slp, 0, NULL, 0,
@@ -191,20 +191,26 @@
 	/* Send the sleep message for sync sys calls. */
 	dev_dbg(ipc_protocol->dev, "send TARGET_HOST, ENTER_SLEEP");
 	if (ipc_protocol_msg_send_host_sleep(ipc_protocol,
-					     IPC_HOST_SLEEP_ENTER_SLEEP)) {
-		/* Sending ENTER_SLEEP message failed, we are still active */
-		ipc_protocol->pm.host_pm_state = IPC_MEM_HOST_PM_ACTIVE;
+					     IPC_HOST_SLEEP_ENTER_SLEEP))
 		goto err;
-	}
 
 	ipc_protocol->pm.host_pm_state = IPC_MEM_HOST_PM_SLEEP;
 	return true;
 err:
+	/* Host sleep was not entered, we are still active. Leaving the state
+	 * at SLEEP_WAIT_D3 would make every later resume and suspend fail
+	 * and hold back all doorbells to CP.
+	 */
+	ipc_protocol->pm.host_pm_state = IPC_MEM_HOST_PM_ACTIVE;
 	return false;
 }
 
 bool ipc_protocol_resume(struct iosm_protocol *ipc_protocol)
 {
+	/* Host sleep was not entered on suspend, so there is nothing to exit. */
+	if (ipc_protocol->pm.host_pm_state == IPC_MEM_HOST_PM_ACTIVE)
+		return true;
+
 	if (!ipc_pm_prepare_host_active(&ipc_protocol->pm))
 		return false;
 
```

```
install/install-kernel-fixes-x12.sh      # all four driver fixes, section 13
```

---

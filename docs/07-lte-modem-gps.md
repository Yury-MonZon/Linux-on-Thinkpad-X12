## 7. LTE modem (Fibocom L850-GL) and GPS

### Situation

- WWAN models have a Fibocom L850-GL (Intel XMM7360, PCI ID `8086:7360`) on PCIe.
- The in-kernel `iosm` driver binds it and creates `wwan0` (network), `wwan0at0`, `wwan0at1` (AT) and `wwan0xmmrpc0` (RPC).
- ModemManager 1.24.x (current repo version) stops with "Intel XMM7360 in RPC mode not supported".
  Support arrived in the 1.25 development series (1.25.95 or newer; 1.26 stable once released).
- The modem is FCC-locked: until unlocked, enabling fails with "Modem is FCC locked."
- SIM: one nano-SIM tray on the side. There is no eSIM inside the modem (no second SIM slot: `AT+GTDUALSIM` is not supported).
  Lenovo's eSIM option was a removable Gemalto eUICC card in the tray; a third-party removable eSIM card can replace it.
- The antennas run along the top (camera) edge; GPS shares the WWAN antennas.

### Install ModemManager 1.25.95 (no library downgrade)

The AUR package `modemmanager-dev` depends on `libmbim-dev`/`libqmi-dev`, which are older than the repo `libmbim` 1.34 / `libqmi` 1.38.
ModemManager only needs libmbim >= 1.32 and libqmi >= 1.37.95, so build it against the repo libraries:

```
git clone https://aur.archlinux.org/modemmanager-dev.git
cd modemmanager-dev
sed -i -e 's/^  libmbim-dev$/  libmbim/' -e 's/^  libqmi-dev$/  libqmi/' PKGBUILD
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
sudo systemctl restart ModemManager
mmcli -m any | grep -E 'state|power'     # state: enabled, power state: on
```

The script needs `xxd` and performs the challenge/response unlock over `wwan0xmmrpc0`. It then runs automatically at every boot.

### Insert a SIM and connect

- Insert the SIM with the computer **powered off**. The modem does not notice a SIM inserted while running or asleep.
- Check: `mmcli -m any` (registration should become `home` or `roaming`), `mmcli -i any` (SIM details).
- Create the connection in GNOME Settings > Mobile Network, or:

  ```
  nmcli connection add type gsm ifname '*' con-name lte apn <your-apn>
  ```

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

- The signal percentage in `mmcli -m any` is coarse. For real values, turn on signal polling (resets when ModemManager restarts):

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

### Do not send raw AT commands to the modem

- Stopping ModemManager and talking to `/dev/wwan0at1` directly upset this modem every time it was tried here:
  - `AT+CFUN=0` crashed the modem firmware (kernel: `iosm ... confused phase`, `PORT open refused, phase A-CD_READY`).
    The next suspend then froze the whole system; only a forced power-off recovered it.
  - Even read-only queries and a network scan left the modem stuck afterwards (`iosm ... msg timeout`, ModemManager "modem is unusable").
- Use `mmcli` only. If the modem gets stuck, **power off** (not Suspend, not Restart), wait 10 s, power on.

---

## 12. Sleep, hibernation and battery

### Suspend (s2idle)

- The X12 only offers s2idle (`cat /sys/power/mem_sleep` shows `[s2idle]`); there is no S3.
- With the fixes in this guide it spends 99% of the time asleep in the deepest idle state (S0ix) and draws about 0.2 W.
  Four suspends of about an hour each, on battery, used 130 to 220 mWh each.
  A full battery (35 Wh at 83% health) would last about a week.
- Before the rear camera fix in section 4, the sensor and its 19.2 MHz clock stayed powered through every suspend.
  Suspends then drew about 0.5 W.
- One night drained the battery from 59% to empty, at 2 W or more.
  The cause was never found, and it did not happen again.
  Suspend-then-hibernate below limits the damage if it does.

The numbers come from the sleep log below.

### Sleep log

`/usr/lib/systemd/system-sleep/x12-sleep-diag` (mode 755) logs one line before each sleep and one after each wake: time asleep, how much of it in deep sleep, battery used and average power.
systemd runs it right before the system sleeps and right after it wakes, so it cannot wake the system itself.

```bash
#!/bin/bash
# Sleep diagnostics: log battery, deep sleep (S0ix) residency, lid state and
# ACPI interrupt counts before each suspend, and the deltas after resume.
# Appends to /var/log/sleep-diag.log and the journal (tag sleep-diag).

LOG=/var/log/sleep-diag.log
STATE=/run/sleep-diag.pre

val() { local v; read -r v _ < "$1" 2>/dev/null && echo "$v" || echo 0; }

sample() {
    echo "$(date +%s)" \
        "$(val /sys/class/power_supply/BAT0/energy_now)" \
        "$(val /sys/kernel/debug/pmc_core/slp_s0_residency_usec)" \
        "$(val /sys/power/suspend_stats/total_hw_sleep)" \
        "$(val /sys/firmware/acpi/interrupts/sci)" \
        "$(val /sys/power/suspend_stats/success)" \
        "$(val /sys/power/suspend_stats/fail)"
}

emit() {
    echo "$(date '+%F %T') $*" >> "$LOG"
    logger -t sleep-diag -- "$*"
}

lid=$(awk '{print $2}' /proc/acpi/button/lid/LID/state 2>/dev/null)
status=$(val /sys/class/power_supply/BAT0/status)

case "$1" in
pre)
    s=$(sample)
    echo "$s" > "$STATE"
    read -r t e _ <<< "$s"
    emit "pre $2: battery $((e / 1000)) mWh ($status), lid $lid"
    ;;
post)
    [ -r "$STATE" ] || exit 0
    read -r t0 e0 s0 h0 i0 ok0 f0 < "$STATE"
    read -r t1 e1 s1 h1 i1 ok1 f1 <<< "$(sample)"
    dt=$((t1 - t0))
    deep=$(( (s1 - s0) / 1000000 ))
    used=$(( (e0 - e1) / 1000 ))
    watts=0
    # The PMC residency counter restarts after a power-off (hibernate)
    if [ "$s1" -lt "$s0" ] || [ "${SYSTEMD_SLEEP_ACTION:-$2}" = hibernate ]; then
        deep="deep n/a (counter reset by power-off)"
    elif [ "$dt" -gt 0 ]; then
        deep="deep ${deep}s ($((deep * 100 / dt))%)"
    else
        deep="deep ${deep}s"
    fi
    if [ "$dt" -gt 0 ]; then
        # energy is in uWh: W = dE * 3600 / (dt * 1e6)
        watts=$(awk -v d=$((e0 - e1)) -v t="$dt" 'BEGIN { printf "%.2f", d * 0.0036 / t }')
    fi
    emit "post $2: slept ${dt}s, ${deep}, used ${used} mWh (~${watts} W), sci +$((i1 - i0)), suspend ok +$((ok1 - ok0)) fail +$((f1 - f0)), battery $((e1 / 1000)) mWh ($status), lid $lid"
    ;;
esac
exit 0
```

Read it with `sudo cat /var/log/sleep-diag.log` or `journalctl -t sleep-diag`:

```
2026-10-10 17:02:57 pre suspend: battery 34060 mWh (Discharging), lid open
2026-10-10 18:15:01 post suspend: slept 4324s, deep 4318s (99%), used 220 mWh (~0.18 W), sci +250, suspend ok +1 fail +0, battery 33840 mWh (Discharging), lid open
```

- `deep` near 100%: deep sleep works. If it drew a lot of power anyway, the power went somewhere even in deep sleep.
- `deep` near 0%: something kept the system out of deep sleep.
  `sudo cat /sys/kernel/debug/pmc_core/substate_requirements` shows which blocks were not ready.
  To have the kernel log the blockers at the moment it happens, `etc/modprobe.d/pmc-core-x12.conf` turns on `intel_pmc_core`'s `warn_on_s0ix_failures`:

  ```
  sudo install -m644 etc/modprobe.d/pmc-core-x12.conf /etc/modprobe.d/
  echo Y | sudo tee /sys/module/intel_pmc_core/parameters/warn_on_s0ix_failures   # now, without a reboot
  journalctl -k -g "pmc_core|s0ix|SLP_S0"                                          # after a failed deep sleep
  ```

  It only adds log lines after a failed deep sleep.
- The watt figure is coarse for short sleeps: the battery reports in 10 mWh steps.
- After hibernation the counter starts again from 0, so the line says `deep n/a`.

### Hibernation

Hibernation saves memory to disk and powers off.
It needs real swap on disk: zram swap lives in RAM and is lost at power-off.

**1. Swap file.**
zram stays the main swap (priority 100); a 16 GB swap file (the size of RAM) on its own btrfs subvolume holds the hibernation image.
On its own subvolume, snapper's snapshots of `/` never include it.
Replace `<root-uuid>` with the UUID of the btrfs partition (`findmnt -no UUID /`):

```
sudo mount -o subvolid=5 UUID=<root-uuid> /mnt
sudo btrfs subvolume create /mnt/@swap
sudo umount /mnt
sudo mkdir /swap
```

Add to `/etc/fstab`:

```
UUID=<root-uuid> /swap          btrfs   subvol=/@swap,defaults,noatime 0 0
/swap/swapfile                            none           swap    defaults,pri=10 0 0
```

```
sudo systemctl daemon-reload
sudo mount /swap
sudo btrfs filesystem mkswapfile --size 16g --uuid clear /swap/swapfile
sudo swapon /swap/swapfile
swapon --show                                         # zram0 priority 100, /swap/swapfile priority 10
sudo btrfs inspect-internal map-swapfile -r /swap/swapfile    # prints <offset>
```

**2. Resume from it.**
Add to the kernel command line in `/etc/kernel/cmdline`:

```
resume=UUID=<root-uuid> resume_offset=<offset>
```

Rebuild the UKIs (section 1 signs them again) and reboot:

```
sudo mkinitcpio -P
```

The `systemd` hook in the initramfs handles the resume; nothing else is needed.
Hibernation needs a kernel without lockdown: `cat /sys/kernel/security/lockdown` shows `[none]` here, with Secure Boot on.

**3. Test:** `systemctl hibernate`, wait until it is off, then press power.
The session comes back as it was; about 40 s for the whole round trip.

What hibernation breaks, and the fixes:

| After hibernation | Fix |
|---|---|
| Rear camera black (firmware authentication, sensor clock) | `ipu6-x12` and `ov8856-x12` (section 4) |
| Front camera fails to open in camera apps | WirePlumber refresh below |
| Fn/Ctrl swap, FnLock and mute LEDs back to default | `hid-lenovo-x12` (section 2) |
| Keyboard backlight off | Folio backlight hook (section 2); it also covers suspend |

The modem driver (`iosm`) detaches itself before hibernation and attaches again afterwards; ModemManager finds the modem again.

### Suspend-then-hibernate

Every suspend (lid, power button, idle) sleeps normally first.
If it is still asleep after 2 hours on battery, it wakes briefly and hibernates.
On AC power it stays suspended.

`/etc/systemd/sleep.conf.d/x12-suspend-then-hibernate.conf`:

```
# ThinkPad X12: every suspend becomes suspend-then-hibernate (systemd-suspend.service
# points at systemd-suspend-then-hibernate.service). After 2 hours asleep the system
# wakes briefly and hibernates, so a bad night cannot drain the battery.
# On AC power it stays suspended.
[Sleep]
HibernateDelaySec=2h
HibernateOnACPower=no
```

GNOME asks for a plain suspend (lid, power button and idle), so changing logind's lid action is not enough.
Point `systemd-suspend.service` at the suspend-then-hibernate service instead:

```
sudo ln -s /usr/lib/systemd/system/systemd-suspend-then-hibernate.service /etc/systemd/system/systemd-suspend.service
sudo systemctl daemon-reload
systemctl cat systemd-suspend.service | grep ExecStart    # expect: systemd-sleep suspend-then-hibernate
```

Test with a short delay instead of 2 hours, on battery:

```
printf '[Sleep]\nHibernateDelaySec=60s\n' | sudo tee /etc/systemd/sleep.conf.d/zz-test.conf
systemctl suspend          # sleeps, wakes after 60 s, hibernates; press power to resume
sudo rm /etc/systemd/sleep.conf.d/zz-test.conf
journalctl -b -t sleep-diag | tail -4    # a suspend line, then a hibernate line
```

### Cameras after hibernation: WirePlumber refresh

Hibernation resets the USB front camera.
PipeWire's V4L2 source for it keeps its old state, and opening the camera can then fail ("use input buffers: -22" in the app's log).
Restarting WirePlumber recreates the camera nodes.

This cannot run from a `system-sleep` hook: user processes are still frozen there.
A service runs it after the resume has finished, and only when a hibernation actually happened, so plain suspends are untouched.

`/usr/local/bin/x12-camera-refresh` (mode 755):

```bash
#!/bin/bash
# ThinkPad X12: after hibernation the USB front camera is reset, and PipeWire's
# V4L2 source keeps its stale state (opening it can fail with "use input
# buffers: -22"). Restarting WirePlumber recreates the camera nodes.
# Runs after resume from the sleep targets; does nothing if no hibernation
# actually happened (suspend-then-hibernate that only suspended).

journalctl -k -b --since "-3min" --no-pager -q | grep -q "PM: hibernation: hibernation exit" || exit 0

for user in $(loginctl list-users --no-legend | awk '{print $2}'); do
    systemctl --user -M "$user@" is-active --quiet wireplumber.service || continue
    systemctl --user -M "$user@" restart wireplumber.service &&
        echo "restarted wireplumber for $user"
done
exit 0
```

`/etc/systemd/system/x12-camera-refresh.service`:

```ini
[Unit]
Description=ThinkPad X12: refresh PipeWire cameras after hibernation
After=suspend.target hibernate.target suspend-then-hibernate.target hybrid-sleep.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/x12-camera-refresh

[Install]
WantedBy=suspend.target hibernate.target suspend-then-hibernate.target hybrid-sleep.target
```

`suspend.target` is in the list because with the redirect above, the hibernation of a suspend-then-hibernate happens under it.

```
sudo systemctl daemon-reload
sudo systemctl enable x12-camera-refresh.service
```

Audio drops for about a second while WirePlumber restarts.

### Hibernate in the power menu

GNOME Shell 51 has no Hibernate entry, and the usual "Hibernate Status Button" extension stops at GNOME 48.
`home/.local/share/gnome-shell/extensions/hibernate-x12@monzon/` is a small extension that adds **Hibernate** below Suspend in the Quick Settings Power Off menu.
It asks logind `CanHibernate` each time the menu opens and shows the item only when the answer is `yes` (or `challenge`).
Clicking it calls logind's `Hibernate`; a failure shows a notification.

```
cp -r home/.local/share/gnome-shell/extensions/hibernate-x12@monzon ~/.local/share/gnome-shell/extensions/
gnome-extensions enable hibernate-x12@monzon    # or add it to org.gnome.shell enabled-extensions
```

GNOME Shell only finds a new extension at login, so log out and in once.
Without an extension, `gsettings set org.gnome.settings-daemon.plugins.power power-button-action 'hibernate'` makes the power button hibernate.

### Lazy RCU (idle power)

The kernel frees memory and does other housekeeping through RCU callbacks, and each batch wakes a CPU.
With lazy RCU (developed for ChromeOS and Android), callbacks that are not urgent wait and are batched, for up to about 10 s on a quiet system, so idle CPUs are woken less often.
The CachyOS kernel has it built in but off (`CONFIG_RCU_LAZY=y`, `CONFIG_RCU_LAZY_DEFAULT_OFF=y`), and it only works on CPUs whose callbacks are offloaded to kernel threads, so it needs two kernel options.

Add them to `/etc/kernel/cmdline`, rebuild the UKIs and reboot:

```
sudo sed -i 's|$| rcu_nocbs=all rcutree.enable_rcu_lazy=1|' /etc/kernel/cmdline
sudo mkinitcpio -P
```

After the reboot, `cat /sys/module/rcutree/parameters/enable_rcu_lazy` shows `Y`, and `sudo dmesg | grep "Offload RCU"` shows `Offload RCU callbacks from CPUs: 0-7`.

Measured on the X12 (i7-1160G7), on battery, Balanced profile, same brightness, screen on, idle, 3 runs of 60 s each:

| Idle | Without | With lazy RCU |
|---|---|---|
| 3 minutes after login: CPU package (RAPL) | 1.31 to 1.36 W | 1.20 to 1.23 W |
| 3 minutes after login: interrupts/s | 1030 to 1140 | 830 to 890 |
| Settled, 15 minutes after boot: CPU package | 0.35 to 0.38 W | 0.28 to 0.34 W |
| Settled, 15 minutes after boot: interrupts/s | 188 to 208 | 140 to 168 |

The settled runs had PCI runtime PM on in both cases (next section).
The CPU saves about 0.1 W while the desktop is still busy after login, and a few hundredths of a watt at settled idle; interrupts drop by about 20% in both cases.
The whole-laptop battery draw varies more between sessions than that (other devices and background apps), so the gain is small but real rather than a headline figure.
Sleep is not affected (nothing runs in s2idle).
Freed memory is returned a few seconds later, which is harmless; urgent RCU work is not delayed.
The frozen "Known good" boot entry keeps its own command line, without these options.

### PCI runtime power management (idle power)

By default about a dozen PCI devices are set to stay powered all the time (`power/control` = `on`): the host bridge, the camera unit, thermal, Thunderbolt parts, the I2C, SPI and SMBus controllers, the sensor hub and others.
`etc/udev/rules.d/80-x12-pci-runtime-pm.rules` lets all of them suspend when idle:

```
ACTION=="add|bind", SUBSYSTEM=="pci", ATTR{power/control}="auto"
```

It needs the `iosm-x12` driver fix (section 13) for the LTE modem; without it, keep the modem on `on` with the commented-out line in the rule (see below).

```
sudo install -m644 etc/udev/rules.d/80-x12-pci-runtime-pm.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=pci --action=bind
```

- Measured at settled idle (session up 15 minutes, screen on, on battery, Balanced): battery draw 2.18 to 2.39 W before, 2.07 to 2.13 W after, about 0.1 to 0.15 W less.
- 14 devices then sit in runtime suspend; Wi-Fi and the NVMe drive stay active while in use, as they should.
- Check: `grep -l '^on' /sys/bus/pci/devices/*/power/control` lists nothing.
- With the stock `iosm` driver, the LTE modem on `auto` hangs hibernation with a garbled screen; section 7 explains why, and `iosm-x12` fixes it (tested with the hibernation test mode and a real hibernate and resume, 2026-10-23).
  Found with the kernel's hibernation test mode, one device at a time (it runs the device part of hibernation and returns after 5 s, without writing an image):

  ```
  echo auto | sudo tee /sys/bus/pci/devices/<device>/power/control
  echo devices | sudo tee /sys/power/pm_test
  echo disk | sudo tee /sys/power/state          # returns after 5 s, or hangs
  echo none | sudo tee /sys/power/pm_test
  ```

  Every other device, including the five without a driver (host bridge, GNA, shared SRAM, eSPI bridge, SMBus), passed on its own, and all of them together without the modem passed too, followed by a real hibernate and resume.
  Two of the hangs ended in a Lenovo "BIOS self-healed" message at the next power-on; the BIOS settings and boot entries were unchanged.
  `pm_trace` did not help here: it named `memory48`, a false hash match.

Tried and not useful on the X12:

- `pcie_aspm.policy=powersupersave` (deepest PCIe link power states): writing the policy fails with "Operation not permitted". The BIOS keeps control of ASPM and does not hand it to Linux.
- Turning the LTE modem off while awake (`rfkill block wwan`, ModemManager stopped): no measurable difference; the `iosm` driver keeps the modem device active anyway.

### Notes

- For 30 s after a wake, logind ignores the lid (`HoldoffTimeoutSec`).
  Closing the lid again right after opening it suspends only when the 30 s are over.
- Opening the lid while a suspend is already starting does not cancel it.
- Never unbind a camera driver (for example `intel-ipu6`) while WirePlumber runs.
  WirePlumber's libcamera keeps the camera's device nodes open, and unbinding under it caused a kernel oops.

---

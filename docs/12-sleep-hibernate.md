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

### Notes

- For 30 s after a wake, logind ignores the lid (`HoldoffTimeoutSec`).
  Closing the lid again right after opening it suspends only when the 30 s are over.
- Opening the lid while a suspend is already starting does not cancel it.
- Never unbind a camera driver (for example `intel-ipu6`) while WirePlumber runs.
  WirePlumber's libcamera keeps the camera's device nodes open, and unbinding under it caused a kernel oops.

---

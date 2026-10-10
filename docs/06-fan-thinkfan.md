## 6. Quieter fan curve with thinkfan

### Measurements

- The embedded controller's automatic idle speed is ~4570 RPM, and it never stops the fan, even in Power Saver.
- Manual levels: 0 = ~3700 (floor, the fan never stops), 1-3 = ~4600, 4 = ~5400, 5 = ~6100, 6 = ~6900, 7 = ~7600.
  Under load, firmware `auto` goes above 7, to about 8000+.
- stress-ng, 60 s at full load, ~17 W every run:

  | Fan | Temperature, last 20 s | Peak |
  |---|---|---|
  | `auto` | ~70 °C | 79 °C |
  | level 0 | ~75 °C | 81 °C |
  | level 7 | ~73 °C | 81 °C |

  The CPU is power-limited, not temperature-limited, so a quieter curve is safe.

### Install

The `thinkfan` AUR package ships `/usr/lib/modprobe.d/thinkpad_acpi.conf` with `fan_control=1`.
Reboot after installing so the option takes effect:

```
shelly install aur thinkfan        # or any AUR helper
```

### Config

`/etc/thinkfan.conf`:

```yaml
# ThinkPad X12 Detachable Gen 1: quieter fan curve on CPU package temperature.
# Tuned from stress-ng runs: the CPU is power-limited (~17 W) and fan speed only moves
# load temps a few degrees, so stay low/quiet and hand back to the EC near the top.
sensors:
  - hwmon: /sys/devices/platform/coretemp.0/hwmon
    name: coretemp
    indices: [1]          # Package id 0

fans:
  - tpacpi: /proc/acpi/ibm/fan

levels:
  - [0, 0, 60]
  - [1, 55, 65]
  - [4, 62, 70]
  - [5, 67, 75]
  - [6, 72, 80]
  - ["level auto", 77, 255]
```

### Test and enable

```
sudo timeout 25 thinkfan -n -c /etc/thinkfan.conf     # foreground test; fan returns to auto on exit
sudo systemctl enable --now thinkfan.service
sudo systemctl enable thinkfan-sleep.service thinkfan-wakeup.service
```

### Undo

- Keep the package but return to the firmware curve: `sudo systemctl disable --now thinkfan`.
- Remove everything, including the driver option: uninstall the package.

### Safety notes for manual fan tests

- Arm the watchdog with `echo "watchdog 30" > /proc/acpi/ibm/fan`, so the firmware takes over if a script dies.
- Always end with `level auto`.
- Make sure no other script is writing fan levels at the same time.

### Fan logger (optional)

Logs fan RPM, fan level, temperatures and CPU package power once per second, to see when and why the fan starts.
Negligible CPU and battery cost.

`/usr/local/bin/x12-fan-logger` (mode 755):

```bash
#!/bin/bash
# Log fan RPM, fan level, temperatures and CPU package power once per second
# to /var/log/x12-fan/fan-YYYY-MM-DD.csv
dir=/var/log/x12-fan
mkdir -p "$dir"
core=$(echo /sys/devices/platform/coretemp.0/hwmon/hwmon*)
rapl=/sys/class/powercap/intel-rapl:0/energy_uj
max_uj=$(</sys/class/powercap/intel-rapl:0/max_energy_range_uj)
prev_uj=$(<"$rapl"); prev_t=$EPOCHREALTIME
while sleep 1; do
    now=$EPOCHREALTIME
    f="$dir/fan-$(printf '%(%F)T' -1).csv"
    [[ -f $f ]] || echo "time,rpm,level,pkg_c,core_max_c,acpitz_c,pkg_w,load1,ac" >"$f"
    rpm=; level=
    while read -r k v; do
        [[ $k == speed: ]] && rpm=$v
        [[ $k == level: ]] && level=$v
    done </proc/acpi/ibm/fan
    pkg=$(( $(<"$core/temp1_input") / 1000 ))
    cmax=0
    for t in "$core"/temp[2-9]_input; do v=$(<"$t"); (( v > cmax )) && cmax=$v; done
    acpitz=$(( $(</sys/class/thermal/thermal_zone0/temp) / 1000 ))
    uj=$(<"$rapl")
    d=$(( uj - prev_uj )); (( d < 0 )) && d=$(( d + max_uj ))
    w=$(awk -v d="$d" -v a="$prev_t" -v b="$now" 'BEGIN{printf "%.2f", d/1e6/(b-a)}')
    prev_uj=$uj; prev_t=$now
    read -r load1 _ </proc/loadavg
    ac=$(</sys/class/power_supply/AC/online)
    printf '%(%F %T)T,%s,%s,%s,%s,%s,%s,%s,%s\n' -1 "$rpm" "$level" "$pkg" "$((cmax/1000))" "$acpitz" "$w" "$load1" "$ac" >>"$f"
done
```

`/etc/systemd/system/x12-fan-logger.service`:

```ini
[Unit]
Description=ThinkPad X12: log fan RPM, temperatures and CPU power every second

[Service]
ExecStart=/usr/local/bin/x12-fan-logger
Nice=10

[Install]
WantedBy=multi-user.target
```

`/usr/local/bin/x12-fan-summary` (mode 755):

```bash
#!/bin/bash
# Summarize the fan log: x12-fan-summary [minutes] [YYYY-MM-DD]
# rpm 65535 is a bogus reading the EC gives right after resume; it is ignored.
mins=${1:-60}
f=/var/log/x12-fan/fan-${2:-$(date +%F)}.csv
since=$(date -d "-$mins min" '+%F %T')
tail -n +2 "$f" | awk -F, -v since="$since" '
$1 < since { next }
$2 == 65535 { bogus++; next }
{
    n++
    spinning = ($2 > 0)
    if (spinning) on++
    if (spinning && !was) { starts++; printf "%s  fan start  (level %s, pkg %sC, %sW)\n", $1, $3, $4, $7 }
    was = spinning
    if ($4 > mx) mx = $4
    if ($7 > pw) pw = $7
    sw += $7
}
END {
    if (!n) { print "no data"; exit }
    printf "\n%d s logged, fan on %d s (%.0f%%), fan starts %d", n, on, 100*on/n, starts
    if (bogus) printf ", ignored %d bogus readings", bogus
    printf "\npkg temp max %dC, CPU power avg %.2fW max %.2fW\n", mx, sw/n, pw
}'
```

Enable and use:

```
sudo systemctl daemon-reload
sudo systemctl enable --now x12-fan-logger
x12-fan-summary            # last 60 min: every fan start with temp and power, then totals
x12-fan-summary 600        # last 10 h
tail -f /var/log/x12-fan/fan-$(date +%F).csv    # live
```

Columns: `rpm`, `level` (thinkfan level, 0 = off), `pkg_c` (CPU package), `core_max_c` (hottest core), `acpitz_c` (firmware sensor), `pkg_w` (CPU power over the last second), `load1`, `ac` (charger 1/0).
The logs grow about 4 MB per day; delete old files from `/var/log/x12-fan/` when no longer needed.

First results (47 min on battery, mostly idle):

- During 30 minutes of normal light use the fan never spun; the CPU stayed at 30-39 °C and about 0.9 W.
- Every fan start came from a boot: the CPU jumps from about 35 °C to 75-78 °C at 16-20 W within a second.
  thinkfan ramps up, then returns to level 0 after about 5 s; the fan spins down over the next 20-50 s.
- Right after resume the EC briefly reports 65535 rpm while the fan is off; the summary ignores those readings.

### The 65535 rpm blip in the Vitals extension

The Vitals GNOME extension's live fan tile shows 65535 for one poll right after resume
(the fan logger above already filters it). 65535 is 0xFFFF, the EC's "reading not available"
sentinel, returned for about a second while the EC re-initialises the tachometer, then it
settles to the real value.

**Vitals is left stock on the X12.** A one-line filter in `sensors.js` (drop any fan read
`>= 65535`) was tried and worked, but it was reverted to the original, for two reasons: it has
to be reapplied after every Vitals update (extensions.gnome.org overwrites `sensors.js`), and a
*persistent* 65535 is a genuine "fan stopped / not present" fault worth seeing, not hiding. The
blip is purely cosmetic: thinkfan does not use rpm for control, and `sensors`/logs are unaffected.

For the same reason it was not fixed in the kernel either: in `thinkpad_acpi`, 0xFFFF is the
established "fan not available" value, and masking it (rewriting to 0) would hide a real stuck-fan
fault, would not be accepted upstream, and needs a per-kernel module rebuild.

If the one-poll blip ever does bother you, the optional filter is a single guard in
`~/.local/share/gnome-shell/extensions/Vitals@CoreCoding.com/sensors.js`, inside `_queryTempVoltFan`
right after the file read resolves (reapply after each Vitals update):

```javascript
// X12: skip the EC 0xFFFF (65535) 'not ready' fan sentinel seen for one poll after resume
if (type == 'fan' && parseInt(value) >= 65535) return;
```

---

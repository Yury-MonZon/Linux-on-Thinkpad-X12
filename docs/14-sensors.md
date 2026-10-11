## 14. Sensors

What the X12 reports to Linux, and how a user or a program reads it.

| Sensor | Source | Root needed | Live |
|---|---|---|---|
| Accelerometer | Intel Sensor Hub, IIO `accel_3d` | no | yes |
| Gyroscope | Intel Sensor Hub, IIO `gyro_3d` | no (sysfs), yes (`/dev/iio:*` streaming) | yes |
| Screen orientation | `iio-sensor-proxy` (from the accelerometer) | no | yes |
| Simple orientation | Intel Sensor Hub, HID usage `0x8F` | n/a | no Linux driver |
| 9 vendor custom sensors | Intel Sensor Hub, HID usage `0x2000E1` | yes | switched off, purpose unknown |
| WWAN proximity (P-) sensor | embedded controller | yes | yes, through `GPSS`; `palmsensor` is stale |
| Lap mode | `thinkpad_acpi` `dytc_lapmode` | no | not a sensor here, always 0 on Linux |
| Lid (Folio cover) | ACPI lid button | no | yes |
| Folio keyboard attached | USB device `17ef:60fe` | no | yes |
| Tablet mode | `thinkpad_acpi` `hotkey_tablet_mode` | no | yes |
| Temperatures, fan, battery | hwmon, power supply | no | yes |

Not present on this model: ambient light sensor (no automatic screen brightness), magnetometer (compass), and a proximity sensor on the sensor hub.

### Accelerometer and gyroscope

The Intel Sensor Hub (ISH) exposes both as IIO devices.
The `iio:deviceN` numbers can change between boots, so find them by name.
Raw values times `..._scale` give m/s² for the accelerometer and rad/s for the gyroscope; the offsets are 0.

```bash
for n in accel_3d gyro_3d; do
    d=$(dirname "$(grep -lx "$n" /sys/bus/iio/devices/iio:device*/name)")
    echo "$n: $d"
done

A=$(dirname "$(grep -lx accel_3d /sys/bus/iio/devices/iio:device*/name)")
s=$(cat "$A/in_accel_scale")                 # 0.000009806
for ax in x y z; do
    awk -v r="$(cat "$A/in_accel_${ax}_raw")" -v s="$s" -v a="$ax" 'BEGIN { printf "%s %.2f m/s2\n", a, r * s }'
done

G=$(dirname "$(grep -lx gyro_3d /sys/bus/iio/devices/iio:device*/name)")
s=$(cat "$G/in_anglvel_scale")               # 0.000000174
for ax in x y z; do
    awk -v r="$(cat "$G/in_anglvel_${ax}_raw")" -v s="$s" -v a="$ax" 'BEGIN { printf "%s %.4f rad/s\n", a, r * s }'
done
```

The sysfs values are readable by any user.
Streaming through `/dev/iio:deviceN` (for high sample rates) is root-only unless a udev rule opens it.

### Screen orientation and rotation lock

`iio-sensor-proxy` turns the accelerometer into orientation (`normal`, `left-up`, `right-up`, `bottom-up`) and tilt, on D-Bus.
GNOME uses it for automatic rotation.

```
monitor-sensor          # prints changes; Ctrl+C to stop
gdbus call --system --dest net.hadess.SensorProxy --object-path /net/hadess/SensorProxy \
  --method org.freedesktop.DBus.Properties.Get net.hadess.SensorProxy AccelerometerOrientation
```

A program that wants updates calls `ClaimAccelerometer` on the same object first, as `monitor-sensor` does.

GNOME only rotates the screen in tablet mode (Folio detached or folded behind the screen).
With the Folio attached, Mutter does not manage the orientation (`PanelOrientationManaged` is false on `org.gnome.Mutter.DisplayConfig`) and Quick Settings hides the toggle.

Rotation lock needs no extension: in tablet mode the Auto Rotate toggle appears in Quick Settings (top right).
The same setting works at any time, also before detaching the Folio:

```
gsettings set org.gnome.settings-daemon.peripherals.touchscreen orientation-lock true    # lock
gsettings set org.gnome.settings-daemon.peripherals.touchscreen orientation-lock false   # rotate again
```

### Sensors the hub has but Linux does not use

- **Simple orientation** (HID sensor usage `0x8F`, `HID-SENSOR-20008f`): portrait, landscape, face up or down.
  Linux has no driver for it (`hid-sensor-rotation` handles `0x8A`, `0x8E` and `0xC1` only); the accelerometer covers the same.
- **Nine vendor custom sensors** (`HID-SENSOR-2000e1.*`, driver `hid-sensor-custom`).
  They do not describe themselves: the description field is `1` and every input is a generic "custom value".
  All of them are switched off (`enable_sensor` is 0), so their purpose is unknown.
  Their fields are root-only:

  ```
  sudo cat /sys/bus/platform/devices/HID-SENSOR-2000e1.2.auto/input-*/input-*-name
  ```

### WWAN proximity (P-) sensor

**Hardware.**
A capacitive sensor next to the WWAN antenna, along the top (camera) edge.
On the board it is only a 6-pin connector (`PSEN1`, schematic page 63 "WWAN P-SENSOR"); the sensor chip is at the other end of a small flex cable.
The connector carries I2C to the embedded controller (EC port `I2C04`) and an output line (`-PSENSE_OUT1`) to EC `GPIO105`.
Nothing goes to the modem: the M.2 WWAN slot's DPR pin (pin 25, the hardware "reduce transmit power" input) is not connected.

**Some used X12s have no P-sensor flex cable at all.**
The machines work normally without it; see "What it does" below.
The firmware cannot tell: `GPSS` always reports the sensor as present (bit 0 is hard-coded to 1).

**Firmware.**
- The EC keeps a "body near" flag: register `0x46` bit 6 (`PSST`), plus `0x47` bit 1 (`PSS2`) on 5G models.
- `\_SB.PC00.LPCB.EC.HKEY.GPSS` returns bit 0 = present (always 1), bit 1 = near.
- On a change, EC event `_Q4E` only posts a WMI event: device `AMW0`, notify `0xB0`, GUID `40D1BF71-A82D-4E59-A168-3985E03B2E87`.
  Lenovo's Windows software acts on it; no Linux driver knows that GUID.
- `/sys/devices/platform/thinkpad_acpi/palmsensor` reads `GPSS` once at boot and is then only refreshed by ThinkPad hotkey events `0x60b0`/`0x60b1`, which this firmware never sends.
  It stays at its boot value.

**What it does.**
Only on Windows: Lenovo's service lowers the modem's (and Wi-Fi's) transmit power while the sensor reports "near", for the radiation exposure (SAR) limits.
The Wi-Fi SAR tables are switched the same way, through a WMI event ("Wistron WMI for WLAN SAR Table Event").
On Linux nothing acts on it, so a working, damaged or missing sensor makes no difference to the modem or Wi-Fi.

**Behaviour** (measured on a unit with a damaged-looking cable):
- A hand near the top edge, or the table when the tablet lies flat, is detected within about a second.
  It cannot tell a body from a table: anything close to the antenna side counts.
- It is slow to release: it kept reporting "near" for 40 s or more after the hand was gone.

**Reading it** needs root (`acpi_call` and the read-only `ec_sys` module).
`bin/p-sensor-x12`:

```bash
#!/bin/bash
# ThinkPad X12: watch the WWAN proximity (P-) sensor as the firmware sees it.
# The sensor chip sits on the embedded controller's private I2C bus, so its raw
# capacitance is not reachable from Linux. This shows the rawest data there is:
#   GPSS     firmware method \_SB.PC00.LPCB.EC.HKEY.GPSS: bit 0 = sensor present,
#            bit 1 = body near
#   EC 0x46  embedded controller register; bit 6 = PSST, the sensor's near flag
#   EC 0x47  bit 1 = PSS2, the second sensor flag (only used on 5G models)
# Everything is read-only: ec_sys is loaded with write_support=0.
# (/sys/devices/platform/thinkpad_acpi/palmsensor is not useful here: it is a
# cached value that this firmware never updates.)
# Usage: p-sensor-x12 [interval in seconds, default 0.5]    Ctrl+C to stop
set -u
[ "$EUID" = 0 ] || exec sudo "$0" "$@"
interval=${1:-0.5}

modprobe acpi_call 2>/dev/null
lsmod | grep -q '^ec_sys' || modprobe ec_sys write_support=0
EC=/sys/kernel/debug/ec/ec0/io
[ -r "$EC" ] || { echo "cannot read $EC (is debugfs mounted?)"; exit 1; }
[ -w /proc/acpi/call ] || { echo "acpi_call not available"; exit 1; }

gpss() {
    echo '\_SB.PC00.LPCB.EC.HKEY.GPSS' > /proc/acpi/call
    tr -d '\0' < /proc/acpi/call
}
ecbyte() {    # ecbyte <offset>
    od -An -tx1 -j "$1" -N1 "$EC" | tr -d ' '
}

echo "time          GPSS  present near | EC 0x46  PSST | EC 0x47  PSS2"
prev=
while :; do
    g=$(gpss)
    b46=$(ecbyte $((0x46)))
    b47=$(ecbyte $((0x47)))
    gv=$((g))
    line=$(printf '%-5s %7d %4d | 0x%s %5d | 0x%s %5d' "$g" $((gv & 1)) $(((gv >> 1) & 1)) \
        "$b46" $(((0x$b46 >> 6) & 1)) "$b47" $(((0x$b47 >> 1) & 1)))
    mark=; [ -n "$prev" ] && [ "$line" != "$prev" ] && mark="  <- changed"
    echo "$(date +%T.%N | cut -c1-12)  $line$mark"
    prev=$line
    sleep "$interval"
done
```

Needs the `acpi_call` module (`sudo pacman -S acpi_call-dkms`).
Polling wakes the EC every interval; it is a diagnostic, not something to leave running.

### Lap mode

`/sys/devices/platform/thinkpad_acpi/dytc_lapmode` is not a sensor on the X12, and it reads 0 on Linux all the time.

- It is bit 17 of the firmware's `DYTC` "get" command, the flag `VCQL` ("Cool & Quiet on Lap").
- `VCQL` lives in the BIOS's shared memory (`MNVS`); no firmware code sets it, only a reset clears it.
  On Windows, Lenovo's software sets it through the `DYTC` "set" command when it decides the machine is on a lap.
- `thinkpad_acpi` only refreshes the sysfs value on hotkey event `0x6032`, which the firmware sends after a thermal mode "set", not on a lap change.

What lap mode changes, according to the firmware (`DYTC` mode selection, with Intel DPTF disabled in this BIOS):

| Setting | Standard mode | Lap mode |
|---|---|---|
| Firmware thermal mode (`CICF`) | 0 | 1 |
| CPU sustained power limit (`PL1S`) | `0x78`, the nominal TDP level | `0x78`, no change |
| BIOS thermal profile (`FLPF`, an SMM call) | 0 | 3 |
| Lap bit in `DYTC` "get" | 0 | 1 |

Only the BIOS thermal profile changes; what profile 3 does is inside the BIOS and the EC (probably a cooler skin temperature target and a quieter fan).
Lap mode only applies when no performance mode is set, and Linux's power profiles (Power Saver, Balanced, Performance through `thinkpad_acpi`) use those performance modes.
For a cooler, quieter machine on Linux, use Power Saver.

Live read of the `DYTC` state (root, `acpi_call`); bit 17 of the result is the lap bit:

```
echo '\_SB.PC00.LPCB.EC.HKEY.DYTC 0x2' | sudo tee /proc/acpi/call >/dev/null; sudo cat /proc/acpi/call; echo
```

### Lid, Folio keyboard and tablet mode

- **Lid** (the Folio cover): `/proc/acpi/button/lid/LID/state`; the firmware is asked on every read.
  logind also has it: `busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager LidClosed`.
- **Folio keyboard attached**: the Folio is USB device `17ef:60fe` and disappears when it is detached or folded behind the screen.
- **Tablet mode**: `/sys/devices/platform/thinkpad_acpi/hotkey_tablet_mode` (read from the firmware each time).
  On the X12 it follows exactly the same states as the Folio's USB presence.
- The same switches exist as input events (`Lid Switch`, `Intel HID switches` and `ThinkPad Extra Buttons` report `SW_LID`, `SW_TABLET_MODE` and `SW_RFKILL_ALL`); reading `/dev/input/event*` needs root or the `input` group.

`bin/sensors-x12` watches them without root and prints a line on every change:

```bash
#!/bin/bash
# ThinkPad X12: watch the lid, Folio keyboard and lap sensors, without root.
#   lid       /proc/acpi/button/lid/LID/state; the firmware is asked on every read
#   keyboard  the Folio keyboard is USB device 17ef:60fe; it disappears when the Folio
#             is detached or folded behind the screen (thinkpad_acpi's
#             hotkey_tablet_mode follows exactly the same states)
#   lap       thinkpad_acpi dytc_lapmode. Cached: the driver only refreshes it on a
#             firmware thermal-mode event, so it can be stale (live needs root).
# Prints the state at start, then a line whenever something changes.
# Usage: sensors-x12 [interval in seconds, default 0.5]    Ctrl+C to stop
set -u
interval=${1:-0.5}
TP=/sys/devices/platform/thinkpad_acpi

lid() {
    awk '{print $2}' /proc/acpi/button/lid/LID/state 2>/dev/null || echo "?"
}
folio() {
    local d
    for d in /sys/bus/usb/devices/*; do
        if [ "$(cat "$d/idVendor" 2>/dev/null)" = 17ef ] &&
           [ "$(cat "$d/idProduct" 2>/dev/null)" = 60fe ]; then
            echo attached
            return
        fi
    done
    echo detached
}
flag() {    # flag <sysfs file> <text for 1> <text for 0>
    case "$(cat "$1" 2>/dev/null)" in
        1) echo "$2" ;;
        0) echo "$3" ;;
        *) echo "?" ;;
    esac
}

echo "time          lid     keyboard  lap (cached)"
prev=
while :; do
    line=$(printf '%-7s %-9s %s' "$(lid)" "$(folio)" "$(flag $TP/dytc_lapmode on-lap off-lap)")
    if [ "$line" != "$prev" ]; then
        echo "$(date +%T.%N | cut -c1-12)  $line"
        prev=$line
    fi
    sleep "$interval"
done
```

### Temperatures, fan and battery

All readable by any user, through `/sys/class/hwmon` (`sensors` from `lm_sensors` shows them too):

| hwmon | What |
|---|---|
| `coretemp` | CPU package and core temperatures |
| `thinkpad` | EC: `temp1` is the only valid temperature (the other seven read 0 or fail), `fan1` is the fan speed |
| `nvme`, `iwlwifi_1`, `acpitz` | SSD, Wi-Fi card, ACPI thermal zone |
| `BAT0`, `AC`, `ucsi_source_psy_USBC000:*` | battery and chargers (no temperatures) |

```bash
for h in /sys/class/hwmon/hwmon*; do
    for t in "$h"/temp*_input; do
        [ -e "$t" ] || continue
        v=$(cat "$t" 2>/dev/null) || continue
        [ "$v" -gt 0 ] && awk -v n="$(cat "$h/name")" -v t="$(basename "$t" _input)" -v v="$v" \
            'BEGIN { printf "%-10s %-6s %5.1f C\n", n, t, v / 1000 }'
    done
done
h=$(dirname "$(grep -lx thinkpad /sys/class/hwmon/hwmon*/name)")
echo "fan: $(cat "$h/fan1_input") RPM"
upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep -E 'state|percentage|energy-rate'
```

---

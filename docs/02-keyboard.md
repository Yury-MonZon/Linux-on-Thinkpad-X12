## 2. Keyboard backlight: 3-step Fn+Space with a matching OSD

### Problem

- The Folio keyboard cycles its own backlight in firmware (off -> half -> full) and only reports `KEY_KBDILLUMTOGGLE`.
  GNOME treats that key as on/off, so the OSD shows 2 steps.
- `tpacpi::kbd_backlight` does not drive the Folio light at all.
- But the Folio exposes its real level as HID feature report `0xC4` on USB interface 1: `0` = off, `1` = half, `2` = full.

### Fix

A small service grabs the Folio input device.
After each Fn+Space it reads the real level from `0xC4` and moves GNOME's level, and so its OSD, to match with GNOME's own up/down keys.
When the Folio connects it resets GNOME to 0 and syncs to the real level, so the OSD cannot drift.

Install `python-evdev`:

```
sudo pacman -S python-evdev
```

`/usr/local/bin/x12-kbd-backlight-cycle` (mode 755):

```python
#!/usr/bin/env python3
# ThinkPad X12 Folio: the Folio firmware cycles its own backlight on Fn+Space
# (off -> half -> full) and only reports KEY_KBDILLUMTOGGLE, which GNOME treats
# as on/off. The Folio exposes its real level as HID feature report 0xC4 on
# USB interface 1 (0 = off, 1 = half, 2 = full), so read it after each toggle
# and steer GNOME's level (and OSD) to match with KBDILLUMUP/DOWN.
# All other events from the device are passed through.
import fcntl
import glob
import os
import subprocess
import time

import evdev
from evdev import ecodes as e

LED = "/sys/class/leds/tpacpi::kbd_backlight/"
BACKLIGHT_FEATURE = 0xC4


def read_led(attr):
    with open(LED + attr) as f:
        return int(f.read())


def find_device():
    for path in evdev.list_devices():
        dev = evdev.InputDevice(path)
        if "Folio" in dev.name and e.KEY_KBDILLUMTOGGLE in dev.capabilities().get(e.EV_KEY, []):
            return dev
        dev.close()
    return None


def hidraw_for(dev):
    # The hidraw node of the same HID interface as the input device
    event = os.path.basename(dev.path)
    nodes = glob.glob(f"/sys/class/input/{event}/device/device/hidraw/hidraw*")
    return "/dev/" + os.path.basename(nodes[0])


def read_folio_level(fd):
    buf = bytearray([BACKLIGHT_FEATURE, 0])
    fcntl.ioctl(fd, (3 << 30) | (len(buf) << 16) | (ord("H") << 8) | 0x07, buf, True)  # HIDIOCGFEATURE
    return buf[1]


def reset_level():
    # Through UPower, so GNOME sees the change; UPower may not be up yet at boot
    for _ in range(30):
        result = subprocess.run(
            ["busctl", "call", "org.freedesktop.UPower", "/org/freedesktop/UPower/KbdBacklight",
             "org.freedesktop.UPower.KbdBacklight", "SetBrightness", "i", "0"],
            capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(1)


def tap(ui, key, times=1):
    for _ in range(times):
        ui.write(e.EV_KEY, key, 1)
        ui.syn()
        ui.write(e.EV_KEY, key, 0)
        ui.syn()
        time.sleep(0.05)


def sync(ui, shown, level):
    # Move GNOME's level from what we last drove it to, to the Folio's real level
    if level > shown:
        tap(ui, e.KEY_KBDILLUMUP, level - shown)
    elif level < shown:
        tap(ui, e.KEY_KBDILLUMDOWN, shown - level)
    return level


def wait_for_change(fd, old):
    # The Folio updates the level shortly after the key press
    for _ in range(10):
        time.sleep(0.05)
        level = read_folio_level(fd)
        if level != old:
            return level
    return read_folio_level(fd)


def run(dev):
    top = read_led("max_brightness")
    caps = dev.capabilities()
    caps.pop(e.EV_SYN, None)
    caps.pop(e.EV_FF, None)
    caps[e.EV_KEY] = sorted(set(caps[e.EV_KEY]) | {e.KEY_KBDILLUMUP, e.KEY_KBDILLUMDOWN})
    info = dev.info
    fd = os.open(hidraw_for(dev), os.O_RDWR)
    try:
        with evdev.UInput(caps, name=dev.name + " (backlight cycle)", vendor=info.vendor,
                          product=info.product, version=info.version, bustype=info.bustype) as ui:
            dev.grab()
            reset_level()
            time.sleep(1)  # let the session pick up the new uinput device
            tap(ui, e.KEY_KBDILLUMDOWN, top)
            level = read_folio_level(fd)
            shown = sync(ui, 0, level)
            for ev in dev.read_loop():
                if ev.type == e.EV_KEY and ev.code == e.KEY_KBDILLUMTOGGLE:
                    if ev.value == 1:
                        level = wait_for_change(fd, level)
                        shown = sync(ui, shown, level)
                    continue
                ui.write_event(ev)
    finally:
        os.close(fd)


while True:
    device = find_device()
    if device is None:
        time.sleep(2)
        continue
    try:
        run(device)
    except OSError:
        pass  # Folio detached; wait for it to come back
    finally:
        device.close()
    time.sleep(1)
```

`/etc/systemd/system/x12-kbd-backlight-cycle.service`:

```ini
[Unit]
Description=ThinkPad X12 Folio: 3-step keyboard backlight cycle on Fn+Space

[Service]
ExecStart=/usr/local/bin/x12-kbd-backlight-cycle
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now x12-kbd-backlight-cycle.service
```

Read the level yourself (N = the Folio's interface 1 hidraw node):

```
sudo python3 -c "import os,fcntl; fd=os.open('/dev/hidrawN',os.O_RDWR); b=bytearray([0xc4,0]); fcntl.ioctl(fd,(3<<30)|(2<<16)|(ord('H')<<8)|7,b,True); print(b[1])"
```


### Backlight level after sleep

- The Folio firmware switches its backlight off whenever the USB device is suspended, and does not turn it back on.
- The level can also be set from the host: output report `0x09` with `[0x09, 0xC4, level]` (0, 1 or 2), the report `hid-lenovo` uses for the Folio's LEDs.
- A sleep hook saves the level before every suspend or hibernation and writes it back afterwards.
  After a reboot the backlight starts off, as before.

`/usr/lib/systemd/system-sleep/x12-folio-backlight` (mode 755):

```python
#!/usr/bin/python3 -I
# ThinkPad X12 Folio: the Folio firmware switches its keyboard backlight off
# whenever the USB device is suspended and does not restore it. Save the level
# before sleep and write it back after resume.
#
# The level is HID feature report 0xC4 on USB interface 1 (0 = off, 1 = half,
# 2 = full). It is set with LED output report 0x09 [0x09, 0xC4, level], the
# same report hid-lenovo uses for the mute, mic mute and Fn lock LEDs.
import fcntl
import os
import sys
import time

STATE = "/run/x12-folio-backlight"
HIDIOCGFEATURE_2 = (3 << 30) | (2 << 16) | (ord("H") << 8) | 0x07


def find_hidraw():
    for name in sorted(os.listdir("/sys/class/hidraw")):
        try:
            with open(f"/sys/class/hidraw/{name}/device/uevent") as f:
                uevent = f.read()
        except OSError:
            continue
        if "HID_ID=0003:000017EF:000060FE" in uevent and "/input1\n" in uevent:
            return "/dev/" + name
    return None


def get_level(fd):
    buf = bytearray([0xC4, 0])
    fcntl.ioctl(fd, HIDIOCGFEATURE_2, buf, True)
    return buf[1]


def set_level(fd, level):
    os.write(fd, bytes([0x09, 0xC4, level]))


def save():
    path = find_hidraw()
    if path is None:
        return
    fd = os.open(path, os.O_RDWR)
    try:
        level = get_level(fd)
    finally:
        os.close(fd)
    with open(STATE, "w") as f:
        f.write(str(level))


def restore():
    try:
        with open(STATE) as f:
            level = int(f.read())
    except (OSError, ValueError):
        return
    if level not in (0, 1, 2):
        return
    # The Folio may need a moment after resume before it accepts reports
    for _ in range(15):
        path = find_hidraw()
        if path is not None:
            try:
                fd = os.open(path, os.O_RDWR)
                try:
                    if get_level(fd) == level:
                        return
                    set_level(fd, level)
                    time.sleep(0.1)
                    if get_level(fd) == level:
                        return
                finally:
                    os.close(fd)
            except OSError:
                pass
        time.sleep(0.2)


try:
    if sys.argv[1] == "pre":
        save()
    elif sys.argv[1] == "post":
        restore()
except Exception:
    pass  # never block suspend or resume
```

Nothing else is needed: systemd runs every executable in that directory around each sleep.
Test it: set the backlight to half with Fn+Space, close the lid, open it again; it comes back at half.

---

### F1-F12 as primary function (FnLock)

- The X12 BIOS has no "F1-F12 as Primary Function" option.
- `hid-lenovo` exposes the Folio's FnLock as `fn_lock` in sysfs: `1` = F1-F12 primary, `0` = media keys primary.
  Verified by capturing key events.
- Fn+Esc still toggles it at runtime.

`/etc/udev/rules.d/70-x12-folio-fnlock.rules`:

```
# ThinkPad X12 Folio keyboard (17EF:60FE): F1-F12 as primary function (FnLock on).
# The X12 BIOS has no "F1-F12 as Primary Function" option. Fn+Esc still toggles at runtime.
ACTION=="bind", SUBSYSTEM=="hid", DRIVER=="lenovo", ENV{HID_ID}=="0003:000017EF:000060FE", TEST=="fn_lock", ATTR{fn_lock}="1"
```

```
sudo udevadm control --reload
D=$(dirname $(ls /sys/bus/hid/devices/*17EF:60FE*/fn_lock))
sudo udevadm trigger --action=bind --settle $D
cat $D/fn_lock    # expect 1
```

### Fn/Ctrl swap

- The Folio can swap Fn and left Ctrl inside its own firmware.
- It is the command Lenovo Vantage sends on Windows: output report `0x09`, code `0xB4`, value `0x02` (on) or `0x01` (off), on USB interface 1.
  It was found by [manueljaeckle/thinkpad_x12_fn_switcher](https://github.com/manueljaeckle/thinkpad_x12_fn_switcher) and [aarron-lee/thinkpad_x12_fn_switcher](https://github.com/aarron-lee/thinkpad_x12_fn_switcher).
- The current state can be read as feature report `0xB4`.
- The setting is lost when the Folio disconnects, so udev re-sends it on every connect.
  Hibernation resets the Folio without a disconnect; see "FnLock, Fn/Ctrl swap and LEDs after hibernation" below.
- There is no kernel argument for this: `hid_apple.swap_fn_leftctrl` only applies to Apple keyboards, and the Folio's Fn key never reaches Linux.

`/usr/local/bin/x12-folio-fn-ctrl-swap` (mode 755):

```python
#!/usr/bin/env python3
# ThinkPad X12 Folio: swap Fn and left Ctrl inside the keyboard firmware.
# Same command Lenovo Vantage sends on Windows: output report 0x09, code 0xB4,
# value 0x02 (on) / 0x01 (off), on USB interface 1. The setting is volatile, so
# udev re-sends it whenever the Folio connects.
# Usage: x12-folio-fn-ctrl-swap /dev/hidrawN [on|off]
import os
import sys

node = sys.argv[1]
value = 0x01 if len(sys.argv) > 2 and sys.argv[2] == "off" else 0x02
fd = os.open(node, os.O_WRONLY)
os.write(fd, bytes([0x09, 0xB4, value]))
os.close(fd)
```

`/etc/udev/rules.d/71-x12-folio-fn-ctrl-swap.rules`:

```
# ThinkPad X12 Folio keyboard (17EF:60FE): swap Fn and left Ctrl (keyboard firmware setting, re-sent on every connect).
ACTION=="add", SUBSYSTEM=="hidraw", ENV{ID_USB_VENDOR_ID}=="17ef", ENV{ID_USB_MODEL_ID}=="60fe", ENV{ID_USB_INTERFACE_NUM}=="01", RUN+="/usr/local/bin/x12-folio-fn-ctrl-swap $devnode on"
```

Match on the udev properties as shown.
A rule using `ATTRS{idVendor}` together with `ATTRS{bInterfaceNumber}` never matches, because those attributes live on different parent devices.

```
sudo udevadm control --reload
sudo udevadm trigger --action=add --subsystem-match=hidraw
```

The Folio's other interface 1 features follow the same command family:

| Code | Meaning | Values |
|---|---|---|
| `0x54` | FnLock LED (kernel `hid-lenovo`) | |
| `0x64` | Mute LED | 1 = off, 2 = on |
| `0x74` | Mic-mute LED | 1 = off, 2 = on |
| `0xB4` | Fn/Ctrl swap | 1 = off, 2 = on |
| `0xC4` | Keyboard backlight level | 0 = off, 1 = half, 2 = full |

`0xC4` can be set too, with `[0x09, 0xC4, level]` and the level itself (0, 1 or 2), not the 1/2 off/on values.
Writing feature report `0xC4` directly times out.

### FnLock, Fn/Ctrl swap and LEDs after hibernation

- Hibernation powers the USB bus off, and the Folio comes back with its defaults: FnLock off, Fn and Ctrl not swapped, mute LEDs off.
- The Folio is reset, not disconnected, so the udev rules above do not run again.
- `hid-lenovo` restores nothing after a USB reset for this keyboard: its `reset_resume` only covers two older keyboards.
  It also knows nothing about the Fn/Ctrl swap, which only the udev rule sets.

`hid-lenovo-x12` (section 13) fixes both:
- after a USB reset it re-sends FnLock, the mute and mic mute LEDs and, on the X12, the Fn/Ctrl swap;
- a new sysfs attribute `fn_ctrl_swap` (X12 Folio only) sets the swap and remembers it.

`dkms/hid-lenovo-x12/hid-lenovo-reset-resume.patch`:

```diff
diff --git a/hid-lenovo.c b/hid-lenovo.c
index 3976d7b53..e97fc4091 100644
--- a/hid-lenovo.c
+++ b/hid-lenovo.c
@@ -65,6 +65,7 @@ struct lenovo_drvdata {
 	 */
 	u8 middlebutton_state;
 	bool fn_lock;
+	bool fn_ctrl_swap;
 	bool middleclick_workaround_cptkbd;
 };
 
@@ -75,6 +76,7 @@ struct lenovo_drvdata {
 #define TP10UBKBD_FN_LOCK_LED		0x54
 #define TP10UBKBD_MUTE_LED		0x64
 #define TP10UBKBD_MICMUTE_LED		0x74
+#define TP10UBKBD_FN_CTRL_SWAP		0xB4
 
 #define TP10UBKBD_LED_OFF		1
 #define TP10UBKBD_LED_ON		2
@@ -1308,13 +1310,66 @@ static int lenovo_probe_cptkbd(struct hid_device *hdev)
 	return 0;
 }
 
+static ssize_t attr_fn_ctrl_swap_show(struct device *dev,
+		struct device_attribute *attr,
+		char *buf)
+{
+	struct hid_device *hdev = to_hid_device(dev);
+	struct lenovo_drvdata *data = hid_get_drvdata(hdev);
+
+	return sysfs_emit(buf, "%u\n", data->fn_ctrl_swap);
+}
+
+static ssize_t attr_fn_ctrl_swap_store(struct device *dev,
+		struct device_attribute *attr,
+		const char *buf,
+		size_t count)
+{
+	struct hid_device *hdev = to_hid_device(dev);
+	struct lenovo_drvdata *data = hid_get_drvdata(hdev);
+	int value, ret;
+
+	if (kstrtoint(buf, 10, &value))
+		return -EINVAL;
+	if (value < 0 || value > 1)
+		return -EINVAL;
+
+	ret = lenovo_led_set_tp10ubkbd(hdev, TP10UBKBD_FN_CTRL_SWAP, value);
+	if (ret)
+		return ret;
+
+	data->fn_ctrl_swap = !!value;
+
+	return count;
+}
+
+static struct device_attribute dev_attr_fn_ctrl_swap =
+	__ATTR(fn_ctrl_swap, S_IWUSR | S_IRUGO,
+			attr_fn_ctrl_swap_show,
+			attr_fn_ctrl_swap_store);
+
 static struct attribute *lenovo_attributes_tp10ubkbd[] = {
 	&dev_attr_fn_lock.attr,
+	&dev_attr_fn_ctrl_swap.attr,
 	NULL
 };
 
+static umode_t lenovo_attr_is_visible_tp10ubkbd(struct kobject *kobj,
+		struct attribute *attr, int n)
+{
+	struct hid_device *hdev = to_hid_device(kobj_to_dev(kobj));
+
+	/* Only known to work on the X12 Tab keyboard (Lenovo Vantage setting) */
+	if (attr == &dev_attr_fn_ctrl_swap.attr &&
+	    hdev->product != USB_DEVICE_ID_LENOVO_X12_TAB)
+		return 0;
+
+	return attr->mode;
+}
+
 static const struct attribute_group lenovo_attr_group_tp10ubkbd = {
 	.attrs = lenovo_attributes_tp10ubkbd,
+	.is_visible = lenovo_attr_is_visible_tp10ubkbd,
 };
 
 static int lenovo_probe_tp10ubkbd(struct hid_device *hdev)
@@ -1430,6 +1485,28 @@ static int lenovo_probe(struct hid_device *hdev,
 	return ret;
 }
 
+/*
+ * The keyboard forgets these settings when it is reset, e.g. when the USB bus
+ * loses power during hibernation, and no new probe re-sends them.
+ */
+static void lenovo_reset_resume_tp10ubkbd(struct hid_device *hdev)
+{
+	struct lenovo_drvdata *data = hid_get_drvdata(hdev);
+
+	/* Only the interface with the LED output report has driver data */
+	if (!data)
+		return;
+
+	lenovo_led_set_tp10ubkbd(hdev, TP10UBKBD_FN_LOCK_LED, data->fn_lock);
+	lenovo_led_set_tp10ubkbd(hdev, TP10UBKBD_MUTE_LED,
+				 data->led_state & BIT(0));
+	lenovo_led_set_tp10ubkbd(hdev, TP10UBKBD_MICMUTE_LED,
+				 data->led_state & BIT(1));
+	if (hdev->product == USB_DEVICE_ID_LENOVO_X12_TAB)
+		lenovo_led_set_tp10ubkbd(hdev, TP10UBKBD_FN_CTRL_SWAP,
+					 data->fn_ctrl_swap);
+}
+
 static int lenovo_reset_resume(struct hid_device *hdev)
 {
 	switch (hdev->product) {
@@ -1439,6 +1516,15 @@ static int lenovo_reset_resume(struct hid_device *hdev)
 			lenovo_features_set_cptkbd(hdev);
 
 		break;
+	case USB_DEVICE_ID_LENOVO_X12_TAB:
+	case USB_DEVICE_ID_LENOVO_X12_TAB2:
+	case USB_DEVICE_ID_LENOVO_X13_TAB:
+	case USB_DEVICE_ID_LENOVO_TP10UBKBD:
+	case USB_DEVICE_ID_LENOVO_X1_TAB:
+	case USB_DEVICE_ID_LENOVO_X1_TAB2:
+	case USB_DEVICE_ID_LENOVO_X1_TAB3:
+		lenovo_reset_resume_tp10ubkbd(hdev);
+		break;
 	default:
 		break;
 	}
```

`/etc/udev/rules.d/72-x12-folio-fn-ctrl-swap-attr.rules` sets the swap through the new attribute.
Rule 71 stays as a fallback for kernels without the patch; both sending "on" is harmless.

```
# ThinkPad X12 Folio keyboard (17EF:60FE): swap Fn and left Ctrl through the patched
# hid-lenovo (DKMS hid-lenovo-x12), which also restores it after a USB reset such as
# hibernation. Kernels without the patch have no fn_ctrl_swap; rule 71 covers those.
ACTION=="bind", SUBSYSTEM=="hid", DRIVER=="lenovo", ENV{HID_ID}=="0003:000017EF:000060FE", TEST=="fn_ctrl_swap", ATTR{fn_ctrl_swap}="1"
```

```
sudo install/install-dkms-x12.sh hid-lenovo-x12
sudo udevadm control --reload
# after a reboot:
cat /sys/bus/hid/devices/*17EF:60FE*/fn_ctrl_swap     # expect 1
```

---

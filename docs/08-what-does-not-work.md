## 8. What does not work (and what to avoid)

- **Rear camera (OV8856 behind IPU6):**
  - Does not work with stock packages ("failed to find sensor: -5"); it works with the patches in section 4.
  - **Never force-bind `ov8856` manually** after unbinding `int3472-discrete`: that caused a kernel oops.
  - **Never unbind `intel-ipu6` (or another camera driver) while WirePlumber runs.**
    WirePlumber's libcamera keeps the camera's device nodes open, and unbinding under it caused a kernel oops.
- **TrackPoint (this unit's Folio): damaged sensor, hardware fault.**
  - The red nub only registers when pressed **very hard**, and then only as an all-or-nothing burst. There is no proportional fine control.
  - Raw evdev capture of the Folio's relative-pointer node (the device with `REL=3` among the `17EF:60FE` nodes; `event5` on this unit) while moving the nub: **every report was pegged at exactly `REL_X=+80 / REL_Y=-80`, never an intermediate value**, in a single ~1 s burst, then silence. A healthy strain-gauge stick ramps 1..max with pressure; this jumps straight to the rail and produces nothing below threshold.
  - That all-or-nothing, pegged-at-max signature, plus **visible damage to the sensor-element traces** on the nub, is a hardware fault in the strain-gauge sensor/flex: the bridge can no longer report proportional force (below threshold it reads zero, above it slams to max). The brief single burst per push also rules out electrical drift.
  - **No software fix.** You cannot amplify a proportional signal the broken gauge is not producing, and this Folio stick is USB HID (Darfon), so it does not expose the classic PS/2 ThinkPad `sensitivity`/`speed` sysfs knobs. Use the touchpad or the Wacom pen for fine control. (A libinput flat-profile/low-speed rule could tame the overshoot from the ±80 bursts, but it stays coarse; not applied here.)
  - The three TrackPoint buttons still work. The X12 BIOS has no TrackPoint option (confirmed from the setup forms). The real fix is a **replacement Folio** (the stick lives in the detachable keyboard, not the tablet).
  - To re-check on another unit, capture raw input events on the Folio's relative-pointer node while pushing the nub:

    ```
    # find the relative pointer node: look for the 17EF:60FE device whose line reads "REL=3"
    awk 'BEGIN{RS="";FS="\n"} /60fe/ && /REL=3/ {print}' /proc/bus/input/devices   # note its eventN
    sudo evtest /dev/input/eventN    # push the nub; healthy = values ramp 1..max, faulty = only the max value
    ```

- **Fn/Ctrl swap in BIOS:**
  - The X12 BIOS has no option for it.
  - It works through the Folio firmware command instead (see section 2).
- **IR emitter / face login:**
  - **Do not run `linux-enable-ir-emitter configure` on this camera.**
    It failed with "Impossible to reset the instruction" and left the camera firmware stuck.
    The next reboot hung, and the following boots froze at the logo.
  - Recovery: hold the power button 10 s to fully cut power, then boot.
  - The AUR `linux-enable-ir-emitter` 6.x also does not build against OpenCV 5.
  - The IR light turns on by itself whenever the IR stream is open, so face login (Visage, section 3) works without the tool.
- **Camera apps:**
  - Without section 4's WirePlumber rules, PipeWire lists the IR camera and 64 raw IPU6 channels next to the webcam.
  - guvcview still lists the IPU6 channels (it opens `/dev/video*` directly); pick the first entry for the webcam.
- **Boot menu:**
  - `editor no` is set in `loader.conf`, so kernel options cannot be edited at boot (it keeps Secure Boot meaningful).
  - For recovery use "Known good", F11 or F12 -> "CachyOS Live" (sections 1 and 11).
  - The default is pinned to the main kernel; picking another entry applies to that boot only.
- **Boot log (`journalctl -b -p err`):**
  - `i801_smbus ... SMBus is busy, can't use it!` (7 times): the chipset SMBus hangs on its first transaction (the memory module probe at 0x50) and stays busy.
    Nothing on the X12 uses it (soldered RAM, battery and fan through the EC, USB touchpad), so `etc/modprobe.d/i801-x12.conf` blacklists `i2c_i801`.
    That also removes a 0.4 s stall at boot.
  - `i2c_hid_acpi i2c-WACF2200:00: device returned incorrect report (0 vs 11 expected)` (5 times): `hid-generic` took the pen digitizer before `wacom` loaded.
    `etc/modprobe.d/wacom-x12.conf` loads `wacom` first.
  - Harmless, left alone:
    - `virt/tdx: TDX not supported by the host platform`: TDX is a server CPU feature.
    - `ACPI BIOS Error (bug): Failure creating named object [\_SB.PC00.RP01.PXSX._DSM], AE_ALREADY_EXISTS`: the BIOS defines the modem's `_DSM` twice. The DSDT copy is used and gives the iosm driver the right sleep mode (D3L2).
    - `Bluetooth: hci0: Opcode 0x2036 failed: -16`: a start-up race in the Bluetooth stack; Bluetooth works.
  - `[UFW BLOCK] ... DPT=5355`: UFW logs the laptop's own LLMNR packets (Windows-style name lookup by systemd-resolved).
    `etc/systemd/resolved.conf.d/llmnr-x12.conf` turns LLMNR off.
  - `Detected another IPv4 mDNS stack running on this host` (Avahi and systemd-resolved both answer `.local` names).
    Avahi keeps mDNS, because GNOME and CUPS use it for discovery: `etc/systemd/resolved.conf.d/mdns-x12.conf` turns it off in resolved, and `/etc/nsswitch.conf` gets `mdns_minimal` (from `nss-mdns`) so `.local` names still resolve:

    ```
    hosts: mymachines mdns_minimal [NOTFOUND=return] resolve [!UNAVAIL=return] files myhostname dns
    ```

    Restart `systemd-resolved` and `avahi-daemon`, then check with `getent hosts $(hostname).local`.
  - `Failed to make thread 'KMS thread' high priority` and `RTKit error: ... ServiceUnknown`: `rtkit` was not installed, so GNOME's display thread ran at normal priority.
    `sudo pacman -S rtkit`, then log out and in. (PipeWire already had real-time priority through `realtime-privileges`.)
  - `gnome-shell-calendar-server: error while loading shared libraries: libecal-2.0.so.3`: `evolution-data-server` was not installed, so the clock menu had no calendar.
    `sudo pacman -S evolution-data-server` (about 176 MB with `webkit2gtk-4.1`).
  - `video2: Process '/usr/bin/v4l2-ctl ... exposure_dynamic_framerate=0' failed`: the webcam rule from section 4 also ran on the IR camera; it now matches the RGB interface only (`ID_USB_INTERFACE_NUM=="00"`).
  - `systemd-tpm2-setup-early`, `systemd-pcrproduct` and `systemd-pcrlogin@` fail: systemd 262's NvPCRs need a signed PCR policy key (`tpm2-pcr-public-key.pem`), which mkinitcpio UKIs do not have.
    Only matters for TPM-bound disk encryption or attestation.

---

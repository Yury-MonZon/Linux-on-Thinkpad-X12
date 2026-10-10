## 8. What does not work (and what to avoid)

- **Rear camera (OV8856 behind IPU6):**
  - Does not work with stock packages ("failed to find sensor: -5"); it works with the patches in section 4.
  - **Never force-bind `ov8856` manually** after unbinding `int3472-discrete`: that caused a kernel oops.
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
  - For recovery use "Known good", "CachyOS Rescue" or F12 (section 1, "Recovery boot options").
  - The default is pinned to the main kernel; picking another entry applies to that boot only.

---

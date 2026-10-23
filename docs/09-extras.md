## 9. Optional extras

- **Battery:**
  - Health was ~84% (35.1 of 42.0 Wh, 218 cycles).
  - Turn on charge limiting in Settings > Power ("Preserve Battery Health"), or set the thresholds directly:

    ```
    echo 75 | sudo tee /sys/class/power_supply/BAT0/charge_control_start_threshold
    echo 80 | sudo tee /sys/class/power_supply/BAT0/charge_control_end_threshold
    ```

- **Touchscreen in tablet mode:**
  - [TouchUp](https://github.com/mityax/gnome-extension-touchup) (`touchup@mityax`) adds an Android-style navigation bar, touch gestures (notifications, panel, overview, desktop), on-screen keyboard improvements and a rotate button.
  - Touch Haptics (X12) adds click and long-press sounds for touch on GNOME Shell (section 15).
  - The on-screen keyboard can show word suggestions with ibus-typing-booster, and OSK Tweaks adds Android and laptop layouts, offline dictation and size settings (section 16).
- **Scheduler:**
  - The kernel uses EEVDF; sched_ext is available.
  - `scx_lavd --powersave` was measured here (A-B-A, 90 s each, light 4x10% load): battery 2.92 W (EEVDF) -> 3.46 W (LAVD) -> 3.10 W (EEVDF).
  - It did not save power on this 4-core Tiger Lake; the default scheduler is the better choice.
- **Sleep (s2idle):**
  - This firmware only offers s2idle (modern standby); `/sys/power/mem_sleep` shows `[s2idle]` with no `deep` (S3) option.
  - Overnight test, 6 h 35 min asleep, unplugged (lid closed 01:18, opened 07:53):
    - Battery 9.81 Wh -> 8.49 Wh: **1.32 Wh used, average drain 0.20 W**.
    - That is **about 14% of the 35.1 Wh battery per 24 h**, or about 7 days of sleep from full.
    - **SLP_S0 residency 99.9%** (23,687 s of 23,714 s): the platform reached its deepest power state almost immediately and stayed there.
    - One wake-up only (lid open), no spurious wakes; thinkfan resumed correctly.
  - An earlier 20.5 min test gave the same picture (99.9% residency, 0.15-0.25 W); the battery reports in 10 mWh steps, so short tests are imprecise.
  - How to measure:

    ```
    # before sleep
    cat /sys/class/power_supply/BAT0/energy_now; date +%s
    sudo cat /sys/kernel/debug/pmc_core/slp_s0_residency_usec
    # after wake: the same two commands again
    ```

  - Drain (W) = energy difference in uWh / 1e6 / hours asleep.
  - Residency = difference in `slp_s0_residency_usec` / seconds asleep.
  - Do not use `/sys/power/suspend_stats/last_hw_sleep` for long sleeps: it is a 32-bit counter that wraps after about 72 minutes (it showed 2,212 s for the 6.5 h sleep).
  - Low residency (well under 90%) means a device or driver keeps the platform awake.
- **Idle power (awake, nothing running, on battery):**

  | | Package C10 | Cores in deepest state | Whole-tablet battery draw |
  |---|---|---|---|
  | Screen off (GNOME blanked it) | 92.7 % | 99.3 % | 1.14 W |
  | Screen on, 33 % brightness, run 1 (20 s) | 92.0 % | 98.6 % | 1.90 W |
  | Screen on, 33 % brightness, run 2 (30 s) | 90.1 % | 98.6 % | 2.06 W average (1.99-2.08) |

  - The CPU package reaches its deepest idle state (C10) about 90 % of the time, even with the screen on: the panel's self-refresh lets the graphics power down while the picture does not change.
  - The screen costs about 0.75 W at this brightness; brightness is the biggest lever on idle runtime.
  - About 2 W screen-on idle is roughly 17 hours of a static screen on the 35 Wh battery; real use is lower.
  - The core state names come from the firmware's ACPI table: `C3_ACPI` is the third entry, which on Tiger Lake is the deep core C10 state.
  - Measure over 15-30 s without touching the tablet (input wakes the CPU).
    Keep the screen on without input with `gnome-session-inhibit --inhibit idle sleep 60 &`, otherwise GNOME blanks it during the test.

    ```
    sudo cat /sys/kernel/debug/pmc_core/package_cstate_show      # before and after; the difference / elapsed time = residency
    grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/{name,time}   # per-core states (time in microseconds)
    cat /sys/class/power_supply/BAT0/power_now                     # battery draw in microwatts, on battery only
    ```

- **Firmware:** `fwupdmgr get-updates` showed nothing newer (BIOS 1.43, fingerprint reader Prometheus 10.01.4445936).
- **Fingerprint reader "attestation: not OK"** (GNOME Firmware / fwupd): not a fault.
  - The reader runs firmware 10.01.4445936, newer than anything on the LVFS: the newest there is 10.01.3478575 (June 2021), and 10.01.3158804 (May 2020).
    It was most likely installed under Windows; Lenovo stopped publishing these on the LVFS.
  - Attestation compares the firmware checksum with published releases; with no record of this version, fwupd cannot confirm it.
  - Do not install the LVFS versions: fwupd marks both as downgrades.
  - A local baseline is not possible either: `sudo fwupdmgr verify-update` fails with "dumping firmware is not supported by device".
    The secure reader does not allow reading its firmware out, so `fwupdmgr verify` cannot work for it.
    The attempt restarts the reader; enrolled fingers and fingerprint login are unaffected.
- **BIOS backup:**
  - Kernel lockdown is off, so the SPI flash can be read via the read-only MTD node:

    ```
    sudo dd if=/dev/mtd0ro of=x12-spi.bin bs=1M
    ```

  - Keep the dump private (it contains serials, MACs and UEFI variables).
  - Never flash a modified image: Boot Guard.
- **Display colour profile (factory ICC + vcgt):**
  - The panel is an InfoVision **N123NCA_GS1**. A factory-style ICC profile for it (`N123NCA_GS1.icm`, X-Rite i1Profiler, measured 2021-03-29, 385 cd/m2, white point D50-adapted) was published by NotebookCheck. A mirror is in [`color/`](../color/), with the source link and credit in [`color/README.md`](../color/README.md).
  - It carries a real **vcgt** calibration table (a per-channel gamma LUT, not identity), so installing it corrects the grayscale and white balance by loading that LUT into the GPU, the same thing Windows does. Without it you get the panel's raw, uncalibrated response.
  - Install on GNOME (colord). Copy `color/N123NCA_GS1.icm` to the laptop first, then:

    ```
    mkdir -p ~/.local/share/icc
    cp N123NCA_GS1.icm ~/.local/share/icc/
    colormgr import-profile ~/.local/share/icc/N123NCA_GS1.icm
    # find the built-in display and the imported profile, then assign it:
    DEV=$(colormgr get-devices-by-kind display | awk -F': *' '/Object Path/{print $2; exit}')
    PROF=$(colormgr get-profiles | awk -F': *' '/Object Path/{p=$2} /Filename/&&/N123NCA_GS1/{print p; exit}')
    colormgr device-add-profile "$DEV" "$PROF"
    colormgr device-make-profile-default "$DEV" "$PROF"
    ```

  - Or do it in the GUI: **Settings > Color > (the built-in display) > Add profile > Import profile...**, pick the `.icm`, then "Enable".
  - The vcgt LUT is loaded by `gsd-color` at **GNOME login**, so log out and back in (or reboot) after assigning, then confirm the profile is the active one in Settings > Color.
  - A ready-to-run script is in the repo: `install/install-icc-profile.sh color/N123NCA_GS1.icm`.
  - Undo: Settings > Color, select the sRGB/built-in default and "Enable", or `colormgr device-make-profile-default "$DEV" <other-profile>`; the vcgt reverts to linear on the next login.
- **Fan reading:** `sensors` (fan1 under thinkpad-isa-0000) or `cat /proc/acpi/ibm/fan`.
- **PSR2:** enabled and working.
  If you see flicker or cursor lag, add `i915.enable_psr=1` to `/etc/kernel/cmdline` and run `sudo mkinitcpio -P`.
- **Nautilus "Open in Terminal" right-click entry:** GNOME Files 51 ships no "open terminal here" item. Add it with the python extension (the terminal here is ptyxis):

    ```
    sudo pacman -S --needed python-nautilus          # installs nautilus-python bindings (extensions won't load without these)
    paru -S nautilus-open-any-terminal               # the extension (AUR)
    gsettings set com.github.stunkymonkey.nautilus-open-any-terminal terminal ptyxis
    nautilus -q                                       # reload Files; reopen it afterwards
    ```

  - Right-click a folder or empty space in Files -> "Open Terminal" / "Open Terminal Here", opens ptyxis in that directory.
  - Optional: `... new-tab true` (reuse a window as tabs), `... flatpak <off|system|user>`, or set `terminal` to another emulator (`alacritty`, `kitty`, ...). List keys with `gsettings list-recursively com.github.stunkymonkey.nautilus-open-any-terminal`.
  - The bindings package is the usual gotcha: without `python-nautilus` the extension file is installed but Files never loads it, so no menu item appears.
- **Boot time:** 31 s from power-on to the login screen, now 21.6 s (`systemd-analyze`; firmware about 9 to 12 s of it, which Linux cannot change).
  - Boot menu hidden: `timeout menu-hidden` in `/boot/loader/loader.conf` (was `timeout 3`), saves the 3 s countdown.
    To get the menu, keep tapping Space on the Folio from the Lenovo logo on (systemd-boot only shows it when it sees a key press as it starts; a held key can be missed).
    Without the keyboard: `systemctl reboot --boot-loader-menu=10` shows it for 10 s on the next boot only.
  - Boot splash without its end animation, saves about 3.8 s: GDM asks the splash to step aside (`plymouth deactivate`) and waits until the CachyOS theme `cachyos-bootanimation` has played its 88-frame end animation (`UseEndAnimation=true`).
    Found with GDM's debug log (`[debug] Enable=true` in `/etc/gdm/custom.conf`): "GDM starting to manage displays" at 6.19 s, nothing until plymouthd answered at 9.98 s.
    `usr/share/plymouth/themes/cachyos-bootanimation-no-end-wait/` holds a copy of the theme file with `UseEndAnimation=false` for boot; the images come from the installed package, and the copy has its own name so package updates leave it alone:

    ```
    sudo cp -a /usr/share/plymouth/themes/cachyos-bootanimation /usr/share/plymouth/themes/cachyos-bootanimation-no-end-wait
    sudo rm /usr/share/plymouth/themes/cachyos-bootanimation-no-end-wait/cachyos-bootanimation.{plymouth,grub}
    sudo install -m644 usr/share/plymouth/themes/cachyos-bootanimation-no-end-wait/cachyos-bootanimation-no-end-wait.plymouth /usr/share/plymouth/themes/cachyos-bootanimation-no-end-wait/
    sudo plymouth-set-default-theme cachyos-bootanimation-no-end-wait && sudo mkinitcpio -P
    ```

    The splash looks the same; it just stops instead of playing its closing animation.
    Undo: `sudo plymouth-set-default-theme cachyos-bootanimation && sudo mkinitcpio -P`.
  - Not changed: the initramfs carries the `xe` driver and firmware for every newer Intel GPU (about 11 MB the firmware reads at about 32 MB/s), worth about 0.35 s; `NetworkManager-wait-online` (3.7 s) runs in parallel and does not delay the login screen.
- **CPU mitigations off (optional):** `mitigations=off` in `/etc/kernel/cmdline`, then `sudo mkinitcpio -P`.
  Tiger Lake fixes most of these flaws in hardware; the remaining ones are Spectre v2 (Enhanced IBRS plus the BHI software loop), indirect target selection, Spectre v1 barriers, speculative store bypass (only for programs that ask) and Gather Data Sampling (Downfall, microcode: slows AVX gather instructions).
  The gain is a few percent in system-call-heavy work at most, nothing visible on the desktop; the cost is that local code could read other processes' data.
  Check: `grep -r . /sys/devices/system/cpu/vulnerabilities/` shows "Vulnerable" for those five.
- **libvirt after a TPM change:** libvirt keeps an encryption key sealed to the TPM (`/var/lib/libvirt/secrets/secrets-encryption-key`, `LoadCredentialEncrypted=`).
  After a TPM clear, a BIOS update or cloning the system to another X12, libvirtd fails at every start ("TPM key integrity check failed. Key most likely does not belong to this TPM") and systemd keeps restarting it.
  If no libvirt secrets are stored (`/var/lib/libvirt/secrets/` holds only that key), let libvirt make a new one:

    ```
    sudo mv /var/lib/libvirt/secrets/secrets-encryption-key /root/secrets-encryption-key.old
    sudo systemctl start virt-secret-init-encryption.service
    sudo systemctl reset-failed libvirtd.service && sudo systemctl restart libvirtd.service
    ```

- **libvirtd on demand:** with no VM set to autostart, libvirtd does not need to run from boot (it brings up the `virbr0` bridge and a dnsmasq DHCP server for nothing).
  Its sockets start it when virt-manager or `virsh` connects, and it exits after 2 minutes without clients or running VMs (`--timeout 120`).
  `systemctl disable libvirtd.service` also disables its sockets and the virtlogd and virtlockd sockets (`Also=` in its `[Install]` section), so enable those again:

    ```
    sudo systemctl disable libvirtd.service
    sudo systemctl enable libvirtd.socket libvirtd-ro.socket libvirtd-admin.socket virtlogd.socket virtlogd-admin.socket virtlockd.socket virtlockd-admin.socket
    ```

- **Quick system snapshot (`create_snapshot`):** a helper at `/usr/local/bin/create_snapshot` that takes a described, persistent snapper snapshot of `/` before a risky change.

    ```
    create_snapshot                      # default, timestamped description
    create_snapshot "before SB toggle"   # your own label
    ```

  - It runs `snapper -c root create --type single --print-number` with **no cleanup algorithm**, so the snapshot stays until you remove it (`sudo snapper -c root delete <N>`) rather than being swept up by the timeline rotation. It self-elevates with sudo (passwordless here) and falls back to a raw read-only `btrfs subvolume snapshot` of `/` if snapper has no config.
  - **Restoring is not `snapper rollback`.** That command is a no-op on this setup because the signed UKI cmdline pins `rootflags=subvol=/@` (see section 1, "Why Limine does not work here" and the rollback note). To actually go back, boot the F11 live and swap `@` with `/.snapshots/<N>/snapshot` as described in section 1.

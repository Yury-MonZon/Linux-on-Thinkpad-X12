## 3. Fingerprint in GNOME's "Authentication Required" dialog

- CachyOS (`chwd`) already adds `pam_fprintd` to `/etc/pam.d/sudo` and GDM.
- GNOME's admin dialog uses polkit, whose default config `/usr/lib/pam.d/polkit-1` has no fingerprint step.

Override it with `/etc/pam.d/polkit-1`:

```
#%PAM-1.0

auth       sufficient   pam_fprintd.so
auth       include      system-auth
account    include      system-auth
password   include      system-auth
session    include      system-auth
```

- Enroll fingers on the machine itself: Settings > System > Users > Fingerprint Login, or `fprintd-enroll`.
- Test with `pkexec true`.
- Password fallback still works.
- Undo: `sudo rm /etc/pam.d/polkit-1`.

### Fingerprint missing on the lock screen after resume

Symptom: sometimes after opening the lid, the lock screen offers only the password.
The journal shows:

```
fprintd: Authorization denied to :1.139 to call method 'Claim' for device 'Synaptics Sensors': Device was already claimed
fprintd: Error closing device after disconnect: endpoint stalled or request not supported
```

Cause:
- fprintd exits about 30 s after its last use, and the lock screen starts it again on every resume.
- If the machine suspends while fprintd is still running (for example, closing the lid again soon after opening it), the lock screen's claim on the reader from before the suspend survives the resume.
- New claims then fail and GNOME hides the fingerprint option.
- Resumes where fprintd had already exited always worked.

Fix: stop fprintd before every suspend.
After resume it is started fresh by D-Bus.
`/etc/systemd/system/fprintd.service.d/stop-before-sleep.conf`:

```
[Unit]
Conflicts=sleep.target
Before=sleep.target

[Service]
# A stop during an active scan can take 10 s and holds up the suspend; kill it after 3 s instead.
TimeoutStopSec=3
```

```
sudo systemctl daemon-reload
```

- If it happens anyway: `sudo systemctl restart fprintd` brings the option back.
- Undo: `sudo rm -r /etc/systemd/system/fprintd.service.d && sudo systemctl daemon-reload`.

### Face unlock with Visage (IR camera)

Windows-Hello-style face unlock using the built-in IR camera, for GUI polkit prompts and the
GNOME lock screen. It is a convenience tier: 2D IR with no depth anti-spoof, so it is less
secure than the fingerprint reader. Everything falls through to fingerprint or password on a
miss, so it cannot lock you out.

**Why not Howdy.** This machine first used `howdy-next`, which was unreliable here:
- The IR sensor's auto-gain ramps slowly (a face sits at mean brightness ~20 for the first
  second, ~68 after ~13 s). Howdy rejected every frame as "too dark" until `dark_threshold`,
  `clahe_clip_limit` and a 20 s scan timeout were tuned, and it still missed often.
- howdy-next has no retry count, so a miss meant waiting out the whole 20 s scan.
- After the GDM 50 to 51 update, its `workaround=native-input` mode used GDM's PAM
  conversation from two threads at once. That piled up hundreds of `gdm-session-worker`
  processes, ran GDM out of file descriptors and triggered a faillock lockout (howdy-next
  issues [#33](https://codeberg.org/nathawat/howdy-next/issues/33) and
  [#28](https://codeberg.org/nathawat/howdy-next/issues/28)). Only the slow synchronous
  `workaround=off` mode was safe at the greeter.

[Visage](https://github.com/sovren-software/visage) (Rust, MIT) replaced it. A daemon keeps the
SCRFD and ArcFace ONNX models loaded and the camera open, and the PAM module asks it over D-Bus.
Measured here: a match in about 1.6 s, every time.

The IR camera is a separate USB function of the Syntek module (174f:118f), not the IPU6
stack, so it is a plain V4L2 node independent of PipeWire and libcamera (the WirePlumber rule
in section 4 that hides the IR camera from apps does not affect Visage):

| | |
|---|---|
| Node | `/dev/video2` (8-bit greyscale `GREY`, 640x480) |
| Stable path | `/dev/v4l/by-path/pci-0000:00:14.0-usb-0:4:1.2-video-index0` |

- The IR emitter fires by itself whenever the IR node streams. `visage discover` reports
  "no quirk" for 174f:118f and the daemon logs "no IR emitter quirk", which is harmless here.
- The daemon holds the node open, but the camera's USB device still runtime-suspends between
  checks (uvcvideo only powers it while streaming), so there is no idle power cost.

**Install.**

```
shelly install aur visage        # or any AUR helper; builds with cargo
sudo visage setup                # downloads the SCRFD + ArcFace models (~182 MB, SHA-256 pinned)
```

The build pulls a prebuilt ONNX Runtime from pyke's CDN through the `ort` crate (upstream
default). The AUR package also installs a D-Bus activation file, so PAM calls made while the
daemon restarts after resume wait instead of failing.

**Configure.** `/etc/systemd/system/visaged.service.d/camera.conf`:

```
[Service]
Environment=VISAGE_CAMERA_DEVICE=/dev/v4l/by-path/pci-0000:00:14.0-usb-0:4:1.2-video-index0
# Liveness disabled: default 0.8 px rejected normal live faces (measured 0.23-0.63 px)
Environment=VISAGE_LIVENESS_ENABLED=0
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now visaged visage-resume
visage status
```

- The default camera is `/dev/video2`, which happens to be right, but the by-path name
  survives renumbering.
- **Liveness.** Visage's passive liveness check measures how far the eye landmarks move across
  the 3 captured frames and rejects anything under 0.8 px as a possible photo. On this
  640x480 sensor a live face moves only 0.23 to 0.63 px, so it rejected about 3 of 4 genuine
  attempts. Visage's own spoof test found it does not stop a hand-held phone either. The IR
  sensor is the real defence: a phone or laptop screen emits no IR and shows up black.
- Keep the default 3 frames per check. 5 frames took 2.4 s instead of 1.6 s, because the
  recognition model runs on every frame.
- `visage-resume.service` restarts the daemon after suspend and hibernation.

**Enrol.** Sit as you normally do when unlocking, look at the screen and hold still for a
couple of seconds:

```
sudo visage enroll --label default
sudo visage enroll --label relaxed    # a second everyday pose: leaning back, tablet
sudo visage list                      # list and enroll need root
visage verify                         # works as the user, exits 0 on a match
```

A second pose raised the worst-case match score from 0.46 to 0.80. With both models, 6 of 6
checks matched at about 1.6 s each in every case tested (threshold 0.40):

| Glasses | Match score |
|---|---|
| Usual glasses (used for enrolment) | 0.80 to 0.95 |
| Other glasses | 0.77 to 0.83 |
| No glasses | 0.71 to 0.84 |

Portrait (tablet) unlock has not been tested with Visage yet. Howdy needed `rotate = 1` for
it, because the bezel camera always captures in landscape.

**PAM wiring.** Lines are tagged `# visage-face`:

| Service | Change |
|---|---|
| `/etc/pam.d/polkit-1` | `auth sufficient pam_visage.so` **before** the `pam_fprintd` line. Face first: a match takes ~1.6 s with no touch; a miss (camera covered) fails in ~1.2 s and the fingerprint prompt follows, then password. With fingerprint first, face only ran after the ~30 s fingerprint timeout. |
| `/etc/pam.d/gdm-password` | these two lines before the first `auth` line (below) |
| `/etc/pam.d/sudo` | nothing (sudo is `NOPASSWD` on this machine) |

```
auth [success=ignore default=1] pam_exec.so quiet /usr/lib/visage/visage-has-session # visage-face
auth [success=done default=ignore] pam_visage.so timeout=6 # visage-face
```

- **Face at unlock, password at boot.** GDM uses `gdm-password` for both the login screen and
  the lock screen. `visage-has-session` exits 0 only when the user already has a session, so
  the face check runs at the lock screen and is skipped at the first login after boot.
- That is deliberate: face (or fingerprint) cannot unlock the GNOME login keyring, which needs
  the password. GDM's `pam_gdm.so` can hand the keyring a disk encryption password, but this
  disk has no LUKS, so typing the password once at boot is the clean option.
- `timeout=6` (default 3 s) covers the daemon restart after resume. Measured: unlocked about 3 s
  after waking from suspend and 2 s after resuming from hibernation.
- PAM strips trailing `# ...` comments, so the tags are not passed to the modules.

**Surviving updates.** `/etc/pam.d/polkit-1` and `/etc/pam.d/gdm-password` are admin overrides
that no package owns, so updates never overwrite them. Modern PAM reads `/etc/pam.d/<svc>` first
and falls back to the vendor copy in `/usr/lib/pam.d/`; GDM 51 moved its files there, which is
what silently dropped face unlock under Howdy. No re-apply hook is needed, so Howdy's
`reapply-howdy-pam` script and `90-howdy-pam.hook` were removed.

General rule this taught: on Arch/CachyOS, keep custom overrides under `/etc/...` (PAM
`/etc/pam.d/`, units `/etc/systemd/system/`, pacman hooks `/etc/pacman.d/hooks/`), which shadow the
`/usr/lib/...` vendor defaults and are never overwritten by package updates.

**Debugging.** `journalctl -u visaged` logs the similarity score and the reason for every
failed check ("no face detected", liveness).

**Undo.** Remove the `# visage-face` lines, then
`sudo systemctl disable --now visaged visage-resume` and `shelly remove aur visage`.
Uninstalling keeps `/var/lib/visage` (models, encrypted face database); delete it by hand.

The faillock lockout from the Howdy incident is still disabled with `deny = 0` in
`/etc/security/faillock.conf` (it still tracks failures but never locks; `pam_faillock` in
`system-auth` has no inline `deny=`, so it reads that file). Set `deny` back to `3` to re-enable it.

---

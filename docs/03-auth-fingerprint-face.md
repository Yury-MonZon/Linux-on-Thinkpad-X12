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

This machine runs `visage-x12` (in `visage-x12/`): upstream Visage plus changes proposed upstream
in issues [#128](https://github.com/sovren-software/visage/issues/128) to
[#131](https://github.com/sovren-software/visage/issues/131) (branches in
[Yury-MonZon/visage](https://github.com/Yury-MonZon/visage)), and saving rejected faces:

| Change | Effect here |
|---|---|
| Models on the Iris Xe GPU through OpenVINO, falls back to the CPU | SCRFD ~250 to 28 ms, ArcFace ~110 to 10 ms per frame |
| One camera stream per check, frames examined as they arrive, stop at the first match | a match in about 0.35 s (about 1.2 s with upstream 0.4.0) |
| Keeps looking for a face for `VISAGE_FACE_WAIT_MS` | unlock works while the Folio is still opening or the sensor is dark after resume |
| `VISAGE_CPU_THREADS` | 4 instead of the fixed 2, for the CPU fallback |
| Saves the face of every check that saw someone who did not match, with a colour photo from the webcam | `~/Pictures/LoginAttempts` |

The first check after a resume takes about 1 s while the camera starts.

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
sudo pacman -S --needed openvino openvino-intel-gpu-plugin intel-compute-runtime
cd visage-x12 && makepkg -si     # replaces the AUR visage package; builds with cargo
sudo visage setup                # downloads the SCRFD + ArcFace models (~182 MB, SHA-256 pinned)
```

The build pulls a prebuilt ONNX Runtime from pyke's CDN through the `ort` crate (upstream
default). OpenVINO is loaded at runtime, so without it the daemon simply uses the CPU. The
package also installs a D-Bus activation file (from the AUR package), so PAM calls made while
the daemon restarts after resume wait instead of failing.

**Configure.** `/etc/systemd/system/visaged.service.d/camera.conf`:

```
[Service]
Environment=VISAGE_CAMERA_DEVICE=/dev/v4l/by-path/pci-0000:00:14.0-usb-0:4:1.2-video-index0
# Liveness disabled: default 0.8 px rejected normal live faces (measured 0.23-0.63 px)
Environment=VISAGE_LIVENESS_ENABLED=0
```

`/etc/systemd/system/visaged.service.d/inference.conf`:

```
[Service]
DeviceAllow=char-drm rw
Environment=VISAGE_INFERENCE_DEVICE=gpu
Environment=VISAGE_CPU_THREADS=4
Environment=VISAGE_FACE_WAIT_MS=4000
Environment=VISAGE_REJECTED_DIR=/var/lib/visage/rejected
Environment=VISAGE_REJECTED_GROUP_READABLE=1
Environment=VISAGE_REJECTED_PHOTO_CAMERA=/dev/v4l/by-path/pci-0000:00:14.0-usb-0:4:1.0-video-index0
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
- `DeviceAllow=char-drm rw` lets the sandboxed service open the GPU. Both `loaded` lines in
  `journalctl -u visaged` then say `device=Gpu`. The first start compiles GPU kernels (about
  4 s) into `/var/lib/visage/gpu-cache` (about 100 MB); later starts load them in 0.3 s.
- Keep the default 3 frames per check: a check stops at the first matching frame anyway.
- `visage-resume.service` restarts the daemon after suspend and hibernation.

**Who tried to unlock it.** Visage keeps every face that failed to match, and takes a colour photo
with it; both land in `~/Pictures/LoginAttempts`:

- `<UTC time>_<user>_<similarity>.png`: the IR frame the check judged (works in the dark).
- `<same name>_rgb.jpg`: a photo from the front webcam, the camera's own 1920x1080 JPEG after
  1 s of auto-exposure, about 1 s after the failed check, so whoever tried is most likely still
  in front of the screen. It is taken in the background and does not delay the answer to PAM.
  The webcam light turns on meanwhile; in a dark room the colour photo is dark, the IR one is not.
- Checks that saw no face store nothing. The newest 1024 are kept (`VISAGE_REJECTED_KEEP`,
  `0` keeps all). It works at the lock screen too: the daemon does it, not the session.

The photos stay in `/var/lib/visage/rejected`, which the sandboxed daemon may write. With
`VISAGE_REJECTED_GROUP_READABLE=1` they are written `0640`, and the directory belongs to the
user's group with the setgid bit, so every new file gets that group. The daemon has no
capability to change a file's group itself, so systemd-tmpfiles creates the directory
(`etc/tmpfiles.d/visage-rejected.conf`):

```
d /var/lib/visage/rejected 2750 root monzon -
```

```
sudo install -m644 etc/tmpfiles.d/visage-rejected.conf /etc/tmpfiles.d/   # change monzon to your user
sudo systemd-tmpfiles --create /etc/tmpfiles.d/visage-rejected.conf
ln -s /var/lib/visage/rejected ~/Pictures/LoginAttempts
```

Deleting a photo in `~/Pictures/LoginAttempts` deletes it for good (it is a link, not a copy).

| Setting | Default | |
|---|---|---|
| `VISAGE_REJECTED_DIR` | off | where rejected faces are kept |
| `VISAGE_REJECTED_KEEP` | `1024` | how many, newest first; `0` keeps all |
| `VISAGE_REJECTED_GROUP_READABLE` | `0` | `1`: files `0640`, for the directory's group |
| `VISAGE_REJECTED_PHOTO_CAMERA` | off | colour webcam for the photo |
| `VISAGE_REJECTED_PHOTO_SIZE` | `1920x1080` | an MJPEG size the camera offers (up to `2592x1944`) |
| `VISAGE_REJECTED_PHOTO_DELAY_MS` | `1000` | auto-exposure time before the photo |

Tested with `VISAGE_SIMILARITY_THRESHOLD=0.99` on a test daemon, so the owner's own face counts
as a stranger: the check answered in 0.45 s, the IR photo was saved with the answer and the colour
photo 1 s later, both readable in `~/Pictures/LoginAttempts` without root.

**Enrol.** Sit as you normally do when unlocking, look at the screen and hold still for a
couple of seconds:

```
sudo visage enroll --label default
sudo visage enroll --label relaxed    # a second everyday pose: leaning back, tablet
sudo visage list                      # list and enroll need root
visage verify                         # works as the user, exits 0 on a match
```

A second pose raised the worst-case match score from 0.46 to 0.80. With both models, 6 of 6
checks matched in every case tested (threshold 0.40):

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
| `/etc/pam.d/polkit-1` | `auth sufficient pam_visage.so` **before** the `pam_fprintd` line. Face first: a match takes well under a second with no touch; a miss (camera covered) ends after the 3 s PAM timeout and the fingerprint prompt follows, then password. With fingerprint first, face only ran after the ~30 s fingerprint timeout. |
| `/etc/pam.d/gdm-password` | these two lines before the first `auth` line (below) |
| `/etc/pam.d/sudo` | nothing (sudo is `NOPASSWD` on this machine) |

```
auth [success=ignore default=1] pam_exec.so quiet /usr/lib/visage/visage-has-session # visage-face
auth [success=done default=ignore] pam_visage.so timeout=7 # visage-face
```

- **Face at unlock, password at boot.** GDM uses `gdm-password` for both the login screen and
  the lock screen. `visage-has-session` exits 0 only when the user already has a session, so
  the face check runs at the lock screen and is skipped at the first login after boot.
- That is deliberate: face (or fingerprint) cannot unlock the GNOME login keyring, which needs
  the password. GDM's `pam_gdm.so` can hand the keyring a disk encryption password, but this
  disk unlocks from the TPM without one, so typing the password once at boot is the clean option.
- `timeout=7` (default 3 s) covers the daemon restart after resume (about 1.2 s) plus the 4 s
  face-wait. Before the face-wait existed, four `pam_visage.so` lines in a row did that job.
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
failed check ("no face detected", liveness), and a `verify timing` line per check:
`capture_ms`, `detect_ms`, `extract_ms`, and `bursts` (how many frame groups the face-wait used).

**Undo.** Remove the `# visage-face` lines and `inference.conf`, then
`sudo systemctl disable --now visaged visage-resume` and `sudo pacman -R visage-x12`
(or install the AUR `visage` again).
Uninstalling keeps `/var/lib/visage` (models, encrypted face database); delete it by hand.

The faillock lockout from the Howdy incident is still disabled with `deny = 0` in
`/etc/security/faillock.conf` (it still tracks failures but never locks; `pam_faillock` in
`system-auth` has no inline `deny=`, so it reads that file). Set `deny` back to `3` to re-enable it.

---

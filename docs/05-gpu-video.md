## 5. GPU: i915 options (HuC, PSR2) and hardware video

The drivers are already complete on CachyOS: i915, Mesa (OpenGL 4.6, Vulkan 1.4), and `intel-media-driver`.
`intel-media-driver` gives hardware decode of H.264, HEVC 8/10-bit, VP9 and AV1.
HuC is off by default on Tiger Lake; enabling it adds the low-power encoder (`EncSliceLP`) for H.264 and HEVC.

Append to `/etc/kernel/cmdline`:

```
i915.enable_guc=2
```

`2` = load HuC only.
GuC firmware is loaded just to authenticate HuC; GPU scheduling stays unchanged.
Do not use `3` on Tiger Lake.

```
sudo mkinitcpio -P      # rebuilds and re-signs the UKIs
# reboot, then:
sudo dmesg | grep -i huc                  # "HuC: authenticated for all workloads"
vainfo | grep EncSliceLP
```

The kernel logs "Setting dangerous option enable_guc - tainting kernel".
That is expected for any non-default value.

Note: on this kernel the i915 auto-default (`enable_guc=-1`) does **not** load HuC on
Tiger Lake. Verified by removing the param: with it gone, dmesg shows no GuC/HuC
firmware lines at all (only DMC), `vainfo` loses the LP encoder, and the taint does
**not** drop (see below). So `enable_guc=2` is doing real work here, not a cosmetic
flag; keep it.

### Panel: silence the i915 PSR2 selective-fetch warning

The boot log shows once:

```
i915 0000:00:02.0: [drm] Selective fetch area calculation failed in pipe A
```

This is from PSR2 (Panel Self Refresh 2) **selective fetch**, a power-saving feature
that redraws only the changed screen regions. The failed calculation is harmless by
itself, but selective fetch is also the part that can cause visible flicker, ghosting,
cursor lag, or stale/unupdated regions on some panels. Disabling just that sub-path
silences the warning and keeps the rest of PSR2's power saving. Also in
`/etc/kernel/cmdline`:

```
i915.enable_psr2_sel_fetch=0
```

so the full X12 i915 command line is `i915.enable_psr2_sel_fetch=0 i915.enable_guc=2`.
Rebuild and reboot the same way (`sudo mkinitcpio -P`, which re-signs the UKIs). After
reboot `sudo dmesg | grep -i 'selective fetch'` is silent. If a panel glitch ever
persists anyway, the next escalation is to force PSR1 (`i915.enable_psr=1`) or disable
PSR entirely (`i915.enable_psr=0`) in place of the sel_fetch line.

### Kernel taint: why /proc/sys/kernel/tainted reads 12352

Both i915 params above, plus the out-of-tree rear-camera driver, flag the kernel as
"tainted". This is purely informational: it tells kernel developers the kernel ran
non-vanilla bits when they read a bug report, and has no effect on performance,
stability, or security. `12352` is three bits (confirm per-module with
`cat /sys/module/*/taint`, where `O` = out-of-tree, `E` = unsigned):

| Bit | Flag | Source |
|---|---|---|
| 64 | TAINT_USER | an "unsafe"-marked i915 param (`enable_psr2_sel_fetch` and `enable_guc` both set it) |
| 4096 | out-of-tree module | `ov8856` rear-camera driver (section 4) |
| 8192 | unsigned module | `ov8856` (same module, not signed into the MOK) |

You cannot reach zero without giving something up: the `64` bit is unavoidable while
using those knobs (both params are marked unsafe and there is no non-tainting
equivalent to toggle HuC or PSR2 selective fetch), the out-of-tree bit stays as long as
the rear-camera driver is loaded, and signing `ov8856` into the MOK would only clear
the unsigned bit (`12352` down to `4160`), never the out-of-tree one. Not worth it;
leave it.

### Video playback: hardware decoding in mpv

mpv does not use the GPU's video decoder by default; everything is decoded on the CPU.
`~/.config/mpv/mpv.conf`:

```
# Use the GPU video decoder (VA-API) when the format supports it; falls back to the CPU otherwise.
hwdec=auto-safe
```

| Format | Decoded by |
|---|---|
| H.264, HEVC (up to 12-bit, 4:4:4), VP9, AV1, MPEG-2, VC-1, VP8 | GPU video engine (VA-API, `iHD` driver) |
| MPEG-4 Part 2 (XviD/DivX `.avi`) | CPU: Tiger Lake has no hardware decoder for it, and mpv skips it ("codec mpeg4 is not on whitelist") |

The full list of hardware decode profiles: `vainfo | grep VLD`.

Measured during playback (CPU package power from the fan logger):
- 1080p H.264 with `hwdec=auto-safe`: video engine 6 % busy, render engine 9 %, mpv about 15 % of one core (mostly 5.1 audio and network), package about 2.2 W, fan off.
- 720x304 XviD (CPU decode): mpv about 15 % of one core, package about 2 W, fan off.
  Low-resolution XviD is cheap enough that the missing hardware path does not matter.

Check it:
- During playback, press Shift+I in mpv: the stats show `hwdec: vaapi`.
- Without a window (`--vo=null`), mpv uses `vaapi-copy`, which still decodes on the GPU but copies frames back to memory.
- Per-process GPU engine time is in `/proc/<pid>/fdinfo/*` (`drm-engine-video` is the decoder):

  ```
  P=$(pgrep -x mpv)
  snap() { cat /proc/$P/fdinfo/* 2>/dev/null | awk '/^drm-engine-[a-z-]+:/{gsub(":","",$1); s[$1]+=$2} END{for(k in s) print k, s[k]}' | sort; }
  A=$(snap); sleep 2; B=$(snap)
  join <(echo "$A") <(echo "$B") | awk '{printf "%-28s %5.1f %% busy\n", $1, ($3-$2)/2e9*100}'
  ```

### Video in Firefox (YouTube)

Firefox (157, CachyOS package) already decodes video on the GPU by default; no setting is needed.
YouTube serves AV1 (`av01` in "Stats for nerds"), which the Tiger Lake video engine decodes.
The decoding runs in Firefox's `rdd` process, which loads the `iHD` VA-API driver.

Measured with a 1080p AV1 YouTube video, default settings, windowed:
- video engine 1.6 % busy, decoder process 2 % CPU (no software decoding)
- GPU render engine about 60 % (Firefox composing the page and the video)
- YouTube tab about 20 % CPU (the player's own code)
- CPU package power about 3.5 W, fan off

For the lowest power, play videos in mpv (about 2.2 W for 1080p): `mpv <youtube-url>` works with `yt-dlp` installed.

Scrolling YouTube's video tiles can stutter on battery.
The tab saturates one core in short bursts, and the Balanced profile on battery (EPP `balance_power`) raises the CPU clock too slowly for them.
The Performance power mode makes it smooth, at a higher power draw while busy.

To measure, use the same `fdinfo` snippet as for mpv: decoding shows as `drm-engine-video` in the `rdd` process, composing as `drm-engine-render` in the main process.

#### Wayland native compositor: tested, not recommended

`gfx.webrender.compositor.force-enabled` makes Firefox hand the video to GNOME as its own surface instead of composing it itself.
It looks like a power saving, but it is not one on GNOME:

- It is not enabled by default in any release Firefox; it remains an opt-in experiment ([meta bug 1617498](https://bugzilla.mozilla.org/show_bug.cgi?id=1617498)).
- It moves the composing work to GNOME Shell rather than removing it.
  Mozilla's own measurements on GNOME: plain video about 10 % CPU, YouTube with rounded corners and overlays about 20 %, because blending them is slow.
- A 2022 test on a low-power Intel chip measured **higher** power with it: +0.3 W on GNOME, 0.5 to 1 W on Sway and KDE, plus scrolling stutter ([bug 1750457](https://bugzilla.mozilla.org/show_bug.cgi?id=1750457)).
- GNOME Wayland has had side effects with it: dialogs that never disappear ([1752678](https://bugzilla.mozilla.org/show_bug.cgi?id=1752678)), freezes in fullscreen or maximized windows ([1714771](https://bugzilla.mozilla.org/show_bug.cgi?id=1714771)).
- On the X12, Firefox's own render load dropped (to 23-50 %, varying with what is on screen), but the CPU package power, which includes GNOME Shell's work, stayed within noise: about 3.0 to 3.4 W against about 3.5 W.

If you tried it, turn it off explicitly in `user.js` and restart Firefox:

```
user_pref("gfx.webrender.compositor.force-enabled", false);
```

Only deleting a `true` line does not work: Firefox saves the value into `prefs.js` on exit, so it stays on.
`false` is the default; Firefox then removes it from `prefs.js` by itself.
After one restart with `false`, delete the line (or the whole `user.js` if nothing else is in it).
`about:config` then shows `false` in normal text; bold only means a value is set by the user, here by `user.js`.

---

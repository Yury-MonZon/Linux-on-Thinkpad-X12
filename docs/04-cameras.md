## 4. Cameras: front webcam and rear camera

| Camera | Hardware | Formats | Frame rate |
|---|---|---|---|
| Front RGB | USB `174f:118f`, interface 1.0 | MJPEG 320x180 to 2592x1944 (13 sizes); YUYV up to 640x480 | 30 fps every size (measured 28.5-30 in a dim room) |
| Front IR | Same USB device, interface 1.2 | GREY 640x480 | For face login (Visage), hidden from camera apps |
| Rear | OmniVision OV8856 (8 MP) behind the Intel IPU6, I2C3, `\_SB_.PC00.LNK0` | Raw Bayer 3280x2464, 3264x2448, 1640x1232, 1632x1224; libcamera turns it into RGB | 30 fps max in every mode (sensor timing: 144 MHz / (hts x vts)); auto-exposure lowers it in the dark (measured 24 fps in a dim room) |

- Snapshot (GNOME Camera) uses 1920x1080 for both: MJPEG from the front camera, and the 3264x2448 raw mode scaled down for the rear.
- The rear picture is processed on the CPU by libcamera's software ISP: about 12.5 ms per frame, roughly a third of one core at 30 fps.
- The rear camera needs patches to its kernel drivers, libcamera and PipeWire.
  The kernel driver fixes are the package `kernel-fixes-x12` (section 13); libcamera and PipeWire rebuild themselves after updates through pacman hooks.

### Front webcam: full frame rate

- The front RGB camera (USB `174f:118f`) had `exposure_dynamic_framerate` on.
- That control let auto-exposure lower the frame rate in dim light: about 9.6 fps in every mode.
- With it off: about 27 fps in a dim room, 30 in good light.

`/etc/udev/rules.d/70-x12-webcam-fps.rules`:

```
# ThinkPad X12 front webcam (Sunplus/Syntek 174f:118f): keep full frame rate in dim light
# instead of letting auto-exposure drop it to ~10 fps. Interface 00 is the RGB camera; the IR
# camera (interface 02) has no such control.
ACTION=="add", SUBSYSTEM=="video4linux", ENV{ID_USB_VENDOR_ID}=="174f", ENV{ID_USB_MODEL_ID}=="118f", ENV{ID_USB_INTERFACE_NUM}=="00", ENV{ID_V4L_CAPABILITIES}=="*:capture:*", RUN+="/usr/bin/v4l2-ctl -d $devnode --set-ctrl=exposure_dynamic_framerate=0"
```

```
sudo pacman -S --needed v4l-utils
sudo udevadm control --reload
sudo udevadm trigger --action=add /sys/class/video4linux/video0
v4l2-ctl -d /dev/video0 --get-ctrl=exposure_dynamic_framerate   # expect 0
```

guvcview saves its own camera settings and can switch this back on.
If that happens, untick "Exposure, Dynamic Framerate" there.

`/dev/video0` is the webcam because of the load-order rule in "Camera apps" below.
Without it, the webcam ends up at `/dev/video64` after the IPU6's 64 nodes.

### Rear camera (OV8856): why it does not work out of the box

With stock packages the rear camera does not work ("failed to find sensor: -5"); no working setup for this model was found online.
The firmware and hardware are fine; the bugs are in software:

1. **The kernel driver never powers the sensor.**
   `ov8856` skips its power, clock and reset handling on ACPI machines (it was written for Chromebooks, whose firmware powers the sensor).
   On the X12, the `int3472` driver offers exactly those lines:
   - avdd = GPP_B20 (`REAR_CAM_PWR_EN`, which switches the sensor's 1.8 V supply)
   - reset = GPP_B22 (`SEN_RST_REAR_CAM`)
   - privacy LED = GPP_B19 (`REAR_CAM_ON`)
   - the 19.2 MHz clock (IMGCLKOUT_0, through the ACPI `CLKC` method)

   `ov8856` never requests any of them, so the sensor stays unpowered and the I2C bus times out.
   The pin names come from the board schematic (Wistron 19835-1).
2. **The driver reports the wrong Bayer order.**
   Asking for the current format resets it to the default, so libcamera's pipeline check fails ("Failed to queue buffer: Broken pipe").
3. **Power management is enabled too late.**
   The autofocus motor (dw9714 VCM) fails to register ("Error -13 runtime-resuming sensor").
4. **Removing the driver turns power off twice** (kernel warnings).
5. **libcamera has no gain model for the OV8856.**
   Auto-exposure cannot raise the gain, so the picture stays dark.
6. **PipeWire only tracks 64 V4L2 devices.**
   With the rear sensor attached, the IPU6 creates 64 nodes, so PipeWire drops the USB webcam and falls back to libcamera for it.
   That path shows random horizontal lines, and Snapshot fails outright with "could not play stream": PipeWire's libcamera plugin passes MJPEG frames zero-padded to the full buffer size.

The kernel is not locked down (`/sys/kernel/security/lockdown` shows `[none]`), so the unsigned patched module loads with Secure Boot on.
It taints the kernel ("O", "E"), which is harmless.

### Rear camera, part 1: patched ov8856 driver

The patch fixes bugs 1 to 4.
It also lets the sensor power off over suspend and hibernation; see "Rear camera after suspend and hibernation" below.
It is part of `kernel-fixes-x12` (section 13), `kernel-fixes/ov8856-x12.patch`:

```diff
--- a/ov8856.c
+++ b/ov8856.c
@@ -2082,9 +2082,6 @@
 	struct ov8856 *ov8856 = to_ov8856(sd);
 	int ret;
 
-	if (is_acpi_node(dev_fwnode(dev)))
-		return 0;
-
 	ret = clk_prepare_enable(ov8856->xvclk);
 	if (ret < 0) {
 		dev_err(dev, "failed to enable xvclk\n");
@@ -2120,9 +2117,6 @@
 	struct v4l2_subdev *sd = dev_get_drvdata(dev);
 	struct ov8856 *ov8856 = to_ov8856(sd);
 
-	if (is_acpi_node(dev_fwnode(dev)))
-		return 0;
-
 	gpiod_set_value_cansleep(ov8856->reset_gpio, 1);
 	regulator_bulk_disable(ARRAY_SIZE(ov8856_supply_names),
 			       ov8856->supplies);
@@ -2187,8 +2181,11 @@
 	if (fmt->which == V4L2_SUBDEV_FORMAT_TRY)
 		fmt->format = *v4l2_subdev_state_get_format(sd_state,
 							    fmt->pad);
-	else
+	else {
+		/* X12 patch: report the active Bayer order instead of resetting it to the default */
+		fmt->format.code = ov8856_mbus_codes[ov8856->cur_mbus_index];
 		ov8856_update_pad_format(ov8856, ov8856->cur_mode, &fmt->format);
+	}
 
 	mutex_unlock(&ov8856->mutex);
 
@@ -2293,7 +2290,8 @@
 		dev_warn(dev, "external clock rate %u is unsupported",
 			 xvclk_rate);
 
-	if (!is_acpi_node(fwnode)) {
+	{
+		/* X12 patch: use the INT3472-provided reset GPIO and regulators on ACPI too */
 		ov8856->reset_gpio = devm_gpiod_get_optional(dev, "reset",
 							     GPIOD_OUT_LOW);
 		if (IS_ERR(ov8856->reset_gpio))
@@ -2374,7 +2372,10 @@
 	pm_runtime_disable(ov8856->dev);
 	mutex_destroy(&ov8856->mutex);
 
-	ov8856_power_off(ov8856->dev);
+	/* X12 patch: only power off if runtime PM left the sensor powered */
+	if (!pm_runtime_status_suspended(ov8856->dev))
+		ov8856_power_off(ov8856->dev);
+	pm_runtime_set_suspended(ov8856->dev);
 }
 
 static int ov8856_probe(struct i2c_client *client)
@@ -2430,21 +2431,26 @@
 		goto probe_error_v4l2_ctrl_handler_free;
 	}
 
+	/* X12 patch: enable runtime PM before registering, so ipu-bridge can power the sensor for the VCM */
+	if (full_power)
+		pm_runtime_set_active(ov8856->dev);
+	pm_runtime_enable(ov8856->dev);
+
 	ret = v4l2_async_register_subdev_sensor(&ov8856->sd);
 	if (ret < 0) {
 		dev_err(ov8856->dev, "failed to register V4L2 subdev: %d",
 			ret);
-		goto probe_error_media_entity_cleanup;
+		goto probe_error_rpm_disable;
 	}
 
-	/* Set the device's state to active if it's in D0 state. */
-	if (full_power)
-		pm_runtime_set_active(ov8856->dev);
-	pm_runtime_enable(ov8856->dev);
 	pm_runtime_idle(ov8856->dev);
 
 	return 0;
 
+probe_error_rpm_disable:
+	pm_runtime_disable(ov8856->dev);
+	pm_runtime_set_suspended(ov8856->dev);
+
 probe_error_media_entity_cleanup:
 	media_entity_cleanup(&ov8856->sd.entity);
 
@@ -2458,7 +2464,13 @@
 	return ret;
 }
 
+/*
+ * The sensor stays runtime active while its VCM is open, and libcamera keeps
+ * that open. Power it off over system sleep and back on afterwards, so that
+ * the clock and supplies are set up again after hibernation.
+ */
 static const struct dev_pm_ops ov8856_pm_ops = {
+	SET_SYSTEM_SLEEP_PM_OPS(pm_runtime_force_suspend, pm_runtime_force_resume)
 	SET_RUNTIME_PM_OPS(ov8856_power_off, ov8856_power_on, NULL)
 };
 
```

Install it with the other driver fixes (section 13), then reboot:

```
install/install-kernel-fixes-x12.sh
modinfo -n ov8856                                        # expect .../extramodules/ov8856.ko.zst
```

After the reboot, `readlink /sys/bus/i2c/devices/i2c-OVTI8856:00/driver` ends in `ov8856`, and `cam -l` lists "Internal back camera".

Never unbind `int3472-discrete` and then force-bind `ov8856` by hand: that caused a kernel oops.
Unbinding just the sensor (`/sys/bus/i2c/drivers/ov8856/unbind`) is safe.

### Rear camera, part 2: libcamera gain model

Without it, auto-exposure leaves the analogue gain at 1x and the picture stays dark ("Failed to create camera sensor helper for ov8856").
`libcamera-ov8856-helper.patch` adds a helper modelled on the OV8858's: linear gain in 1/128 steps, which matches the driver's 128-2047 range.

```diff
--- a/src/ipa/libipa/camera_sensor_helper.cpp
+++ b/src/ipa/libipa/camera_sensor_helper.cpp
@@ -791,6 +791,22 @@ public:
 };
 REGISTER_CAMERA_SENSOR_HELPER("ov64a40", CameraSensorHelperOv64a40)
 
+class CameraSensorHelperOv8856 : public CameraSensorHelper
+{
+public:
+	CameraSensorHelperOv8856()
+	{
+		/*
+		 * Analogue gain register 0x3508/0x3509 in 1/128 steps (128 = 1x),
+		 * as exposed by the kernel driver (range 128 to 2047).
+		 * Black level target 0x40 at 10 bits.
+		 */
+		blackLevel_ = 4096;
+		gain_ = AnalogueGainLinear{ 1, 0, 0, 128 };
+	}
+};
+REGISTER_CAMERA_SENSOR_HELPER("ov8856", CameraSensorHelperOv8856)
+
 class CameraSensorHelperOv8858 : public CameraSensorHelper
 {
 public:
```

Rebuild libcamera from the Arch packaging, at the tag matching the installed version (`pacman -Q libcamera`, here 0.7.2-4):

```
git clone https://gitlab.archlinux.org/archlinux/packaging/packages/libcamera.git ~/build/libcamera
cd ~/build/libcamera && git checkout 0.7.2-4
cp <path-to>/libcamera-ov8856-helper.patch .
```

Edit the `PKGBUILD` (the full diff is `patches/libcamera-PKGBUILD.diff`):
- `pkgname`: keep only `libcamera`, `libcamera-ipa` and `libcamera-tools` (the ones installed).
- `pkgrel=4.2`, so pacman sees it as newer than the repo's 4.1.
- `makedepends`: drop the documentation, GStreamer and Python ones (doxygen, graphviz, gst-plugins-base, pybind11, python-sphinx*, qt6-tools, texlive-core).
- `source`: add `"$pkgbase-ov8856-helper.patch"`, with `'SKIP'` in both checksum arrays.
- `prepare()`: add `patch -Np1 < ../$pkgbase-ov8856-helper.patch`.
- `build()`: `-D test=false -D documentation=disabled -D gstreamer=disabled -D pycamera=disabled`.
- `package_libcamera()`: remove the `_pick` lines for docs, gst-plugin and python.

```
makepkg -s --nocheck
sudo pacman -U libcamera-0.7.2-4.2-x86_64.pkg.tar.zst libcamera-ipa-0.7.2-4.2-x86_64.pkg.tar.zst libcamera-tools-0.7.2-4.2-x86_64.pkg.tar.zst
```

It takes about 10 minutes on the X12, and only pulls in `python-ply` and `python-yaml`.

A repo update of libcamera replaces this build.
`/etc/pacman.d/hooks/zz-x12-libcamera-ov8856.hook` warns when that happens; then rebuild from the new tag:

```
[Trigger]
Type = Package
Operation = Install
Operation = Upgrade
Target = libcamera
Target = libcamera-ipa

[Action]
Description = Checking libcamera still has the X12 ov8856 rear camera patch...
When = PostTransaction
Exec = /bin/sh -c 'pacman -Qi libcamera | grep -q "^Packager *: Unknown Packager" && echo "libcamera: X12 ov8856 patch present." || { echo "=========================================================="; echo " WARNING: libcamera was replaced by the repo version."; echo " The rear camera will be dark (no ov8856 gain model)."; echo " Rebuild: see the rear camera section of the guide."; echo "=========================================================="; }'
```

### Camera apps (PipeWire): two cameras, no stripes

Snapshot, browsers and video-call apps get cameras from PipeWire.
Four pieces make PipeWire offer exactly "Built-in Front Camera" (V4L2) and "Built-in Back Camera" (libcamera).

**1. Patched PipeWire plugins** (`pipewire-x12.patch`, also in `patches/`):
- `v4l2`: track 256 devices instead of 64, so the webcam is not dropped behind the IPU6 nodes.
- `libcamera`: report each frame's real size instead of the buffer size.
  This is not needed for the webcam once it uses V4L2, but it fixes MJPEG through libcamera in general.
- GStreamer `pipewiresrc`: skip a stale first buffer, so the front camera is smooth from the first open after a resume.
  See "Front camera: smooth from the first open" below.

```diff
diff --git a/spa/plugins/libcamera/libcamera-source.cpp b/spa/plugins/libcamera/libcamera-source.cpp
index a9095d4..6bcf518 100644
--- a/spa/plugins/libcamera/libcamera-source.cpp
+++ b/spa/plugins/libcamera/libcamera-source.cpp
@@ -1104,6 +1104,13 @@ void handle_completed_request(struct impl *impl, libcamera::Request *request)
 
 		if (fmd.status != libcamera::FrameMetadata::Status::FrameSuccess)
 			d->chunk->flags |= SPA_CHUNK_FLAG_CORRUPTED;
+
+		/* X12 patch: report the bytes the camera produced, not the buffer size.
+		 * Matters for compressed formats: MJPEG frames otherwise carry the whole
+		 * zero-padded buffer and GStreamer's jpegparse fails. */
+		if (b->outbuf->n_datas == fmd.planes().size() &&
+		    fmd.planes()[i].bytesused > 0 && fmd.planes()[i].bytesused <= d->maxsize)
+			d->chunk->size = fmd.planes()[i].bytesused;
 	}
 
 	request->reuse(libcamera::Request::ReuseFlag::ReuseBuffers);
diff --git a/spa/plugins/v4l2/v4l2-udev.c b/spa/plugins/v4l2/v4l2-udev.c
index df99f7b..71d5ce6 100644
--- a/spa/plugins/v4l2/v4l2-udev.c
+++ b/spa/plugins/v4l2/v4l2-udev.c
@@ -32,7 +32,7 @@
 #include <systemd/sd-login.h>
 #endif
 
-#define MAX_DEVICES	64
+#define MAX_DEVICES	256	/* X12 patch: the IPU6 alone creates 64 nodes */
 
 enum action {
 	ACTION_CHANGE,
diff --git a/src/gst/gstpipewiresrc.c b/src/gst/gstpipewiresrc.c
index e3f525e..2d09cd8 100644
--- a/src/gst/gstpipewiresrc.c
+++ b/src/gst/gstpipewiresrc.c
@@ -724,6 +724,33 @@ static GstBuffer *dequeue_buffer(GstPipeWireSrc *pwsrc)
   if (b == NULL)
           return NULL;
 
+  /* GstBaseSrc turns the delay of the first buffer of a live source into
+   * latency for every later buffer (ts_offset). When the pipeline was slow to
+   * start, the first buffer can be much older than a frame interval, and the
+   * source then waits that long before every buffer. Skip a stale first
+   * buffer; the next frame is at most a frame interval away. */
+  if (pwsrc->check_first_age && pwsrc->is_live &&
+      pwsrc->media_type == SPA_MEDIA_TYPE_video) {
+    struct spa_meta_header *fh = ((GstPipeWirePoolData *) b->user_data)->header;
+    uint64_t now = pw_stream_get_nsec (pwsrc->stream->pwstream);
+    uint64_t max_age = 100 * SPA_NSEC_PER_MSEC;
+
+    if (pwsrc->video_info.fps_n > 0)
+      max_age = SPA_MAX (max_age, 3 * gst_util_uint64_scale (GST_SECOND,
+              pwsrc->video_info.fps_d, pwsrc->video_info.fps_n));
+
+    if (fh && fh->pts > 0 && (uint64_t) fh->pts < now &&
+        now - fh->pts > max_age && now - fh->pts < 10 * SPA_NSEC_PER_SEC &&
+        pwsrc->first_age_drops < 5) {
+      GST_DEBUG_OBJECT (pwsrc, "dropping stale first buffer, %" PRIu64 " ms old",
+          (uint64_t) ((now - fh->pts) / SPA_NSEC_PER_MSEC));
+      pwsrc->first_age_drops++;
+      pw_stream_queue_buffer (pwsrc->stream->pwstream, b);
+      return NULL;
+    }
+    pwsrc->check_first_age = FALSE;
+  }
+
   data = b->user_data;
 
   if (!GST_IS_BUFFER (data->buf)) {
@@ -1770,6 +1797,8 @@ gst_pipewire_src_change_state (GstElement * element, GstStateChange transition)
       GST_DEBUG_OBJECT (this, "activating stream");
 
       pw_thread_loop_lock (this->stream->core->loop);
+      this->check_first_age = TRUE;
+      this->first_age_drops = 0;
       pw_stream_set_active (this->stream->pwstream, true);
       /* if state have been paused for longer time, the underlying node might
        * be moved from idle to suspended, which would mean format cleared via
diff --git a/src/gst/gstpipewiresrc.h b/src/gst/gstpipewiresrc.h
index 4b0f57e..748452f 100644
--- a/src/gst/gstpipewiresrc.h
+++ b/src/gst/gstpipewiresrc.h
@@ -78,6 +78,8 @@ struct _GstPipeWireSrc {
   gboolean flushing_on_remove_buffer;
 
   gboolean is_live;
+  gboolean check_first_age;
+  guint first_age_drops;
   int64_t delay;
   GstClockTime min_latency;
   GstClockTime max_latency;
```

Save it as `/usr/local/src/pipewire-x12/pipewire-x12.patch`.
`/usr/local/bin/x12-pipewire-build` (mode 755) builds only these three plugins from the installed PipeWire version's source (about 20 s) and installs them over the packaged files:

```bash
#!/bin/bash
# Rebuild PipeWire camera plugins with the X12 patches (/usr/local/src/pipewire-x12/pipewire-x12.patch):
#  - v4l2:      track up to 256 V4L2 devices instead of 64. The IPU6 creates 64 nodes, which pushed the
#               USB webcam out of PipeWire's V4L2 monitor and onto the libcamera path (striped picture).
#  - libcamera: report each frame's real size, so MJPEG frames are not passed on zero-padded.
#  - GStreamer pipewiresrc: skip a stale first buffer. GstBaseSrc turns the first buffer's delay into
#               latency for every later buffer, so a slow start (e.g. after resume) made the front
#               camera choppy (about 6 fps) until the camera was reopened.
set -u
[ "$EUID" = 0 ] || exec sudo "$0" "$@"
PATCH=/usr/local/src/pipewire-x12/pipewire-x12.patch
ver=$(pacman -Q libpipewire | awk '{print $2}'); ver=${ver#*:}; ver=${ver%-*}    # 1:1.6.9-1 -> 1.6.9
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if git clone -q --depth 1 --branch "$ver" https://gitlab.freedesktop.org/pipewire/pipewire.git "$tmp/src" 2>/dev/null &&
   patch -s -d "$tmp/src" -p1 < "$PATCH" &&
   meson setup "$tmp/build" "$tmp/src" --buildtype=release -Dauto_features=disabled -Dspa-plugins=enabled \
     -Dlibcamera=enabled -Dv4l2=enabled -Dudev=enabled -Dgstreamer=enabled -Dgstreamer-device-provider=enabled \
     -Dsession-managers=[] -Dexamples=disabled -Dtests=disabled \
     -Dman=disabled -Ddocs=disabled -Dpipewire-alsa=disabled -Dpipewire-jack=disabled -Dpipewire-v4l2=disabled >/dev/null &&
   ninja -C "$tmp/build" spa/plugins/libcamera/libspa-libcamera.so spa/plugins/v4l2/libspa-v4l2.so \
     src/gst/libgstpipewire.so >/dev/null; then
  install -m755 "$tmp/build/spa/plugins/v4l2/libspa-v4l2.so" /usr/lib/spa-0.2/v4l2/libspa-v4l2.so
  [ -d /usr/lib/spa-0.2/libcamera ] && install -m755 "$tmp/build/spa/plugins/libcamera/libspa-libcamera.so" /usr/lib/spa-0.2/libcamera/libspa-libcamera.so
  [ -d /usr/lib/gstreamer-1.0 ] && install -m755 "$tmp/build/src/gst/libgstpipewire.so" /usr/lib/gstreamer-1.0/libgstpipewire.so
  echo "pipewire-x12: patched v4l2, libcamera and GStreamer plugins installed for PipeWire $ver (active after the next login)"
else
  echo "pipewire-x12: FAILED for PipeWire $ver (clone, patch or build); the front camera may show stripes"
  exit 1
fi
```

`/etc/pacman.d/hooks/80-x12-pipewire.hook`:

```
[Trigger]
Type = Package
Operation = Install
Operation = Upgrade
Target = libpipewire
Target = pipewire-libcamera
Target = gst-plugin-pipewire

[Action]
Description = Rebuilding PipeWire camera plugins with the X12 patches...
When = PostTransaction
Exec = /usr/local/bin/x12-pipewire-build
```

`pacman -Qkk libpipewire pipewire-libcamera gst-plugin-pipewire` reports the three plugin files as modified; that is expected.

**2. Which cameras apps see:** `/etc/wireplumber/wireplumber.conf.d/50-x12-cameras.conf`:

```
# ThinkPad X12: which cameras PipeWire offers to apps (Snapshot, browsers, video calls).
monitor.v4l2.rules = [
  {
    # The 64 raw IPU6 capture channels (/dev/video*). Only libcamera can use them;
    # it offers them as "Built-in Back Camera".
    matches = [ { api.v4l2.cap.driver = "isys" } ]
    actions = { update-props = { device.disabled = true } }
  }
  {
    # The IR camera (USB interface 1.2, grey frames only). Visage reads it through V4L2 directly.
    matches = [ { device.bus-path = "~.*-usb-0:4:1\\.2$" } ]
    actions = { update-props = { device.disabled = true } }
  }
  {
    # The RGB webcam (USB interface 1.0): a friendlier name than "Integrated RGB Camera (V4L2)".
    matches = [ { node.name = "~v4l2_input\\.pci-0000_00_14\\.0-usb-0_4_1\\.0.*" } ]
    actions = { update-props = { node.description = "Built-in Front Camera" } }
  }
]
monitor.libcamera.rules = [
  {
    # Same IR camera, in case PipeWire ever falls back to libcamera for the USB cameras.
    matches = [ { api.libcamera.path = "~.*HS04-4:1\\.2-174f:118f" } ]
    actions = { update-props = { device.disabled = true } }
  }
]
```

WirePlumber already prefers V4L2 over libcamera for USB webcams, once the webcam is visible through V4L2.

**3. Webcam first in `/dev/video*`:** `/etc/modprobe.d/x12-camera-order.conf`:

```
# ThinkPad X12: load the USB webcam driver before the IPU6, so the front camera keeps /dev/video0-2
# instead of landing after the 64 IPU6 nodes (apps that list /dev/video*, like guvcview, show it first).
softdep intel_ipu6_isys pre: uvcvideo
```

**4. Apply:**

```
sudo x12-pipewire-build
systemctl --user restart wireplumber pipewire pipewire-pulse     # or log out and in
pw-cli ls Node | grep -A1 'Video/Source'                          # expect only the front and back cameras
```

Notes:
- guvcview and other apps that open `/dev/video*` directly still list the 64 IPU6 channels.
  They cannot be hidden without breaking the rear camera (libcamera needs them).
  Pick the first entry ("Integrated RGB Camera") for the webcam.
- WirePlumber's libcamera instance holds the rear camera while it runs.
  `cam -l` from a terminal lists only the front cameras then; stop WirePlumber briefly (`systemctl --user stop wireplumber`) to test the rear camera with `cam`.

### Front camera: smooth from the first open

- Symptom: the first time the front camera opens after a resume or a boot, the picture is choppy (about 6 fps) and can show torn lines.
  Switching cameras, or opening it again, makes it smooth.
- The camera, the kernel and PipeWire's camera node all deliver 30 fps; the frames are lost in GStreamer's `pipewiresrc`.
- Right after a resume the app's pipeline starts slowly, so the first frame `pipewiresrc` hands on is already about 270 ms old.
  GStreamer's live sources treat the first frame's delay as latency for every later frame (`GstBaseSrc` sets `ts_offset` from it), so the source waits about 270 ms before each frame.
  PipeWire reuses the camera buffers right away, so frames are overwritten during that wait: about 6 fps, some of them torn.
- Fix (third part of `pipewire-x12.patch` above): when the source starts, a first frame older than 3 frame intervals (100 ms at 30 fps) is skipped; the next frame is at most 33 ms away.
  With `GST_DEBUG=pipewiresrc:5` the app logs "dropping stale first buffer, 272 ms old" when it triggers.

### Snapshot: decode the front camera on the GPU

- The front camera sends MJPEG; at 1920x1080 and 30 fps, software decoding (`jpegdec`) takes about 44% of a core, the GPU decoder (`vajpegdec`) about 11%.
- GStreamer never picks `vajpegdec` on its own (rank "none").
  Raising its rank for Snapshot only is safe; system-wide it could break apps that open progressive JPEG files, which it cannot decode.

`~/.local/share/dbus-1/services/org.gnome.Snapshot.service` (Snapshot starts through D-Bus, and this file overrides the packaged one):

```
# ThinkPad X12: decode the front camera's MJPEG on the GPU (VA-API) instead of
# the CPU (11% vs 44% of a core at 1080p30). vajpegdec has rank none by
# default; raised for Snapshot only, since it cannot decode progressive JPEG.
[D-BUS Service]
Name=org.gnome.Snapshot
Exec=/usr/bin/env GST_PLUGIN_FEATURE_RANK=vajpegdec:MAX /usr/bin/snapshot --gapplication-service
```

```
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig
```

Snapshot's CPU use with the front camera drops from 50-60% to about 36% of a core.
Delete the file to undo it.

### Rear camera after suspend and hibernation

Two more bugs only show after hibernation: the rear camera is black until the next reboot.

1. **The IPU6 cannot load its firmware on resume.**
   `ipu6_resume()` authenticates the firmware without setting up the IPU's MMU first; probe does set it up.
   After a normal suspend the security engine still holds the authentication, so nothing is loaded.
   After hibernation the firmware loads again, and the bootloader cannot read it through the uninitialised MMU ("Unexpected magic number 0xffffffeb", "FW authentication failed(-110)").
   Mainline (7.3-rc7) still has this bug.
   `kernel-fixes-x12` (section 13), `kernel-fixes/ipu6-hibernate.patch`:

   ```diff
   diff --git a/ipu6.c b/ipu6.c
   index 5449a2006..6034f6a0b 100644
   --- a/ipu6.c
   +++ b/ipu6.c
   @@ -776,10 +776,24 @@ static int ipu6_resume(struct device *dev)
    		return 0;
    	}
    
   +	/*
   +	 * The bootloader fetches the firmware through the PSYS MMU, so set it
   +	 * up as probe does. After suspend the CSE keeps the authentication and
   +	 * nothing is loaded, but after hibernation the firmware is loaded again.
   +	 */
   +	ret = ipu6_mmu_hw_init(isp->psys->mmu);
   +	if (ret) {
   +		dev_err(&isp->pdev->dev, "Failed to set MMU hardware\n");
   +		goto out_rpm_put;
   +	}
   +
    	ret = ipu6_buttress_authenticate(isp);
    	if (ret)
    		dev_err(&isp->pdev->dev, "FW authentication failed(%d)\n", ret);
    
   +	ipu6_mmu_hw_cleanup(isp->psys->mmu);
   +
   +out_rpm_put:
    	pm_runtime_put(&isp->psys->auxdev.dev);
    
    	return 0;
   ```

2. **The sensor never powers down.**
   WirePlumber's libcamera keeps the autofocus motor's device open, and the motor keeps the sensor powered through a device link, so the sensor and its 19.2 MHz clock run all the time.
   `ov8856` has no system sleep callbacks, so suspend and hibernation leave it alone.
   After hibernation the clock output is off (the PCH lost power) and nothing turns it back on: "ov8856 failed to write reg 0x0103 error -5".
   The last hunk of `ov8856-x12.patch` above adds the callbacks, so the sensor powers off over every suspend and back on (clock included) afterwards.
   It also saves power: suspends draw about 0.2 W instead of about 0.5 W (section 12).

### Rear camera: limits

- The picture is software-processed: usable, not phone-grade.
  Auto-exposure takes a few seconds to settle in the dark.
- About 1 in 15 full-resolution raw frames showed an IPU6 "Transfer FIFO overflow" in testing.
- The autofocus motor registers (dw9714), but libcamera's software ISP does not drive autofocus.
  The lens stays at its rest position.
- These patches are not upstream yet.
  If a future libcamera or PipeWire includes them, the build script's `patch` step fails, and the stock code takes over.
  For the kernel drivers, see "When a new kernel breaks a patch" in section 13.

---

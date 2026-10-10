## 7. LTE modem (Fibocom L850-GL) and GPS

### Situation

- WWAN models have a Fibocom L850-GL (Intel XMM7360, PCI ID `8086:7360`) on PCIe.
- The in-kernel `iosm` driver binds it and creates `wwan0` (network), `wwan0at0`, `wwan0at1` (AT) and `wwan0xmmrpc0` (RPC).
- ModemManager 1.24.x (current repo version) stops with "Intel XMM7360 in RPC mode not supported".
  Support arrived in the 1.25 development series (1.25.95 or newer; 1.26 stable once released).
- The modem is FCC-locked: until unlocked, enabling fails with "Modem is FCC locked."
- SIM: one nano-SIM tray on the side. There is no eSIM inside the modem (no second SIM slot: `AT+GTDUALSIM` is not supported).
  Lenovo's eSIM option was a removable Gemalto eUICC card in the tray; a third-party removable eSIM card can replace it.
- The antennas run along the top (camera) edge; GPS shares the WWAN antennas.

### Install ModemManager 1.25.95 (no library downgrade)

The AUR package `modemmanager-dev` depends on `libmbim-dev`/`libqmi-dev`, which are older than the repo `libmbim` 1.34 / `libqmi` 1.38.
ModemManager only needs libmbim >= 1.32 and libqmi >= 1.37.95, so build it against the repo libraries:

```
git clone https://aur.archlinux.org/modemmanager-dev.git
cd modemmanager-dev
sed -i -e 's/^  libmbim-dev$/  libmbim/' -e 's/^  libqmi-dev$/  libqmi/' PKGBUILD
makepkg -s --nocheck
sudo pacman -U libmm-glib-dev-*.pkg.tar.zst modemmanager-dev-*.pkg.tar.zst   # answer yes to replacing modemmanager/libmm-glib
sudo systemctl enable --now ModemManager
mmcli -L     # -> [Fibocom] L850 LTE Module
```

Undo: `sudo pacman -S modemmanager libmm-glib`.

### FCC unlock

ModemManager ships an unlock script for this modem but does not enable it by default (regulatory reasons). Enable it:

```
sudo ln -s /usr/share/ModemManager/fcc-unlock.available.d/8086:7360 /etc/ModemManager/fcc-unlock.d/8086:7360
sudo systemctl restart ModemManager
mmcli -m any | grep -E 'state|power'     # state: enabled, power state: on
```

The script needs `xxd` and performs the challenge/response unlock over `wwan0xmmrpc0`. It then runs automatically at every boot.

### Insert a SIM and connect

- Insert the SIM with the computer **powered off**. The modem does not notice a SIM inserted while running or asleep.
- Check: `mmcli -m any` (registration should become `home` or `roaming`), `mmcli -i any` (SIM details).
- Create the connection in GNOME Settings > Mobile Network, or:

  ```
  nmcli connection add type gsm ifname '*' con-name lte apn <your-apn>
  ```

- "SIM wrong" / registration `denied` means the network rejects the SIM (for example an expired or inactive SIM), not a Linux problem.
  `sudo mmcli -m any --3gpp-scan` should still list the nearby networks, which proves the radio and antennas work.
- After power-on the modem stays at registration `idle` and does not search for a network on its own.
  An autoconnecting NetworkManager mobile connection registers it when it connects; without one (for example, to use a roaming SIM without data), register by hand:

  ```
  sudo mmcli -m any --3gpp-register-home     # automatic network selection; also registers when roaming
  ```

- After sleep, ModemManager re-detects the modem with a new number (`/Modem/1`, `/Modem/2`, ...), so use `mmcli -m any` rather than `-m 0`.
  Signal polling and GPS are off on the new modem object; turn them on again (Satellite and geoclue do this themselves).
  A brief s2idle sleep was survived fine here, and the modem even re-registered on its own.

### Mobile signal

- The signal percentage in `mmcli -m any` is coarse. For real values, turn on signal polling (resets when ModemManager restarts):

  ```
  sudo mmcli -m any --signal-setup=3
  watch -n 3 mmcli -m any --signal-get
  ```

- How to read the LTE values:

  | Value | Good | Fair | Poor |
  |---|---|---|---|
  | RSRP (strength) | above -90 dBm | -90 to -105 dBm | below -110 dBm |
  | RSRQ (quality) | above -10 dB | -10 to -15 dB | below -15 dB |
  | s/n (SNR) | above 10 dB | 0 to 10 dB | below 0 dB |

- Position matters a lot: the antennas are along the top (camera) edge and the back is metal.
  Measured on the same spot and network: lying flat on a desk -99 to -110 dBm, SNR -3 to 0 dB; top edge toward the window -87 dBm, SNR 7 dB.
- Covering the top edge with a hand should change RSRP noticeably; if it does not, check the antenna cables (red = main, blue = auxiliary, under the screen).
- To compare with a phone, make sure both are on the same operator: different operators use different towers.

### GPS

- The modem has GPS (`gps-raw`, `gps-nmea`) and works without a SIM.
- Satellite (Flathub: `page.codeberg.tpikonen.satellite`) shows satellites, signal bars, fix and position, and records GPX tracks.
  It talks to ModemManager directly.
- CLI:

  ```
  mmcli -m any --location-enable-gps-raw --location-enable-gps-nmea
  watch -n 5 mmcli -m any --location-get
  mmcli -m any --location-disable-gps-nmea --location-disable-gps-raw   # when done, saves power
  ```

- Do not use `--location-set-gps-refresh-rate`: here it silently switched GPS off again.
- GPS and mobile signal together:

  ```
  watch -n 3 'mmcli -m any --signal-get | grep -E "rsrp|rsrq|s/n"; mmcli -m any --location-get | grep -E "GSV|GGA"'
  ```

  - `$GPGSV` (GPS), `$GLGSV` (GLONASS), `$GAGSV` (Galileo): satellites in view; the last number of each satellite group is its signal in dB (30+ is good).
  - `$GNGGA`: field 7 is the fix (0 = none, 1 = fix), field 8 the number of satellites used; coordinates appear in fields 3-6 once there is a fix.
- The local desktop user may read the location without sudo (polkit `allow_active`).
  Over SSH this fails with "not authorized for 'org.freedesktop.ModemManager1.Location'".
  To allow your user from any session, `/etc/polkit-1/rules.d/50-x12-modem-location.rules` (mode 644, applies immediately):

  ```js
  // ThinkPad X12: let <your-user> read the modem's GPS/location via ModemManager from any session (e.g. SSH).
  polkit.addRule(function(action, subject) {
      if (action.id == "org.freedesktop.ModemManager1.Location" && subject.user == "<your-user>") {
          return polkit.Result.YES;
      }
  });
  ```

- First fix from cold can take 5-15 minutes; keep the top edge toward the sky. Indoors, expect no fix.
  By a window it heard GPS and GLONASS satellites at 22-35 dB within minutes, but needs about 4 for a fix.

### Do not send raw AT commands to the modem

- Stopping ModemManager and talking to `/dev/wwan0at1` directly upset this modem every time it was tried here:
  - `AT+CFUN=0` crashed the modem firmware (kernel: `iosm ... confused phase`, `PORT open refused, phase A-CD_READY`).
    The next suspend then froze the whole system; only a forced power-off recovered it.
  - Even read-only queries and a network scan left the modem stuck afterwards (`iosm ... msg timeout`, ModemManager "modem is unusable").
- Use `mmcli` only. If the modem gets stuck, **power off** (not Suspend, not Restart), wait 10 s, power on.

### Driver fix: suspend and resume error handling

The X12 firmware enables WWAN power management (`\_SB.PC00.RP01._S0W` returns 4), so `iosm` runs a sleep handshake with the modem on every suspend.
When the modem does not answer, as after the firmware crash above, the driver mishandles it:

1. A handshake that times out leaves the driver's host power state at "waiting to sleep".
   Every later resume and suspend then refuses to run, and every message to the modem is held back for good, so the modem is dead until a reboot.
2. The suspend callback ignores the handshake result and always reports success.
3. An interrupted wait counts as a successful one (`wait_for_completion_interruptible_timeout` returns a negative number).
4. The wait reuses its completion without resetting it, so a late answer from one suspend can fake success for the next.
5. The BIOS power mode answer (`_DSM`) is read as an integer without checking its type.

None of these triggered in normal use here; they matter once the modem stops answering.
`iosm-x12` (section 13) fixes all five.
A suspend still goes ahead when the modem does not answer (blocking it would keep the laptop awake in a bag); the driver logs "CP did not enter host sleep" instead.

`dkms/iosm-x12/iosm-pm.patch`:

```diff
diff --git a/iosm_ipc_imem.c b/iosm_ipc_imem.c
index 4405c8531..a3feb8abd 100644
--- a/iosm_ipc_imem.c
+++ b/iosm_ipc_imem.c
@@ -1031,9 +1031,9 @@ struct ipc_mem_channel *ipc_imem_channel_open(struct iosm_imem *ipc_imem,
 	return NULL;
 }
 
-void ipc_imem_pm_suspend(struct iosm_imem *ipc_imem)
+bool ipc_imem_pm_suspend(struct iosm_imem *ipc_imem)
 {
-	ipc_protocol_suspend(ipc_imem->ipc_protocol);
+	return ipc_protocol_suspend(ipc_imem->ipc_protocol);
 }
 
 void ipc_imem_pm_s2idle_sleep(struct iosm_imem *ipc_imem, bool sleep)
diff --git a/iosm_ipc_imem.h b/iosm_ipc_imem.h
index 5664ac507..d20cba382 100644
--- a/iosm_ipc_imem.h
+++ b/iosm_ipc_imem.h
@@ -401,8 +401,10 @@ void ipc_imem_pm_s2idle_sleep(struct iosm_imem *ipc_imem, bool sleep);
  * ipc_imem_pm_suspend - The HAL shall ask the shared memory layer
  *			 whether D3 is allowed.
  * @ipc_imem:	Pointer to imem data-struct
+ *
+ * Returns: true if CP accepted host sleep, false otherwise.
  */
-void ipc_imem_pm_suspend(struct iosm_imem *ipc_imem);
+bool ipc_imem_pm_suspend(struct iosm_imem *ipc_imem);
 
 /**
  * ipc_imem_pm_resume - The HAL shall inform the shared memory layer
diff --git a/iosm_ipc_pcie.c b/iosm_ipc_pcie.c
index 49052eb51..cbf2be2df 100644
--- a/iosm_ipc_pcie.c
+++ b/iosm_ipc_pcie.c
@@ -244,7 +244,8 @@ static enum ipc_pcie_sleep_state ipc_pcie_read_bios_cfg(struct device *dev)
 		goto default_ret;
 	}
 
-	object = acpi_evaluate_dsm(handle_acpi, &wwan_acpi_guid, 0, 3, NULL);
+	object = acpi_evaluate_dsm_typed(handle_acpi, &wwan_acpi_guid, 0, 3,
+					 NULL, ACPI_TYPE_INTEGER);
 	if (!object)
 		goto default_ret;
 
@@ -379,8 +380,14 @@ static int __maybe_unused ipc_pcie_resume_s2idle(struct iosm_pcie *ipc_pcie)
 
 int __maybe_unused ipc_pcie_suspend(struct iosm_pcie *ipc_pcie)
 {
-	/* The HAL shall ask the shared memory layer whether D3 is allowed. */
-	ipc_imem_pm_suspend(ipc_pcie->imem);
+	/* The HAL shall ask the shared memory layer whether D3 is allowed.
+	 * A modem that does not answer must not block system suspend, so
+	 * only report it.
+	 */
+	if (!ipc_imem_pm_suspend(ipc_pcie->imem)) {
+		dev_warn(ipc_pcie->dev, "CP did not enter host sleep");
+		return 0;
+	}
 
 	dev_dbg(ipc_pcie->dev, "SUSPEND done");
 	return 0;
diff --git a/iosm_ipc_pm.c b/iosm_ipc_pm.c
index 413601c72..09456cd50 100644
--- a/iosm_ipc_pm.c
+++ b/iosm_ipc_pm.c
@@ -73,6 +73,11 @@ bool ipc_pm_wait_for_device_active(struct iosm_pm *ipc_pm)
 	bool ret_val = false;
 
 	if (ipc_pm->ap_state != IPC_MEM_DEV_PM_ACTIVE) {
+		/* Drop a completion left over from an earlier wait that timed
+		 * out just before CP answered.
+		 */
+		reinit_completion(&ipc_pm->host_sleep_complete);
+
 		/* Complete all memory stores before setting bit */
 		smp_mb__before_atomic();
 
@@ -84,9 +89,12 @@ bool ipc_pm_wait_for_device_active(struct iosm_pm *ipc_pm)
 		/* Complete all memory stores after setting bit */
 		smp_mb__after_atomic();
 
-		if (!wait_for_completion_interruptible_timeout
-		   (&ipc_pm->host_sleep_complete,
-		    msecs_to_jiffies(IPC_PM_ACTIVE_TIMEOUT_MS))) {
+		/* CP may have become active before the bit was set, in which
+		 * case nobody completes the wait.
+		 */
+		if (ipc_pm->ap_state != IPC_MEM_DEV_PM_ACTIVE &&
+		    !wait_for_completion_timeout(&ipc_pm->host_sleep_complete,
+						 msecs_to_jiffies(IPC_PM_ACTIVE_TIMEOUT_MS))) {
 			dev_err(ipc_pm->dev,
 				"PM timeout. Expected State:%d. Actual: %d",
 				IPC_MEM_DEV_PM_ACTIVE, ipc_pm->ap_state);
diff --git a/iosm_ipc_protocol.c b/iosm_ipc_protocol.c
index 527355a67..373bfc338 100644
--- a/iosm_ipc_protocol.c
+++ b/iosm_ipc_protocol.c
@@ -177,7 +177,7 @@ void ipc_protocol_s2idle_sleep(struct iosm_protocol *ipc_protocol, bool sleep)
 bool ipc_protocol_suspend(struct iosm_protocol *ipc_protocol)
 {
 	if (!ipc_pm_prepare_host_sleep(&ipc_protocol->pm))
-		goto err;
+		return false;
 
 	ipc_task_queue_send_task(ipc_protocol->imem,
 				 ipc_protocol_tq_wakeup_dev_slp, 0, NULL, 0,
@@ -191,20 +191,26 @@ bool ipc_protocol_suspend(struct iosm_protocol *ipc_protocol)
 	/* Send the sleep message for sync sys calls. */
 	dev_dbg(ipc_protocol->dev, "send TARGET_HOST, ENTER_SLEEP");
 	if (ipc_protocol_msg_send_host_sleep(ipc_protocol,
-					     IPC_HOST_SLEEP_ENTER_SLEEP)) {
-		/* Sending ENTER_SLEEP message failed, we are still active */
-		ipc_protocol->pm.host_pm_state = IPC_MEM_HOST_PM_ACTIVE;
+					     IPC_HOST_SLEEP_ENTER_SLEEP))
 		goto err;
-	}
 
 	ipc_protocol->pm.host_pm_state = IPC_MEM_HOST_PM_SLEEP;
 	return true;
 err:
+	/* Host sleep was not entered, we are still active. Leaving the state
+	 * at SLEEP_WAIT_D3 would make every later resume and suspend fail
+	 * and hold back all doorbells to CP.
+	 */
+	ipc_protocol->pm.host_pm_state = IPC_MEM_HOST_PM_ACTIVE;
 	return false;
 }
 
 bool ipc_protocol_resume(struct iosm_protocol *ipc_protocol)
 {
+	/* Host sleep was not entered on suspend, so there is nothing to exit. */
+	if (ipc_protocol->pm.host_pm_state == IPC_MEM_HOST_PM_ACTIVE)
+		return true;
+
 	if (!ipc_pm_prepare_host_active(&ipc_protocol->pm))
 		return false;
 
```

```
sudo install/install-dkms-x12.sh iosm-x12
```

---

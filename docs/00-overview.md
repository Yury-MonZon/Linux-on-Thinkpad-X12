# ThinkPad X12 Detachable Gen 1 on CachyOS: setup and fixes

Tested on: ThinkPad X12 Detachable Gen 1 (20UV series, i5-1140G7, BIOS R1GET68W 1.43),
CachyOS with GNOME 50 (Wayland), kernels linux-cachyos 7.2 and linux-cachyos-lts 6.18.

Each section is independent. Replace placeholders in `<angle brackets>` with your own values.

Contents:

1. Secure Boot with shim + systemd-boot (when the BIOS keys are locked), with recovery boot options
2. Keyboard backlight: 3-step Fn+Space with a matching OSD
3. Fingerprint in GNOME's "Authentication Required" dialog
4. Cameras: front webcam and rear camera (the rear needs patched drivers, libcamera and PipeWire)
5. GPU: enable HuC (hardware low-power encoder), hardware video decoding in mpv and Firefox
6. Quieter fan curve with thinkfan
7. LTE modem (Fibocom L850-GL) and GPS
8. What does not work (and what to avoid)
9. Optional extras
10. Speaker correction (Dolby tuning via EasyEffects)
11. F11 recovery: a CachyOS live image on the internal disk
12. Sleep, hibernation and battery: sleep log, hibernation, suspend-then-hibernate, Hibernate in the power menu, lazy RCU
13. Kernel driver fixes as DKMS packages (ov8856, ipu6, hid-lenovo, iosm)
14. Sensors: accelerometer, gyroscope, rotation lock, WWAN P-sensor, lap mode, lid and Folio
15. Touch feedback: click and long-press sounds for touch on GNOME Shell (fake haptics)
16. On-screen keyboard: word suggestions (English and Russian), Android and laptop layouts, offline dictation and size settings (OSK Tweaks extension)

---

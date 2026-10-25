## 1. Secure Boot with shim + systemd-boot

### Situation

- Secure Boot is on and the BIOS does not allow switching it off, resetting to Setup Mode or clearing keys.
  So `sbctl enroll-keys` is impossible.
- The CachyOS installer was booted through Ventoy, whose shim was trusted after enrolling Ventoy's key in MokManager.
- After install, the default bootloader (Limine) is rejected.

> **Update, October 2026:** Secure Boot is back on, now with the sbctl keys enrolled in the firmware itself (supervisor password available).
> systemd-boot boots directly, shim is only kept for F11.
> See "Own keys in the firmware" at the end of this section.
> The shim + MOK chain below is still the way without the supervisor password.

### Why Limine does not work here

Microsoft-signed shim only starts a second-stage loader that has an `.sbat` section.
Limine has none, so shim refuses it with "Security Violation" whatever key signed it.
Adding the section yourself works (see "Limine under shim" at the end of this section).
systemd-boot and systemd-stub (unified kernel images, UKI) do have `.sbat`.

Check a binary with:

```
objdump -h <file.efi> | grep sbat
```

### Resulting boot chain

```
firmware (Microsoft keys) -> shimx64.efi (Microsoft-signed, Fedora build)
  -> grubx64.efi = systemd-boot, signed with your own key (enrolled as MOK)
  -> /boot/EFI/Linux/*.efi = UKIs, signed with the same key
```

### Steps

Do this from the CachyOS live ISO (booted through Ventoy) with the installed system mounted at `/mnt`
(root subvolume `/@` at `/mnt`, ESP at `/mnt/boot`), unless a step says otherwise.

1. Create your signing keys (they are used as the MOK):

   ```
   sudo arch-chroot /mnt pacman -S --needed sbctl mokutil efibootmgr
   sudo arch-chroot /mnt sbctl create-keys
   ```

2. Remove the Limine tooling.
   It replaces mkinitcpio with its own wrapper and pacman hooks:

   ```
   sudo arch-chroot /mnt pacman -Rns limine-snapper-sync limine-mkinitcpio-hook limine
   sudo rm -f /mnt/etc/mkinitcpio.conf.d/10-limine-snapper-sync.conf
   ```

   Booting into snapper snapshots from the boot menu is lost.
   Snapshots are still taken, but `snapper rollback` has no effect here: it changes the btrfs default subvolume, and the kernel command line pins `rootflags=subvol=/@`.
   Roll back manually from the live system instead (see "Recovery boot options" below).

3. Build UKIs with mkinitcpio.
   Put the kernel command line from the old `limine.conf` into `/mnt/etc/kernel/cmdline`, for example:

   ```
   quiet nowatchdog splash rw rootflags=subvol=/@ root=UUID=<root-fs-uuid>
   ```

   In each `/mnt/etc/mkinitcpio.d/linux-cachyos*.preset`, comment out `default_image=` and set:

   ```
   default_uki="/boot/EFI/Linux/cachyos-linux-cachyos.efi"        # linux-cachyos.preset
   default_uki="/boot/EFI/Linux/cachyos-linux-cachyos-lts.efi"    # linux-cachyos-lts.preset
   ```

   Then build them.
   sbctl's mkinitcpio post-hook signs them automatically:

   ```
   sudo mkdir -p /mnt/boot/EFI/Linux
   sudo arch-chroot /mnt mkinitcpio -P
   ```

4. Install systemd-boot:

   ```
   sudo arch-chroot /mnt bootctl install --esp-path=/boot --no-variables
   printf "timeout menu-hidden\ndefault cachyos-linux-cachyos.efi\neditor no\n" | sudo tee /mnt/boot/loader/loader.conf
   ```

   The default is pinned to the main kernel.
   The menu is hidden; tap Space at power-on to show it (section 9, "Boot time").
   With `default @saved` the menu boots whatever was picked last time, so one boot into "Known good" would make it the default.

5. Get the Microsoft-signed shim.
   This is Fedora's build, the same files the AUR `shim-signed` package uses.
   Verify the checksum:

   ```
   cd /tmp
   curl -LO https://kojipkgs.fedoraproject.org/packages/shim/16.1/7/x86_64/shim-x64-16.1-7.x86_64.rpm
   echo "642f7bd66f9d420fed5d5686d968a2065af445b4e7ba3d27a0a4f5852aefadd1835c485968e7bdc7cea5f377095bd3efcc8636837e3059a19cfab1c777e218f0  shim-x64-16.1-7.x86_64.rpm" | sha512sum -c
   mkdir shimx && cd shimx && bsdtar xf ../shim-x64-16.1-7.x86_64.rpm
   S=usr/lib/efi/shim/16.1-7/EFI/fedora
   sudo install -Dm0644 $S/shimx64.efi $S/mmx64.efi -t /mnt/usr/share/shim-signed/
   sudo mkdir -p /mnt/boot/EFI/cachyos
   sudo cp $S/shimx64.efi $S/mmx64.efi /mnt/boot/EFI/cachyos/
   ```

6. Put systemd-boot next to shim as `grubx64.efi`, the name shim loads by default.
   `-s` stores the mapping in sbctl's database, so sbctl's pacman hook re-signs it after every systemd update:

   ```
   sudo arch-chroot /mnt sbctl sign -s -o /boot/EFI/cachyos/grubx64.efi /usr/lib/systemd/boot/efi/systemd-bootx64.efi
   sudo arch-chroot /mnt sbctl sign -s /boot/EFI/systemd/systemd-bootx64.efi
   sudo arch-chroot /mnt sbctl verify
   ```

   In the `sbctl verify` output, `shimx64.efi` and `mmx64.efi` show as unsigned.
   That is expected: they carry Microsoft's signature, not yours.

7. Create the boot entry.
   Adjust the disk and partition to your ESP:

   ```
   sudo efibootmgr --create --disk /dev/nvme0n1 --part 1 --label "CachyOS (shim)" --loader '\EFI\cachyos\shimx64.efi'
   ```

   Do not pass a second-stage path with `--unicode`.
   On this machine shim ignored it ("start image not found").

8. Queue your key for MokManager:

   ```
   sudo openssl x509 -in /mnt/var/lib/sbctl/keys/db/db.pem -outform DER -out /mnt/var/lib/sbctl/keys/db/db.der
   sudo arch-chroot /mnt mokutil --import /var/lib/sbctl/keys/db/db.der    # set a one-time password
   ```

   "Failed to get Subject Key ID" is harmless.
   Check with `mokutil --list-new`.

9. Reboot and remove the USB stick.
   On the blue MokManager screen, press a key within 10 s, then choose Enroll MOK -> Continue -> Yes, enter the password, and Reboot.

### Result and maintenance

- Kernel updates: mkinitcpio rebuilds the UKIs and sbctl's post-hook signs them.
- systemd updates: sbctl's pacman hook re-signs `grubx64.efi`.
- Check anytime with `sudo sbctl verify`.
- Do NOT run `sbctl enroll-keys` (firmware keys are locked).
  Do NOT install CachyOS's Limine tooling (`limine-mkinitcpio-hook`): it takes over UKI generation.
  The `limine` package alone is harmless (see "Limine under shim").
- If a BIOS reset deletes the boot entry, F12 -> NVMe0 still boots (see the fallback path below).
  Recreate the entry with the `efibootmgr` line above.
- Be careful with "UEFI dbx" / Secure Boot revocation updates from fwupd.
  A future one could revoke this shim version.
  The fix is then copying a newer Fedora shim into `/boot/EFI/cachyos/`, `/boot/EFI/BOOT/` (as `BOOTX64.EFI` and `Lenovobt.efi`) and p4's `\EFI\BOOT\` (section 11).
- Keep a Ventoy stick for what the recovery options below cannot cover.

### Recovery boot options (no USB stick needed)

| What broke | Boot this |
|---|---|
| A kernel or initramfs update does not boot, or new UKIs ended up unsigned | Boot menu -> **Known good** |
| The installed system itself (root filesystem, pacman, `/etc`, GNOME, drivers) | **F11** at power-on, or F12 -> **CachyOS Live** (live ISO from disk, section 11) |
| systemd-boot itself | **F11**, or F12 -> **CachyOS Live** (shim starts the live ISO directly) |
| The "CachyOS (shim)" firmware entry is gone (BIOS reset) | F12 -> **NVMe0** (firmware fallback path; after section 11 it starts the live system, recreate the entry from there) |
| Your MOK key was wiped from the firmware | MokManager -> Enroll key from disk, with a copy of `db.der` kept on the ESP (not tested) |
| An update left a boot file unsigned | A pacman hook warns before you reboot |

Not covered (keep the Ventoy stick):
- A dbx/SBAT revocation of the Fedora shim. Every entry goes through the same shim.
- A dead SSD or a corrupted ESP.

Layout on the ESP:

```
/boot/EFI/cachyos/   shimx64.efi, mmx64.efi, grubx64.efi (= systemd-boot)   "CachyOS (shim)" entry
/boot/EFI/BOOT/      BOOTX64.EFI (= shim), mmx64.efi, grubx64.efi   firmware fallback path
                     grubx64.efi is systemd-boot until section 11 replaces it with the live UKI (+ Lenovobt.efi for F11)
/boot/EFI/rescue/    known-good.efi
/boot/loader/entries/known-good.conf
```

#### 1. Firmware fallback path

`bootctl install` puts an unsigned systemd-boot at `EFI/BOOT/BOOTX64.EFI`, which Secure Boot rejects.
Replace it with shim and a signed systemd-boot.
`bootctl update` leaves a non-systemd-boot `BOOTX64.EFI` alone.

```
sudo cp /usr/share/shim-signed/shimx64.efi /boot/EFI/BOOT/BOOTX64.EFI
sudo cp /usr/share/shim-signed/mmx64.efi /boot/EFI/BOOT/
sudo sbctl sign -o /boot/EFI/BOOT/grubx64.efi /usr/lib/systemd/boot/efi/systemd-bootx64.efi
```

No `-s` here: sbctl's database has one entry per source file, so saving this mapping would replace step 6's `EFI/cachyos/grubx64.efi` one.
That happened on the author's machine: the real `EFI/cachyos/grubx64.efi` stopped being updated, and every systemd update wrote systemd-boot over the F11 live image (section 11) in `EFI/BOOT/grubx64.efi`.

#### 2. Known good entry

A copy of a UKI that booted fine.
No pacman hook, mkinitcpio run or sbctl re-sign touches it, so a bad update cannot break it.
It still boots your installed root filesystem.

`/usr/local/bin/x12-mark-known-good` (mode 755) copies the UKI that booted this session:

```bash
#!/bin/bash
# Freeze the UKI that booted this session as the "Known good" boot menu entry.
# Run it after a kernel update has booted and works. Updates never touch the copy.
set -e
[ "$EUID" = 0 ] || exec sudo "$0" "$@"
cur=$(bootctl status 2>/dev/null | awk '/Current Entry:/ {print $3}')
src=/boot/EFI/Linux/$cur
[ -f "$src" ] || { echo "Booted entry '$cur' is not a UKI in /boot/EFI/Linux, nothing done."; exit 1; }
if command -v sbctl >/dev/null; then    # only with Secure Boot signing in use
  sbctl verify "$src" | grep -q 'is signed' || { echo "$src is not signed, nothing done."; exit 1; }
fi
mkdir -p /boot/EFI/rescue
cp "$src" /boot/EFI/rescue/known-good.efi.new
mv /boot/EFI/rescue/known-good.efi.new /boot/EFI/rescue/known-good.efi
cat > /boot/loader/entries/known-good.conf <<CONF
title   Known good: $(uname -r), frozen $(date +%F)
efi     /EFI/rescue/known-good.efi
sort-key zz-known-good
CONF
echo "Known good entry now boots $(uname -r) (copied from $cur)."
```

Run `x12-mark-known-good` once now, and again after each kernel update that boots and works.
It refuses to run when booted from "Known good" itself.

#### 3. Live system from disk

Section 11 puts a CachyOS live ISO on its own partition and starts it with **F11**, or F12 -> **CachyOS Live**.
It goes through shim directly, so it also works when systemd-boot or the installed system is broken.

An earlier version of this guide kept the ISO in a btrfs subvolume `@rescue` with a "CachyOS Rescue" entry in `EFI/rescue/`.
Section 11 replaced it.
If you set it up, delete its sbctl database entry too (`sudo sbctl remove-file <source path it was signed from>`, see `sbctl list-files`).
Otherwise sbctl's pacman hook fails on every update once that source file is gone.

#### 4. Signature check after updates

`/usr/local/bin/x12-check-boot-signatures` (mode 755):

```bash
#!/bin/bash
# Warn if any boot file on the ESP would be rejected by Secure Boot.
# shim and MokManager are signed by Microsoft/Fedora, not by our key, so they are checked
# against the reference copies in /usr/share/shim-signed instead.
bad=0
while read -r f; do
  case "$f" in
    */shimx64.efi|*/BOOT/BOOTX64.EFI|*/BOOT/Lenovobt.efi) ref=/usr/share/shim-signed/shimx64.efi ;;
    */mmx64.efi)                      ref=/usr/share/shim-signed/mmx64.efi ;;
    *) echo "UNSIGNED: $f"; bad=1; continue ;;
  esac
  cmp -s "$f" "$ref" || { echo "NOT THE REFERENCE SHIM: $f"; bad=1; }
done < <(sbctl verify 2>/dev/null | sed -n 's/^✗ \(.*\) is not signed$/\1/p')
if [ $bad = 1 ]; then
  echo "=================================================================="
  echo " WARNING: boot files above will be REJECTED by Secure Boot."
  echo " Fix before rebooting:  sudo sbctl sign-all   (or sudo mkinitcpio -P)"
  echo " If you reboot anyway, pick 'Known good', or press F11 for the live system."
  echo "=================================================================="
  exit 1
fi
echo "Boot signatures OK."
```

`/etc/pacman.d/hooks/zz-x12-check-boot-signatures.hook` runs it after any update that touches boot files.
The name sorts after `zz-sbctl.hook`, so it checks the result of sbctl's signing:

```
[Trigger]
Type = Path
Operation = Install
Operation = Upgrade
Operation = Remove
Target = usr/lib/modules/*/vmlinuz
Target = usr/lib/initcpio/*
Target = usr/lib/systemd/boot/efi/*
Target = usr/lib/firmware/*
Target = boot/*
Target = etc/mkinitcpio.conf
Target = etc/mkinitcpio.d/*

[Action]
Description = Checking that boot files are signed for Secure Boot...
When = PostTransaction
Exec = /usr/local/bin/x12-check-boot-signatures
```

#### Test results

These boots were tested:
- Known good
- F12 -> NVMe0 (`bootctl status` showed `\EFI\BOOT\grubx64.efi` as the loader), before section 11 put the live image there
- F11 and F12 -> CachyOS Live (section 11)

The hook's warning was tested with a temporary unsigned file on the ESP.

#### Fixing the installed system from the live system

Mount the installed system:

```
sudo mount -o subvol=@ /dev/nvme0n1p2 /mnt
sudo mount /dev/nvme0n1p1 /mnt/boot
sudo arch-chroot /mnt
```

Inside the chroot:
- Rebuild and re-sign the UKIs: `mkinitcpio -P`
- Re-sign everything in sbctl's database: `sbctl sign-all`
- Check: `sbctl verify`, or `x12-check-boot-signatures`
- Undo a bad update: `pacman -U /var/cache/pacman/pkg/<package>-<old-version>.pkg.tar.zst`

Rolling back to a snapper snapshot (not tested; snapper's `rollback` command does not work with this setup, see step 2).
Find the snapshot number with `snapper -c root list` in the chroot, `exit` the chroot, then:

```
sudo umount -R /mnt
sudo mount -o subvolid=5 /dev/nvme0n1p2 /mnt
sudo mv /mnt/@ /mnt/@.broken
sudo btrfs subvolume snapshot /mnt/@.broken/.snapshots/<N>/snapshot /mnt/@
sudo rmdir /mnt/@/.snapshots && sudo mv /mnt/@.broken/.snapshots /mnt/@/.snapshots
sudo umount /mnt
```

The ESP is not part of the snapshot.
If the snapshot has a different kernel than the UKIs on the ESP, its modules will not match.
Mount and chroot as above and run `mkinitcpio -P` before rebooting.
Delete `@.broken` once the system works, with the top level mounted at `/mnt`: `sudo btrfs subvolume delete -R /mnt/@.broken`.
`-R` also deletes the subvolumes nested inside it (`var/lib/portables`, `var/lib/machines`).

### Limine under shim (experimental, tested, not the default)

Limine can boot through shim once you add the missing `.sbat` section yourself.
This was tested as a separate F12 entry; systemd-boot stays the default.
The point is Limine's snapshot entries (one-click snapshot boot and restore).

#### Why the X12 needs shim at all

- The firmware only trusts its own `db` (3 Lenovo and 5 Microsoft certificates, `sudo mokutil --db`).
- Your key, Ventoy's and Fedora's are in shim's MOK list, which only shim reads (`mokutil --list-enrolled`).
- Adding your key to the firmware `db` would remove the need for shim.
  The BIOS has the options for it (Security > Secure Boot: Reset to Setup Mode, Clear All Secure Boot Keys, Key Management), but they are greyed out unless you are logged into setup with the supervisor password.
  This was decoded from the BIOS setup forms: the condition is "no setup-admin rights, or Device Guard on"; Device Guard is off.
- Without the supervisor password, shim is the only way.
  **Do not guess the supervisor password:** too many attempts can lock the machine permanently.
- Extracting keys from the BIOS chip would not help: `db` only holds public certificates, never the private keys needed to sign.

#### Why Limine does not have `.sbat`

- Limine's own Secure Boot model is a key enrolled straight into the firmware (Setup Mode, `sbctl enroll-keys`), which never looks at `.sbat`.
  SBAT is purely shim's revocation mechanism.
- Shim users are a corner case for Limine.
  Others who added `.sbat` reached the menu, but chainloading an EFI program from Limine under shim froze the machine ([Limine #512](https://github.com/Limine-Bootloader/Limine/issues/512)).
  Since Limine 9.6, chainloaded programs are started from memory, and shim and UKIs then cannot find their own files ([#528](https://github.com/limine-bootloader/limine/issues/528)).
- So under shim, use only Limine's own Linux loader (`protocol: linux`), never `protocol: efi` (chainloading).

#### Chain and security

```
firmware (Microsoft db) -> EFI/limine/shimx64.efi (Microsoft-signed)
  -> EFI/limine/grubx64.efi = Limine 12.9.0 + .sbat, config hash enrolled, signed with your MOK key
  -> kernel + initramfs loaded by Limine itself, each checked against a BLAKE2B hash in the enrolled config
```

- With Secure Boot on and a config hash enrolled, Limine refuses a config whose hash does not match, and any file path without a matching hash; the config editor is disabled.
- **Tested:** changing one character of `limine.conf` without re-enrolling made Limine panic and refuse to boot.
- The coverage matches the systemd-boot chain: nothing unsigned or modified runs before the kernel.
- Neither chain enables kernel lockdown: the CachyOS kernel does not lock down on Secure Boot (`/sys/kernel/security/lockdown` is `[none]`), which the unsigned patched camera module relies on.
- DMA protection (IOMMU forced on by the firmware's "platform opt in", Thunderbolt `iommu_dma_protection=1`) is identical under both boot loaders.

#### Setup used for the test

Only the `limine` package was installed: it has no pacman hooks and does not touch the ESP.
Do not install `limine-mkinitcpio-hook` (or, without checking it first, `limine-entry-tool`):
- it replaces `/etc/pacman.d/hooks/90-mkinitcpio-install.hook` and adds a `/usr/local/bin/mkinitcpio` wrapper, which takes over how the UKIs are built
- its `80-limine-efi-deploy.hook` copies Limine onto the ESP and could overwrite `EFI/BOOT/BOOTX64.EFI` (shim, the firmware fallback path)

1. A frozen kernel and initramfs, so updates do not change the hashed files:

   ```
   sudo pacman -S limine
   sudo mkdir -p /boot/limine-test
   sudo cp /boot/vmlinuz-linux-cachyos /boot/limine-test/vmlinuz
   sudo mkinitcpio -k /boot/vmlinuz-linux-cachyos -g /boot/limine-test/initramfs.img
   ```

   Pass the kernel as a file path, not a version: sbctl's mkinitcpio post-hook signs the kernel file it is given, and `/boot/vmlinuz-linux-cachyos` is already signed and tracked.

2. `limine.conf` (here in `/var/tmp/limine-test`), with `b2sum` hashes of the two files:

   ```
   timeout: 10
   verbose: yes

   /CachyOS (Limine test, shim + MOK)
       protocol: linux
       path: boot():/limine-test/vmlinuz#<b2sum>
       cmdline: <contents of /etc/kernel/cmdline>
       module_path: boot():/limine-test/initramfs.img#<b2sum>
   ```

   Limine looks for `limine.conf` next to its own executable first, so it goes into `EFI/limine/`.

3. Add `.sbat`, enroll the config hash, sign with the MOK key.
   The new section goes at `SizeOfImage` of the stock binary (0x63000 for 12.9.0; check with `objdump -p`), aligned to 0x1000:

   ```
   printf 'sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md\nlimine,1,Limine,limine,12.9.0,https://limine-bootloader.org\n' > sbat.csv
   objcopy --add-section .sbat=sbat.csv --set-section-flags .sbat=contents,alloc,load,readonly,data \
     --change-section-vma .sbat=0x63000 /usr/share/limine/BOOTX64.EFI limine-sbat.efi
   limine enroll-config limine-sbat.efi $(b2sum limine.conf | cut -d' ' -f1)
   sudo mkdir -p /boot/EFI/limine
   sudo sbctl sign -o /boot/EFI/limine/grubx64.efi limine-sbat.efi
   sudo cp limine.conf /boot/EFI/limine/
   sudo cp /usr/share/shim-signed/shimx64.efi /usr/share/shim-signed/mmx64.efi /boot/EFI/limine/
   ```

   Every config change needs `limine enroll-config --reset limine-sbat.efi`, a new `enroll-config` and a new `sbctl sign`: enrolling changes the binary, so the old signature no longer matches.

4. The F12 entry; put the main entry back first:

   ```
   sudo efibootmgr --create --disk /dev/nvme0n1 --part 1 --label "Limine test (shim)" --loader '\EFI\limine\shimx64.efi'
   sudo efibootmgr --bootorder <cachyos-shim>,<limine-test>,<the rest of the old order>
   ```

The Limine menu is plain text with a countdown; the "MOK" in the entry title is easy to mistake for a shim screen.
An Enter still held from the F12 menu can boot the first entry immediately; tap an arrow key to stop the countdown.

#### Snapshot entry

Snapper snapshots are read-only, and a normal boot needs to write to `/etc` and `/var/lib`.
A small initramfs step mounts a RAM overlay on top of the read-only snapshot.
Changes in the snapshot boot are lost at the next reboot; `/home`, `/var/log` and `/var/cache` are separate subvolumes and stay writable.

The overlay script comes from CachyOS's `limine-mkinitcpio-hook` (downloaded with `pacman -Sw`, not installed; `usr/lib/limine/overlayfs-setup` in the package).
It does nothing unless the root is a read-only btrfs subvolume whose path contains `/snapshot`.
It is installed as a local hook with its own names, so it cannot conflict with the package later:
- `/etc/initcpio/x12/overlayfs-setup` (the script, mode 755)
- `/etc/initcpio/x12/x12-overlayfs-setup.service`:

  ```
  [Unit]
  Description=Setup OverlayFS on a read-only snapshot root (X12 Limine test)
  DefaultDependencies=no
  After=initrd-fs.target
  Before=initrd.target

  [Service]
  Type=oneshot
  ExecStart=/usr/lib/x12/overlayfs-setup
  RemainAfterExit=yes
  ```

- `/etc/initcpio/install/x12-snapshot-overlay` (the initramfs is systemd-based, so the busybox `btrfs-overlayfs` variant would not run):

  ```bash
  #!/usr/bin/env bash
  # X12 Limine test: boot a read-only snapper snapshot with a RAM overlay (systemd initramfs).
  # Script taken from CachyOS limine-mkinitcpio-hook (sd-btrfs-overlayfs), renamed to avoid file conflicts.
  build() {
  	add_module btrfs
  	add_module overlay
  	map add_binary bash btrfs findmnt logger mount mktemp mkdir echo
  	add_file /etc/initcpio/x12/overlayfs-setup /usr/lib/x12/overlayfs-setup 755
  	add_file /etc/initcpio/x12/x12-overlayfs-setup.service /usr/lib/systemd/system/x12-overlayfs-setup.service 644
  	add_symlink /usr/lib/systemd/system/initrd.target.wants/x12-overlayfs-setup.service /usr/lib/systemd/system/x12-overlayfs-setup.service
  }
  help() { echo "Boot a read-only btrfs snapshot with a tmpfs overlay (systemd initramfs)."; }
  ```

A separate initramfs with the hook (the normal mkinitcpio config is not changed):

```
sed 's/^HOOKS=(\(.*\) filesystems)$/HOOKS=(\1 filesystems x12-snapshot-overlay)/' /etc/mkinitcpio.conf > mkinitcpio-snap.conf
sudo mkinitcpio -c mkinitcpio-snap.conf -k /boot/vmlinuz-linux-cachyos -g /boot/limine-test/initramfs-snap.img
```

The entry, added to `limine.conf` (then re-enroll and re-sign as in step 3):

```
/Snapshot 67: X12 baseline (read-only, RAM overlay)
    protocol: linux
    path: boot():/limine-test/vmlinuz#<b2sum>
    cmdline: <same as above, with rootflags=subvol=/@/.snapshots/67/snapshot>
    module_path: boot():/limine-test/initramfs-snap.img#<b2sum>
```

**Tested:** it boots to the desktop with `/` as `overlay` (the snapshot underneath, a 7.7 GB RAM layer on top), and the system matches the snapshot's state.
`systemd-remount-fs.service` fails in a snapshot boot; that is harmless (it tries to apply the fstab `/` options to the overlay).

#### Keeping changes: restore, not boot

A snapshot boot is a preview; its changes are thrown away on purpose.
To go back for real, the snapshot is restored: the current `@` is kept as a backup, and a writable copy of the snapshot becomes the new `@`.
CachyOS's `limine-snapper-restore` (in `limine-snapper-sync`) does this, and also puts back the snapshot's kernel files on the ESP.
By hand, it is the rollback procedure above.
Clearing a snapshot's read-only flag and booting it directly would work, but it corrupts snapper's history.

#### Status and caveats

- Not automated: nothing re-adds `.sbat`, re-enrolls or re-signs after a change.
  A switch to Limine for real would need that step after CachyOS's tooling, plus a careful look at its ESP deploy hook.
- The test kernel is frozen at 7.2.9.
  After a kernel update, `/usr/lib/modules` no longer has its modules, so the test entries stop booting properly until rebuilt.
- Snapshot 67 (type single, no cleanup algorithm) stays until it is deleted by hand.
- Not tested yet: restore, and suspend/resume and sleep drain under a Limine boot.

Remove the whole test:

```
sudo efibootmgr -b <limine-test-entry> -B
sudo rm -r /boot/EFI/limine /boot/limine-test
sudo rm -r /etc/initcpio/x12 /etc/initcpio/install/x12-snapshot-overlay
sudo pacman -Rns limine
```

### Running with Secure Boot off

With Secure Boot off in the BIOS, shim starts `grubx64.efi` without checking its signature, so the chain above keeps working with unsigned files.
The author's X12 now runs this way, with the signing tools removed:

```
sudo pacman -Rns sbctl     # its pacman, mkinitcpio and kernel-install hooks go with it; mkinitcpio rebuilds the UKIs unsigned
sudo rm /etc/pacman.d/hooks/zz-x12-check-boot-signatures.hook /usr/local/bin/x12-check-boot-signatures
```

- The keys in `/var/lib/sbctl` are not part of the package and stay.
  Keep them if you may switch Secure Boot back on: your key is still enrolled as MOK.
- `x12-mark-known-good` skips its signature check when sbctl is not installed.
- Nothing refreshes `EFI/cachyos/grubx64.efi` after systemd updates any more.
  The old copy keeps working; to update it: `sudo cp /usr/lib/systemd/boot/efi/systemd-bootx64.efi /boot/EFI/cachyos/grubx64.efi`.
- To turn Secure Boot back on: install sbctl, repeat step 6 (one `-s` mapping per source file), run `sudo mkinitcpio -P` to sign the UKIs, run `sudo sbctl verify`, then switch it on in the BIOS.
- Shim is not needed at all with Secure Boot off. The author's X12 boots systemd-boot directly from a second firmware entry, with "CachyOS (shim)" kept behind it as a fallback and for switching Secure Boot back on:

  ```
  sudo efibootmgr --create --disk /dev/nvme0n1 --part 1 --label "CachyOS" --loader '\EFI\systemd\systemd-bootx64.efi'
  sudo systemctl enable systemd-boot-update.service    # keeps \EFI\systemd\systemd-bootx64.efi current
  ```

  `efibootmgr --create` puts the new entry first in the boot order.
  `bootctl update` (run by that service at boot) skips `\EFI\BOOT\BOOTX64.EFI` and the F11 live image, because they belong to other boot loaders.

#### Recreating the boot entries after a BIOS reset

"Load optimized defaults" (or any BIOS reset) clears the firmware's NVRAM boot entries.
Afterwards the boot menu shows only the built-in items (Setup, Boot Menu, NVMe0, USB, PXE) and none of the CachyOS entries.
Only NVRAM is lost: the ESP, systemd-boot and the UKIs are untouched, so nothing on disk has to be rebuilt.

With no entry left, the firmware falls back to `F12 -> NVMe0`, which runs `\EFI\BOOT\BOOTX64.EFI`.
After section 11 that path boots the internal live image, not the installed system, so the usual symptom is "it boots to the live desktop and my install is gone".
The install is fine; only the entry is missing.

Recreate the entries from that live session (`efibootmgr` writes NVRAM directly, no chroot needed).
With Secure Boot off, point each entry straight at its real loader, no shim:

```
sudo efibootmgr --create --disk /dev/nvme0n1 --part 1 --label "CachyOS"      --loader '\EFI\systemd\systemd-bootx64.efi'
sudo efibootmgr --create --disk /dev/nvme0n1 --part 4 --label "CachyOS Live" --loader '\EFI\BOOT\grubx64.efi'
```

- `CachyOS` loads systemd-boot (p1) directly; it then finds the UKIs in `\EFI\Linux` and shows its menu, including the `Known good` entry.
- `CachyOS Live` loads the live UKI on p4 directly (the section 11 image).
- `--create` puts each new entry first in `BootOrder`, so `CachyOS` becomes the default.
  Check with `efibootmgr`; reorder with `sudo efibootmgr --bootorder <nums>`, or test one boot without changing the default with `sudo efibootmgr --bootnext <num>`.

Not part of this set:
- `Known good` needs no entry of its own: it is a systemd-boot menu entry (`loader/entries/known-good.conf`) and appears inside the `CachyOS` menu.
- `Limine test` can only be recreated if `EFI/limine` is still on the ESP (see the Limine section). A BIOS reset does not remove it, but removing the signing setup earlier might have.

With Secure Boot on instead, point `CachyOS` at `\EFI\cachyos\shimx64.efi` and `CachyOS Live` at p4 `\EFI\BOOT\BOOTX64.EFI`, so both go through shim (step 7).
With your own keys in the firmware (next section), the direct entries above work unchanged.

### Own keys in the firmware (with the supervisor password)

With the supervisor password, the sbctl keys go straight into the firmware's `db`.
No shim or MOK is needed for normal boot.
The Lenovo and Microsoft keys stay, so Lenovo tools, fwupd and the Microsoft-signed shim (F11) keep working.

```
firmware db (Lenovo + Microsoft + your "Database Key")
  -> \EFI\systemd\systemd-bootx64.efi   signed with your key ("CachyOS" entry)
  -> /boot/EFI/Linux/*.efi              UKIs, signed by sbctl's mkinitcpio post hook
F11 -> \EFI\BOOT\Lenovobt.efi (Microsoft-signed shim) -> \EFI\BOOT\grubx64.efi (live UKI, your key)
F12 -> CachyOS Live -> p4 \EFI\BOOT\grubx64.efi (live UKI, your key, no shim)
```

1. Install sbctl. It reuses the keys still in `/var/lib/sbctl/keys`.
   Back up the ESP and the current keys first (`efi-readvar -v <PK|KEK|db|dbx> -o <var>.esl`).

2. Fix the signing database.
   An old mapping signed systemd-boot into `EFI/BOOT/grubx64.efi`, which is now the F11 live UKI; the next systemd update would have overwritten it.
   Sign into the `.signed` file instead, which `bootctl update` prefers:

   ```
   sudo sbctl remove-file /usr/lib/systemd/boot/efi/systemd-bootx64.efi
   sudo sbctl sign -s -o /usr/lib/systemd/boot/efi/systemd-bootx64.efi.signed /usr/lib/systemd/boot/efi/systemd-bootx64.efi
   sudo bootctl update
   sudo sbctl sign -s /boot/EFI/systemd/systemd-bootx64.efi
   sudo sbctl sign /boot/EFI/rescue/known-good.efi
   sudo sbctl sign -s -o /usr/lib/fwupd/efi/fwupdx64.efi.signed /usr/lib/fwupd/efi/fwupdx64.efi
   sudo sbctl verify
   ```

   Put `x12-check-boot-signatures` and its hook back (see "Signature check after updates").
   It now also warns when an installed kernel would enforce module signatures or lockdown, which would stop the unsigned DKMS modules.

3. BIOS (supervisor password): Security > Secure Boot > **Reset to Setup Mode**.
   Leave Secure Boot off.
   Not "Clear All Secure Boot Keys": that also deletes the Lenovo keys.
   Reset to Setup Mode only clears the PK; KEK, db and dbx stay.

4. Back in Linux, enroll, appending to the existing keys:

   ```
   sudo chattr -i /sys/firmware/efi/efivars/KEK-8be4df61-93ca-11d2-aa0d-00e098032b8c /sys/firmware/efi/efivars/db-d719b2cb-3d3a-4596-a3bc-dad00e67656f
   sudo sbctl enroll-keys --append --microsoft
   ```

   `--microsoft` also adds the Microsoft 2023 certificates.
   `sbctl enroll-keys --append --microsoft --export esl` shows the result first without writing anything.

5. BIOS: Secure Boot **On** (shows User Mode).

Tested: normal boot, Known good, F11, F12 -> CachyOS Live.
`bootctl status` shows `Secure Boot: enabled (user)`.
The DKMS modules (`hid-lenovo`, `intel-ipu6`, `ov8856`, `iosm`, `acpi_call`) still load unsigned: the CachyOS kernel does not force module signatures (`CONFIG_MODULE_SIG_FORCE` unset) and does not lock down on Secure Boot.

Undo: BIOS > Secure Boot off, or "Restore Factory Keys" for the factory key set.

---

## 11. F11 recovery: a CachyOS live image on the internal disk

### What this gives you

Pressing **F11** ("recover your system") at boot drops you into a full **CachyOS live desktop**,
served from the internal NVMe, with **no USB stick, enforced Secure Boot still on, and no BIOS /
supervisor password needed**. `F12 > "CachyOS Live"` is a second path to the same image. This is the
"keep a rescue/installer on the machine" button the factory F11 no longer does once Windows is gone.

The idea: put a CachyOS live ISO on an internal partition and boot it with a **single signed UKI**
(kernel + the ISO's initramfs + a loop cmdline). archiso loop-mounts the ISO for its squashfs, so we
don't unpack 2.7 GB. Secure Boot is satisfied by the normal shim+MOK chain.

Boot chain:

```
F11 -> \EFI\BOOT\Lenovobt.efi   (Microsoft-signed shim = trusted by firmware db)
        -> \EFI\BOOT\grubx64.efi (= our signed UKI, shim's fixed 2nd stage, trusted via MOK)
            -> kernel-cachyos-lts -> archiso loop-mounts /cachyos.iso on p3 -> live desktop
```

**Reproduce on a fresh machine in one shot:** `install-f11-cachyos-live.sh` (saved next to this
guide) does everything below automatically, `sudo ./install-f11-cachyos-live.sh cachyos-desktop-*.iso`,
after the one-time btrfs shrink. It backs up the GPT, creates/formats the two partitions in the free
space, copies the ISO, builds+signs the UKI (pulling the exact cmdline from the ISO's own
`loopback.cfg`), and wires both F11 (ESP) and F12 (p4). The sections below explain what it does and
why, for when you need to adjust or debug it.

### Partition layout

Done once by shrinking the btrfs root (from a live USB with GParted) to free space at the end of the
disk, then adding two partitions **in the free space only** (p1 ESP and p2 btrfs root untouched; back
up the GPT first with `sgdisk --backup=... /dev/nvme0n1`):

| Part | Type | FS | Label | Holds |
|---|---|---|---|---|
| p3 | 8300 | **FAT32** | `CACHYLIVE` | `cachyos.iso` (the live image) |
| p4 | 0700 | FAT32 | `CACHYBOOT` | the F12 boot chain (shim + UKI) |

```
# in the freed sectors only, e.g.:
sudo sgdisk -n3:<start>:<end-512M> -t3:8300 -c3:CACHYLIVE \
            -n4:<end-512M+1>:<last>  -t4:0700 -c4:CACHYBOOT /dev/nvme0n1
sudo partx -a /dev/nvme0n1
sudo mkfs.vfat -F32 -n CACHYLIVE /dev/nvme0n1p3     # MUST be FAT32/exFAT (see note)
sudo mkfs.vfat -F32 -n CACHYBOOT /dev/nvme0n1p4
sudo mount /dev/nvme0n1p3 /mnt && sudo cp cachyos-desktop-linux-260809.iso /mnt/cachyos.iso
```

**p3 must be FAT32 (or exFAT), not ext4.** The live initramfs ships `vfat`/`exfat` but **no `ext4`**
module, so an ext4 p3 boots the kernel then fails to find the ISO (`lsinitcpio <img> | grep ext4`
confirms it is absent). Note its UUID (`blkid /dev/nvme0n1p3`), it goes in the cmdline below.

### Build the signed UKI

The ISO's own `boot/grub/loopback.cfg` gives the exact loop cmdline; we bake it into a UKI with the
ISO's **LTS** kernel + initramfs and sign it with the sbctl key (which is already enrolled in MOK, so
no MokManager prompt):

```
# extract the LTS kernel + initramfs from the ISO (bsdtar, no root)
bsdtar xf /mnt/cachyos.iso arch/boot/x86_64/vmlinuz-linux-cachyos-lts \
                           arch/boot/x86_64/initramfs-linux-cachyos-lts.img

P3UUID=$(sudo blkid -s UUID -o value /dev/nvme0n1p3)     # e.g. XXXX-XXXX
sudo ukify build \
  --linux=arch/boot/x86_64/vmlinuz-linux-cachyos-lts \
  --initrd=arch/boot/x86_64/initramfs-linux-cachyos-lts.img \
  --cmdline="archisobasedir=arch img_dev=UUID=$P3UUID img_loop=/cachyos.iso cow_spacesize=10G copytoram=auto module_blacklist=pcspkr i915.modeset=1 amdgpu.modeset=1 nvme_load=yes" \
  --secureboot-private-key=/var/lib/sbctl/keys/db/db.key \
  --secureboot-certificate=/var/lib/sbctl/keys/db/db.pem \
  --signtool=sbsign --output=cachyos-live.efi
sudo sbverify --cert /var/lib/sbctl/keys/db/db.pem cachyos-live.efi   # Signature verification OK
```

(Needs `systemd-ukify` + `sbsigntools`. Using `sbsign` directly, not `sbctl sign`, keeps it out of
the sbctl auto-resign DB.)

### Wire F11 (ESP) and F12 (p4)

**F12** entry (pick it from the F12 menu): put the shim + UKI on p4 and add a non-default boot entry.

```
# on p4's \EFI\BOOT\:  BOOTX64.EFI + Lenovobt.efi = the MS-signed shim, grubx64.efi = the UKI
sudo cp /boot/EFI/cachyos/shimx64.efi  <p4>/EFI/BOOT/BOOTX64.EFI
sudo cp cachyos-live.efi               <p4>/EFI/BOOT/grubx64.efi
sudo efibootmgr --create --disk /dev/nvme0n1 --part 4 \
     --loader '\EFI\BOOT\BOOTX64.EFI' --label 'CachyOS Live'
# keep CachyOS first in BootOrder so normal boot is unchanged
```

**F11** payload goes on the **ESP** (see why below). Back up the ESP's removable-fallback grub, then:

```
sudo cp /boot/EFI/BOOT/grubx64.efi /boot/EFI/BOOT/grubx64.efi.bak-prelive   # backup
sudo cp /boot/EFI/cachyos/shimx64.efi /boot/EFI/BOOT/Lenovobt.efi           # F11 target (MS-signed)
sudo cp cachyos-live.efi              /boot/EFI/BOOT/grubx64.efi            # shim's 2nd stage = UKI
```

### Why F11's payload lives on the ESP, not a dedicated partition

F11 launches the firmware's `Rescue and Recovery` app, which **scans `BootOrder` and runs the first
GPT+FAT volume that contains `\EFI\BOOT\Lenovobt.efi`**, via `LoadImage` (so the file must be valid
for the **current Secure Boot db**). Two facts shape this:

- **`Lenovobt.efi` must be db-signed.** An earlier test with an sbctl/MOK-signed UEFI shell was
  *found* by F11 but **rejected by `LoadImage`** (MOK is not db), which looks exactly like "F11 does
  nothing / shows the normal boot menu." The Microsoft-signed shim is db-trusted, so it loads.
- **On this unit the scan only reliably reaches the ESP** (the first `BootOrder` entry), not our
  later partition entry, even after reordering. So the working `Lenovobt.efi` lives on the ESP. The
  CMOS `0x6C` bit0 F11 gate was already clear (normal after any disk boot).

Because the shim's fixed second stage is `grubx64.efi` in its own directory, the ESP's
`\EFI\BOOT\grubx64.efi` (previously the removable-media fallback grub) is now the UKI. Normal boot is
unaffected (it uses `\EFI\cachyos\`), but the **removable-media fallback now also boots the live
image**, and a bootloader update could overwrite `\EFI\BOOT\grubx64.efi`. If F11 ever stops working,
re-copy the UKI there (or restore `grubx64.efi.bak-prelive` to get the plain fallback back).

### Update to a newer ISO

Replace `/cachyos.iso` on p3 (keep it FAT32; keep the label/UUID or rebuild with the new UUID),
rebuild + re-sign the UKI from the **matching** kernel + initramfs, then copy the new UKI to **both**
`/boot/EFI/BOOT/grubx64.efi` and p4's `\EFI\BOOT\grubx64.efi`.

### Undo

Remove the F12 entry (`sudo efibootmgr -b 0004 -B`), restore the ESP fallback grub
(`sudo cp /boot/EFI/BOOT/grubx64.efi.bak-prelive /boot/EFI/BOOT/grubx64.efi`) and delete
`/boot/EFI/BOOT/Lenovobt.efi`, then delete p3/p4 (`sudo sgdisk -d4 -d3 /dev/nvme0n1`) or restore the
saved table (`sudo sgdisk --load-backup=x12-gpt-prebackup.bin /dev/nvme0n1`) and grow btrfs back.
Make your own GPT backup before editing the table (`sudo sgdisk --backup=x12-gpt-prebackup.bin /dev/nvme0n1`) and keep it somewhere safe.

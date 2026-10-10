#!/usr/bin/env bash
# install-f11-cachyos-live.sh
# ---------------------------------------------------------------------------
# Reproducibly set up "F11 -> CachyOS live desktop" (and an F12 entry) on a
# ThinkPad X12 Detachable Gen 1 running CachyOS, under ENFORCED Secure Boot,
# with NO BIOS / supervisor-password access. Full rationale is in the guide,
# docs/11-f11-recovery-live.md.
#
# WHAT IT DOES (existing partitions are never touched; GPT is backed up first):
#   - creates two partitions in UNALLOCATED space at the end of the boot disk:
#       <live>  FAT32 label CACHYLIVE   holds the CachyOS live ISO as /cachyos.iso
#       <boot>  FAT32 label CACHYBOOT   the F12 shim + UKI chain
#   - builds ONE signed UKI = the ISO's LTS kernel + initramfs + the ISO's own
#     loop cmdline (img_dev=UUID=<live> img_loop=/cachyos.iso ...), signed with
#     the sbctl key (already enrolled in MOK, so no MokManager prompt)
#   - wires F11 via the ESP:  \EFI\BOOT\Lenovobt.efi = Microsoft-signed shim
#     (db-trusted, which F11's LoadImage requires) + \EFI\BOOT\grubx64.efi = UKI
#   - wires F12 via a non-default "CachyOS Live" UEFI boot entry on <boot>
#
# WHY the F11 payload is on the ESP and must be the MS-signed shim: F11 runs the
# firmware "Rescue and Recovery" app, which scans BootOrder and LoadImage()s the
# first GPT+FAT volume holding \EFI\BOOT\Lenovobt.efi, enforcing the Secure Boot
# *db*. On this unit the scan reliably reaches only the ESP (first entry), and a
# MOK/sbctl-signed file is rejected by db; the MS-signed shim is accepted.
#
# PREREQUISITE (do this ONCE first, from a GParted live USB):
#   Shrink the btrfs root from its END, leaving >= (ISO size + 1 GiB) of
#   UNALLOCATED space at the end of the disk. Do NOT create a partition in it.
#
# USAGE:
#   sudo ./install-f11-cachyos-live.sh /path/to/cachyos-desktop-*.iso [/dev/nvme0n1]
# ---------------------------------------------------------------------------
set -euo pipefail

ISO="${1:?usage: sudo $0 <cachyos.iso> [disk]}"
DISK="${2:-/dev/nvme0n1}"
BOOTP_MIB=512                       # size of the FAT boot partition
LIVE_LABEL=CACHYLIVE
BOOT_LABEL=CACHYBOOT

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -f "$ISO" ]  || { echo "ISO not found: $ISO"; exit 1; }
[ -b "$DISK" ] || { echo "disk not found: $DISK"; exit 1; }

echo "== ensure tools =="
pacman -S --needed --noconfirm gptfdisk dosfstools libarchive systemd-ukify sbsigntools >/dev/null

# ESP mount point (usually /boot on this setup)
ESP_MNT=$(bootctl -p 2>/dev/null || echo /boot)
SHIM="$ESP_MNT/EFI/cachyos/shimx64.efi"
MM="$ESP_MNT/EFI/cachyos/mmx64.efi"
[ -f "$SHIM" ] || { echo "Microsoft-signed shim not found at $SHIM"; exit 1; }

# sbctl signing key (signs the UKI; its cert is already enrolled in MOK)
KEYDIR=""
for d in /var/lib/sbctl/keys /usr/share/secureboot/keys; do
  [ -f "$d/db/db.key" ] && KEYDIR="$d" && break
done
[ -n "$KEYDIR" ] || { echo "sbctl db key not found (set up Secure Boot with sbctl first)"; exit 1; }

# --- free space at the end of the disk ---
read -r LAST_END LAST_NUM < <(sgdisk -p "$DISK" | awk '/^[[:space:]]+[0-9]/{e=$3;n=$1} END{print e, n}')
LAST_USABLE=$(sgdisk -p "$DISK" | awk '/last usable sector/{print $NF}')
FIRST_FREE=$(( ( (LAST_END + 1) + 2047 ) / 2048 * 2048 ))
FREE_MIB=$(( (LAST_USABLE - FIRST_FREE + 1) / 2048 ))
ISO_MIB=$(( ( $(stat -c%s "$ISO") + 1048575 ) / 1048576 ))
echo "free at end: ${FREE_MIB} MiB (from sector ${FIRST_FREE}); ISO ${ISO_MIB} MiB"
[ "$FREE_MIB" -ge $(( ISO_MIB + BOOTP_MIB + 64 )) ] || { echo "not enough free space; shrink btrfs more"; exit 1; }
[ "$ISO_MIB" -lt 4096 ] || { echo "ISO >= 4 GiB cannot be a single FAT32 file; use exFAT and adjust"; exit 1; }

PBOOT_START=$(( (LAST_USABLE - BOOTP_MIB*2048 + 1) / 2048 * 2048 ))
PLIVE_START=$FIRST_FREE
PLIVE_END=$(( PBOOT_START - 1 ))
LIVE_N=$(( LAST_NUM + 1 )); BOOT_N=$(( LAST_NUM + 2 ))

echo
echo "PLAN on $DISK (partitions 1..${LAST_NUM} untouched):"
echo "  p${LIVE_N}  ${PLIVE_START}..${PLIVE_END}   FAT32 ${LIVE_LABEL}  (ISO)"
echo "  p${BOOT_N}  ${PBOOT_START}..${LAST_USABLE}  FAT32 ${BOOT_LABEL}  (F12 chain)"
read -rp "Proceed? type YES: " ok; [ "$ok" = YES ] || { echo aborted; exit 1; }

BK="/root/gpt-backup-$(date +%Y%m%d-%H%M%S).bin"
echo "== GPT backup -> $BK =="; sgdisk --backup="$BK" "$DISK"

echo "== create partitions =="
sgdisk -n${LIVE_N}:${PLIVE_START}:${PLIVE_END} -t${LIVE_N}:8300 -c${LIVE_N}:${LIVE_LABEL} \
       -n${BOOT_N}:${PBOOT_START}:${LAST_USABLE} -t${BOOT_N}:0700 -c${BOOT_N}:${BOOT_LABEL} "$DISK"
partprobe "$DISK"; udevadm settle; sleep 2
LIVE_DEV="${DISK}p${LIVE_N}"; BOOT_DEV="${DISK}p${BOOT_N}"
[ -b "$LIVE_DEV" ] && [ -b "$BOOT_DEV" ] || { echo "new partitions did not appear"; exit 1; }

echo "== format FAT32 (the live initramfs has vfat/exfat but NOT ext4) =="
mkfs.vfat -F32 -n "$LIVE_LABEL" "$LIVE_DEV" >/dev/null
mkfs.vfat -F32 -n "$BOOT_LABEL" "$BOOT_DEV" >/dev/null
blockdev --flushbufs "$LIVE_DEV"; udevadm settle; sleep 1
LIVE_UUID=$(blkid -s UUID -o value "$LIVE_DEV")

echo "== copy ISO to ${LIVE_LABEL} =="
m=$(mktemp -d); mount -t vfat "$LIVE_DEV" "$m"; cp "$ISO" "$m/cachyos.iso"; sync; umount "$m"; rmdir "$m"

echo "== build + sign the UKI (cmdline taken from the ISO's own loopback.cfg) =="
work=$(mktemp -d); cd "$work"
bsdtar xOf "$ISO" boot/grub/loopback.cfg > loopback.cfg
KPATH=$(grep -oE '/arch/boot/[^ ]*vmlinuz[^ ]*' loopback.cfg | head -1)
IPATH=$(grep -oE '/arch/boot/[^ ]*initramfs[^ ]*\.img' loopback.cfg | head -1)
CMDBASE=$(grep -E '^[[:space:]]*linux ' loopback.cfg | head -1 \
          | sed -E 's#^[[:space:]]*linux[[:space:]]+\S+##; s#img_dev=[^ ]*##; s#img_loop=[^ ]*##' )
CMDLINE="$(echo "img_dev=UUID=${LIVE_UUID} img_loop=/cachyos.iso ${CMDBASE}" | tr -s ' ')"
echo "kernel: $KPATH"; echo "initrd: $IPATH"; echo "cmdline: $CMDLINE"
bsdtar xf "$ISO" ".${KPATH#/}" ".${IPATH#/}"
ukify build --linux="./${KPATH#/}" --initrd="./${IPATH#/}" --cmdline="$CMDLINE" \
  --secureboot-private-key="$KEYDIR/db/db.key" --secureboot-certificate="$KEYDIR/db/db.pem" \
  --signtool=sbsign --output=cachyos-live.efi
sbverify --cert "$KEYDIR/db/db.pem" cachyos-live.efi
UKI="$work/cachyos-live.efi"; cd /

echo "== F12 chain on ${BOOT_LABEL} (shim + UKI) + non-default boot entry =="
m=$(mktemp -d); mount "$BOOT_DEV" "$m"; mkdir -p "$m/EFI/BOOT"
cp "$SHIM" "$m/EFI/BOOT/BOOTX64.EFI"
[ -f "$MM" ] && cp "$MM" "$m/EFI/BOOT/mmx64.efi" || true
cp "$UKI" "$m/EFI/BOOT/grubx64.efi"
sync; umount "$m"; rmdir "$m"
ORIG=$(efibootmgr | awk '/BootOrder:/{print $2}')
efibootmgr --create --disk "$DISK" --part "$BOOT_N" --loader '\EFI\BOOT\BOOTX64.EFI' --label 'CachyOS Live' >/dev/null
NEW=$(efibootmgr | awk -F'[* ]' '/CachyOS Live/{print substr($1,5,4); exit}')
first=${ORIG%%,*}; rest=${ORIG#*,}
efibootmgr -o "${first},${NEW},${rest}" >/dev/null     # keep OS default first

echo "== F11 chain on the ESP (Lenovobt.efi = shim, grubx64.efi = UKI) =="
[ -f "$ESP_MNT/EFI/BOOT/grubx64.efi" ] && cp "$ESP_MNT/EFI/BOOT/grubx64.efi" "$ESP_MNT/EFI/BOOT/grubx64.efi.bak-prelive"
cp "$SHIM" "$ESP_MNT/EFI/BOOT/Lenovobt.efi"
cp "$UKI"  "$ESP_MNT/EFI/BOOT/grubx64.efi"
[ -f "$MM" ] && cp "$MM" "$ESP_MNT/EFI/BOOT/mmx64.efi" || true
sync

echo
echo "DONE."
echo "  Live ISO UUID baked into the UKI: $LIVE_UUID"
echo "  GPT backup: $BK   (restore: sgdisk --load-backup=$BK $DISK)"
echo "  Reboot, then test:  F12 -> 'CachyOS Live',  then  F11."
echo "  NOTE: a bootloader update can overwrite $ESP_MNT/EFI/BOOT/grubx64.efi"
echo "        (the removable fallback). If F11 stops working, re-copy the UKI there,"
echo "        or restore grubx64.efi.bak-prelive for the plain fallback."
echo "  (Build scratch left in $work; /tmp clears on reboot.)"

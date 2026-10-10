## 10. Speaker correction (factory Dolby tuning via EasyEffects)

The X12's speakers are a Realtek **ALC274** codec plus a Realtek **ALC1308** Class-D smart amp.
On Windows, "Dolby Audio" does the tonal correction in a DSP; Linux gets none of that by default,
so the speakers sound thin and harsh out of the box. The fix is to lift Lenovo's own factory Dolby
speaker tuning and run it on Linux as an EasyEffects chain, no measuring, the same correction
Windows ships.

### Finding the right tuning

Lenovo's audio driver for the X12, `r1ga314w.exe` ("Realtek Audio Features", from the model's
Lenovo support page), is an InnoSetup installer that carries the **Dolby DAX3 per-model tuning XMLs**
for the whole 2021 ThinkPad line. Extract them without Windows:

```
innoextract -I 'code$GetExtractPath$/Dolby/ext' -d driver-cache r1ga314w.exe
```

The tunings are named `DEV_<codec>_SUBSYS_<ssid>.xml`. The trap: the firmware calls the codec
"ALC274", but Linux (and Dolby) drive it as **ALC287** (`DEV_0287`). The X12's audio subsystem id
comes from the kernel quirk table:

```
SND_PCI_QUIRK(0x17aa, 0x508b, "Thinkpad X12 Gen 1", ALC287_FIXUP_LEGION_15IMHG05_SPEAKERS)
```

So the X12's factory tuning is **`DEV_0287_SUBSYS_17AA508B_PCI_SUBSYS_508B17AA.xml`** (215 KB).
It contains the `internal_speaker` endpoint in two poses (`laptop` / `tablet`), each with the
Dolby profiles (`dynamic`, `movie`, `music`, `game`, `voice`) and the iEQ voicings
`balanced` / `detailed` / `warm`. Laptop and tablet are the same machine's two poses, not two
models, and differ only in the `voice` profile; the rest are identical.

> Source note: `r1ga314w.exe` is Lenovo/Dolby proprietary and is **not** mirrored in this repo.
> Get it from Lenovo's official support page for the X12 Detachable Gen 1 (Drivers and Software ->
> Audio). If that exact version is gone, a newer "Realtek Audio Features" package for the model
> carries the same `DEV_0287_SUBSYS_17AA508B` tuning. Recording the package name is enough; there is
> no need to archive the binary.

### Converting to EasyEffects

[`speaker-tuning-to-easyeffects`](https://github.com/antoinecellerier/speaker-tuning-to-easyeffects)
turns a Dolby XML into EasyEffects 8.x presets (CachyOS ships EE 8, so the native `easyeffects`
package is fine). Each preset is a convolver (the speaker-correction FIR) plus the Dolby EQ stages,
a multiband compressor (Dolby's "regulator") and a limiter. The install script is in
[`install/install-dolby-speakers.sh`](../install/install-dolby-speakers.sh) and the hand-tuned
presets in [`presets/`](../presets/). The raw Dolby XML and the convolver FIR (`.irs`) are **not**
redistributed here, they are Dolby's proprietary tuning; you generate the FIR locally from your own
machine's driver (see below).

### What is actually installed

Three presets, all built on the one hand-trimmed **Detailed** base. **`X12-Dolby-Laptop-Detailed`** is
bound to the speaker sink via EasyEffects autoload and set to autostart; the other two are there to
switch to by hand. Shared chain:

```
convolver -> equalizer (split L/R) -> autogain (leveler) -> multiband_compressor (regulator) -> limiter
```

| Preset | Source | How it differs from Detailed | Makeup |
|---|---|---|---|
| `X12-Dolby-Laptop-Detailed` | factory `dynamic` profile | reference, autoload default | +7.0 dB |
| `X12-Dolby-Laptop-Music` | factory `music` profile | drops the 2.5 kHz +1.9 dB band (a little less mid-forward) | +7.2 dB |
| `X12-Dolby-Laptop-Bright` | custom (not Dolby) | adds a +3 dB high-shelf above 7 kHz for air | +6.6 dB |

All three presets are in [`presets/`](../presets/) as `X12-Dolby-Laptop-{Detailed,Music,Bright}.json`.
They share one convolver FIR, `X12-Dolby-Laptop-Detailed.irs` (Music and Bright reuse that same
impulse), which is **not** shipped because it is derived from Dolby's proprietary tuning. To use the
presets: run `install-dolby-speakers.sh` on your own X12 (it needs the Dolby XML from your Windows
driver) to generate the impulse, save it as `~/.local/share/easyeffects/irs/X12-Dolby-Laptop-Detailed.irs`,
then drop these `.json` files into `~/.local/share/easyeffects/output/`. Until that impulse is present
the convolver stage has no kernel (point the preset's convolver at your generated impulse, or bypass
the convolver so audio passes through); the EQ, leveler, regulator and limiter load regardless. The
per-preset makeup is set so all three play at the same loudness as Detailed (Bright's shelf and
Music's missing band each shift broadband level slightly, the makeup compensates). The install script
below produces the baseline the hand-tuning started from.

**Why only three, and why Bright is custom.** Dolby's sound-mode *profiles* (`dynamic`, `movie`,
`music`, `game`, `voice`) do **not** convert to anything distinct in a static chain: the converter
emits a byte-identical speaker FIR for all of them (same content hash, 0.00 dB response difference),
because what really separates Dolby profiles is *live adaptive* processing (leveler target, dialog
enhancer, virtualizer, regulator behaviour) that a fixed convolver + EQ can't carry. `movie` came out
a bit-for-bit duplicate of `dynamic` and was dropped; `music` differs only by that one EQ band. So in
this static world the only lever that actually changes the sound is **EQ**, which is why `Bright` is a
hand-added high-shelf rather than another factory profile. (If you want more top-end than Bright, the
factory -12 dB notch at 5 kHz is the other thing holding highs down and can be softened.)

Decisions behind the Detailed base, all measured:

- **One EQ, not two.** The converter emits two single-band EQ plugins (one is per-channel, one is
  mono). Cascaded IIR biquads are mathematically one filter, so they were merged into a single
  `split-channels` 2-band EQ (verified: 0.00 dB difference). Bands: 5 kHz Bell -12 dB Q5.0 left /
  Q8.0 right (the asymmetric speaker notch), and 2.5 kHz Bell +1.88 dB Q0.7 (presence lift).
- **Static gain + a slow leveler.** The FIR carries ~6.96 dB of headroom (it measures -6.96 dB on
  pink noise), so the correction is quieter than bypass. Dolby lifts it back with a *static*
  `volmax-boost` (+6 dB) **and** a dynamic volume leveler. The static part is the **+7.0 dB at the
  regulator (multiband-compressor) input** (cancels the FIR headroom, net ~0 dB vs bypass, and sits
  before the regulator + the -1 dB limiter so peaks stay clean; raise `MAKEUP_DB` for more). The
  leveler is approximated by an EasyEffects `autogain` in **Integrated** mode (see the next
  subsection) rather than the pumping default.
- **No bass boost (matches factory).** Dolby ships virtual-bass and bass-enhancer *off* for the X12
  (`virtual_bass_process_enable=0`, `bass-enhancer-enable=0`), so the preset has none either. A bass
  enhancer was tried and removed; the drivers can't do real bass and even Dolby judged faking it not
  worth it here.
- **Detailed voicing.** The iEQ `balanced`/`detailed`/`warm` variants live in the convolver FIR, not
  the EQ (they measure < 0.5 dB apart); `detailed` is a touch brighter in the top octaves.

### Dolby leveler vs EasyEffects autogain (why no pumping)

The factory tuning has the dynamic leveler enabled (`volume-leveler-enable=1`, `amount=5`,
`out-target=-320` ≈ -32 LKFS), so Windows runs a loudness leveler full-time, yet it never pumps.
The catch is that Dolby's leveler and EasyEffects' `autogain` are **not the same algorithm**:

- **Dolby Volume Leveler** is a psychoacoustic, multiband, slow-acting loudness manager. It tracks
  long-term *perceived* loudness, moves gain gradually, is tuned by Dolby to stay inaudible, and works
  together with the regulator.
- **EasyEffects autogain** is a single-number LUFS (libebur128) target with none of that perceptual
  or multiband shaping, so on sparse or dynamic material it audibly swells and ducks, same goal,
  cruder mechanism. That is why enabling it sounded like pumping.

The leveler can't be reproduced exactly (it's proprietary; there is no Dolby plugin for Linux, the DSP
lives in a Windows-only `DolbyDax3Apo.dll` APO that nothing can host here). But the *pumping* was a
tuning mistake, not a hard limit: EasyEffects `autogain` is a real EBU R128 leveler, and its reference
mode drives the behaviour. The converter left it at `Geometric Mean (MSI)` with a 10 s history (fast,
reacts to short-term dynamics = pumps). Set instead to **`Integrated` reference, 30 s maximum history,
target -18 LUFS, silence threshold -70 dB**, it tracks only long-term loudness and moves gain slowly
and smoothly, the Dolby-leveler character without the pumping. It's still EBU R128, not Dolby's
multiband algorithm, so it levels on overall loudness, a good approximation, not identical. Tuning: if
it ever breathes, raise the history (60 s); too loud, lower the target; too quiet, raise it. Removing
the `autogain` plugin reverts to the dead-static version.

### Install / reproduce

Run on the X12 (uses the LAN for pacman/git, not the YOTA modem; needs the live GNOME session for the
autoload sink binding):

```
scp x12-dolby-easyeffects.tar.gz install-dolby-speakers.sh X12_Dolby_DEV_0287_SUBSYS_17AA508B.xml $USER@<x12>:/tmp/
# then on the X12, in the GNOME session:
cd /tmp && bash install-dolby-speakers.sh X12_Dolby_DEV_0287_SUBSYS_17AA508B.xml
```

The script installs `easyeffects` + `python-numpy`/`python-scipy`, generates the presets with
`--disable autogain`, sets the +7 dB static makeup, binds autoload to the speaker sink, and enables
the EasyEffects background service at login. Audio is corrected immediately, no logout needed. That
reproduces the Detailed baseline; the finished `Music` and `Bright` presets are the saved JSONs
(copy them into `~/.local/share/easyeffects/output/`). Switch between the three in
**EasyEffects > Output > Presets**.

### Undo

Disable the EasyEffects service (`Preferences > Launch Service at System Startup` off, and quit it),
or remove the binding in `~/.local/share/easyeffects/autoload/output/`. The presets and impulses are
in `~/.local/share/easyeffects/{output,irs}/`.

---

## 16. On-screen keyboard: suggestions, layouts, dictation

GNOME Shell's on-screen keyboard (OSK) works on the X12 in tablet mode, but out of the box it has no word suggestions, a small layout without Ctrl or arrows, no dictation, and it always spans the full screen width.
This section adds word suggestions through ibus-typing-booster, and the **OSK Tweaks** extension (`osk-tweaks@monzon`), which is not X12 specific and works on any GNOME 51 touch device:

- an Android phone layout or a staggered laptop layout instead of GNOME's own
- a microphone key for offline dictation
- a keyboard only as wide as its keys, with adjustable height
- a suggestion bar of fixed height, so the keyboard does not jump

### Word suggestions (ibus-typing-booster)

GNOME's OSK has a suggestion bar above the keys, but it only fills it through the IBus engine **ibus-typing-booster**.
While the OSK is open, GNOME switches to that engine by itself, if it is installed and the active input source is a plain keyboard layout (an `xkb:` source such as `us` or `ru`).
Tapping a suggestion inserts the word and a space.

```
sudo pacman -S ibus-typing-booster hunspell hunspell-en_us hunspell-ru
gsettings set org.freedesktop.ibus.engine.typing-booster:/org/freedesktop/ibus/engine/typing-booster/ \
    dictionary 'en_US,ru_RU'
```

- `hunspell` is the important one: typing-booster checks words through enchant, and enchant's hunspell plug-in needs `libhunspell`, which enchant only lists as optional.
  Without it every dictionary fails with `DictNotFoundError` in `~/.local/share/ibus-typing-booster/debug.log`, and no suggestions appear.
  `enchant-lsmod-2 -list-dicts` should list `en_US (hunspell)` and `ru_RU (hunspell)`.
- Pick the dictionaries for your own layouts; the schema is relocatable, so the path after the colon is needed.
- Log out and in once: IBus and GNOME Shell only list input engines at login (`ibus list-engine` shows `typing-booster` afterwards).
- No suggestions in terminals: they tell input methods they are a terminal (input purpose 10), and typing-booster passes keys straight through there on purpose. Test in a normal text field.
- Make digits always type digits.
  While the OSK is open, GNOME feeds every tapped key through typing-booster, and typing-booster's default key bindings use 1 to 9 to pick suggestion 1 to 9.
  Once it shows suggestions for a number (numbers typed before, for example), each tapped digit picks a suggestion instead, and the number pad seems to stop typing.
  This keeps only F1 to F9 for picking suggestions (on the OSK, tap the suggestion bar instead):

  ```
  python3 - <<'EOF'
  from gi.repository import Gio, GLib
  s = Gio.Settings.new_with_path('org.freedesktop.ibus.engine.typing-booster',
                                 '/org/freedesktop/ibus/engine/typing-booster/')
  kb = s.get_value('keybindings').unpack()
  digits = {str(n) for n in range(10)} | {f'KP_{n}' for n in range(10)}
  for n in range(1, 10):
      k = f'commit_candidate_{n}_plus_space'
      kb[k] = [x for x in kb[k] if x not in digits]
  s.set_value('keybindings', GLib.Variant('a{sv}', {k: GLib.Variant('as', v) for k, v in kb.items()}))
  Gio.Settings.sync()
  EOF
  ```

  Undo: `gsettings reset org.freedesktop.ibus.engine.typing-booster:/org/freedesktop/ibus/engine/typing-booster/ keybindings`.
- The first OSK open right after a login can time out while the Python engine starts (about 2.5 s; GNOME logs "Timeout was reached" from `_setEngine`) and falls back to the plain layout.
  Closing and reopening the OSK works.

### Install OSK Tweaks

```
cp -r home/.local/share/gnome-shell/extensions/osk-tweaks@monzon ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/osk-tweaks@monzon/schemas
gnome-extensions enable osk-tweaks@monzon    # or add it to org.gnome.shell enabled-extensions
```

Log out and in once; GNOME Shell only loads new or changed extension code at login.
Settings: `gnome-extensions prefs osk-tweaks@monzon`, or the Extensions app.
The **Show Keyboard** button there opens the OSK and keeps it open until the settings window closes, so layout and size changes show as you make them.

For dictation, also install the speech engine (below).

### Layouts

The Layout setting picks Stock (GNOME's own), Laptop or Android (the default).
Layouts exist for English (`us`) and Russian (`ru`); other languages keep GNOME's stock keyboard.

- **Android**: an Android-like keyboard, measured key by key on screenshots of a phone keyboard.
  - Letters with digits on long-press of the top row; Russian fits 11 letters in the same width.
  - `?123` and `=\<` symbol pages, as Android shows them for each language (₽ on the Russian `?123` page).
  - `12/34` opens a number pad: `+ - * /` stacked on the left, big digits, `% ␣ ⌫` on the right.
  - The language key switches to the next input source on tap and shows GNOME's language menu on tap and hold.
  - Tapping the comma types a comma; tap and hold opens the emoji picker, as on Android when the language key replaces the emoji key.
- **Laptop**: a staggered 15-key-wide keyboard with a number row, Tab, Caps, Shift, Ctrl, Alt, Esc and arrow keys.

How it works:

- The layouts are JSON files in GNOME's own OSK format, compiled into `layouts/<style>-layouts.gresource` at GNOME's resource path (`/org/gnome/shell/osk-layouts/us.json`).
  GLib searches the most recently registered resource bundle first, so registering one replaces GNOME's files without touching them.
- `layouts/make-layouts.py` generates them; long-press variants come from GNOME's stock layouts, plus Android-style extras on symbols and digits. Run `python3 make-layouts.py` after editing.
- GNOME places keys on a grid of half keys, so the Android-like widths (Russian letters are 10/11 of a key) do not fit.
  The extension places keys with its own layout manager instead: each key's edges are exact fractions of the page, so rows always run from the left edge to the right edge.
  A finer `Clutter.GridLayout` does not work: homogeneous columns get whole pixels, with the spare ones going to the leftmost columns, and no column shrinks below its widest key's share, so rows overflowed the right edge in portrait.

### Special text fields

Apps tell the input method what a text field is for (its input purpose, part of Wayland's text-input protocol), and GNOME loads a different layout by it, not the language's one:

| Field | GNOME's own layout | OSK Tweaks (Android) |
|---|---|---|
| Terminal | `<language>-extended` (there is no `ru-extended`, so Russian gets the English one) | the Android layout with a Termux-style row on top: Esc, Tab, Ctrl, Alt, `/`, `-` and arrows |
| Web address | `url` (English only) | the current language's letters, `/` instead of the comma, `.com .org .net .ru` on long-press of the period |
| Email | `email` (English only) | as for web addresses, with `@` instead of the comma |
| Number, digits, phone | a 3 x 3 pad | an Android-like 4 x 4 pad: `1 2 3 -`, `4 5 6 ␣`, `7 8 9 ⌫`, `, 0 .` / `* 0 #` and Enter |
| Anything else | the language's layout | the language's layout |

- Before the special files were added, GNOME's stock layouts showed up in terminals, URL bars and number fields even with the Android style chosen.
- "Layouts for special fields" in the settings switches each kind on or off; a kind that is off gets the normal layout. Default: numbers, web addresses and terminals on, email off.
- The extension wraps `Keyboard._updateLayout`: a switched-off kind is treated as a normal field, and web address or email fields load `<language>+url.json` or `<language>+email.json` from the chosen style's bundle, so they keep the current language.
  GNOME falls back to the plain `<language>.json` if a style has no such file.
- The number pads are modelled on Android's from memory, not measured on screenshots like the other pages.
- The laptop style already has those keys, so it uses its normal layout for terminals, web addresses and email.

### Size

GNOME makes the keyboard panel as wide as the screen, 1/3 of the screen height in landscape and 1/4 in portrait, and keeps the keys square, centred in the panel.
In landscape that leaves wide empty bands on both sides, which still belong to the keyboard.

OSK Tweaks makes the panel only as wide as its keys, centred, so the screen beside it shows the app underneath and passes touches to it.

| Setting | Default | Range |
|---|---|---|
| Height in landscape | 40 % of the screen height | 25 to 45 % |
| Height in portrait | 26 % | 20 to 35 % |
| Widest keys (key width per key height) | 1.35 | 1.0 to 1.6 |

- Keys start square and get wider only as far as needed to fill the screen width, up to the "Widest keys" limit.
  On the X12 (1440 x 960 at 133 % scaling) square keys would need 30 % of the height to fill the width in portrait, but 65 % in landscape, so landscape stays a centred block.
- The height includes the suggestion bar, and never goes below what the keys need or above half the screen.
- The height setting is for the usual 4 rows of keys. Pages with 5 rows (the terminal row, the laptop layout) get taller, so their keys stay the same size.

### Dictation

The microphone key sits right after the space bar (Android) or after the language key (other layouts); the space bar gives up one key for it.

- Tap it to start listening.
  The icon dims to 35 % and fills from the bottom with the input level, like a VU meter.
- Speech is cut into phrases at pauses ("Pause that ends a phrase", 1.2 s by default), and each phrase is typed at the cursor as soon as it is transcribed.
- Tap again to stop; three animated dots show while the last phrase is transcribed.
  Listening also stops by itself after 30 s without speech ("Stop after silence"; 0 never stops).
- Transcription is offline, in the language of the current layout (`us`: English, `ru`: Russian, others detected).
- "Runs on" picks the engine:
  - GPU (the default): [OpenVINO GenAI](https://github.com/openvinotoolkit/openvino.genai) on the Intel Iris Xe iGPU.
  - CPU: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2, int8, 5 beams).
- The model loads while you speak and stays loaded for 5 minutes after the last dictation ("Keep model loaded"), then the helper exits and frees its RAM.
- Models: Base, Small, Medium and Large v3 Turbo (the default).
  Each engine has its own copy of a model (OpenVINO's int8 versions from [huggingface.co/OpenVINO](https://huggingface.co/OpenVINO)).
  They download from the settings page when selected, with a progress bar, and can be deleted there; the model in use cannot be deleted.
- Phrases are transcribed while you keep speaking, so after stopping only the last phrase is left.

#### Which engine and model

The GPU engine is about twice as fast as the CPU for the same model, at less than half the energy, with the same accuracy:

| Per phrase (1 to 8 s of speech) | CPU (faster-whisper, 5 beams) | GPU (OpenVINO, 1 beam) | GPU gain |
|---|---|---|---|
| Large v3 Turbo: time | 4.7 s | 2.1 s | 2.2x faster |
| Large v3 Turbo: energy | 71 J | 31 J | 56 % less |
| Large v3 Turbo: RAM while loaded | 2.5 GB | 0.6 GB | 4x less |
| Small: time | 1.0 to 1.1 s | 0.6 s | 1.8x faster |
| Small: energy | 19 to 22 J | 9 J | 55 % less |

So on the GPU, Large v3 Turbo is the default: it costs about twice the time of Small on the CPU (the old default), for a large gain in Russian and a smaller one in English.

Measured on the i7 X12 (i7-1160G7, on AC, balanced power profile), with 40 Russian clips from the [Golos](https://github.com/salute-developers/golos) test set (1 to 6 s, 20 clean and 20 far-field) and 40 English clips from the [LibriSpeech](https://www.openslr.org/12) test set (3 to 8 s, 20 from test-clean and 20 from the harder test-other).
Time and energy are per clip; energy is the RAPL package counter, which includes the iGPU.
Word error rate (WER), lower is better; the Russian references spell numbers as words while Whisper writes digits, which inflates the Russian WER for all of them alike.

| Engine, model, beams | Russian: time | energy | WER | English: time | energy | WER |
|---|---|---|---|---|---|---|
| CPU, Small, 5 | 1.08 s | 18.7 J | 26.3 % | 1.01 s | 21.6 J | 5.7 % |
| CPU, Small, 1 | 1.09 s | 16.2 J | 29.3 % | 1.13 s | 16.9 J | 5.9 % |
| GPU, Small, 1 | 0.57 s | 8.5 J | 27.8 % | 0.59 s | 8.9 J | 6.1 % |
| CPU, Large v3 Turbo, 5 | 4.72 s | 70.5 J | 11.2 % | 4.76 s | 71.2 J | 4.2 % |
| CPU, Large v3 Turbo, 1 | 4.69 s | 70.1 J | 12.2 % | 4.70 s | 70.3 J | 4.6 % |
| **GPU, Large v3 Turbo, 1** | **2.10 s** | **31.3 J** | **11.2 %** | **2.11 s** | **31.5 J** | **5.1 %** |
| OpenVINO on the CPU, Large v3 Turbo, 5 | 5.26 s | 78.7 J | 10.2 % | 5.25 s | 78.5 J | 4.6 % |

- The model matters far more than beams.
  In Russian, Small makes over twice the errors of Large v3 Turbo ("Закосот с яблоки" for "заказать яблоки зелёные"); in English, Small is already good and Large v3 Turbo gains 1 to 1.5 points.
  5 beams instead of 1 gain 0 to 3 points.
- GPU and CPU Large v3 Turbo differ by 4 words out of 495 in English (a French street name, a dropped "asked the organiser") and not at all in Russian.
- For English only, Small on the GPU is the frugal choice: 0.6 s and 9 J per phrase.
- OpenVINO's GPU pipeline has no beam search (`Not Implemented` in `iremote_tensor.hpp`), so it always decodes greedily (1 beam).
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with its Vulkan backend on the GPU was slower: 4.1 s for an 11 s English clip with Large v3 Turbo, against 2.4 s with OpenVINO and 4.7 s with faster-whisper.
- Loading: the first load of a model on the GPU compiles it (about 10 s) into `~/.cache/osk-tweaks/openvino` (about 870 MB for Large v3 Turbo); later loads take about 0.6 s.
  The first transcription after a load is slow (about 3.5 s), so the helper runs it on a second of silence right after loading, while you are still speaking.
  In practice the first phrase is typed about 6 s after tapping the key, later ones about 2 s after each pause.

#### Speech engine

The helper (`dictate.py`) and model tool (`models.py`) run in their own Python environment, managed by [uv](https://docs.astral.sh/uv/) with exact pins and a lock file, so a system Python update cannot break them:

```
sudo pacman -S uv
cp -r home/.local/share/osk-tweaks ~/.local/share/
cd ~/.local/share/osk-tweaks/engine && uv sync
```

- uv fetches a standalone CPython 3.13 and installs OpenVINO GenAI 2026.4.1, faster-whisper 1.2.1, ctranslate2 4.8.3 and PyAV 15.1.0 into `.venv` (about 600 MB).
  PyAV must stay below 16: faster-whisper 1.2.1 passes `metadata_errors` to `av.open()`, which PyAV 16 removed.
- The GPU engine needs Intel's OpenCL driver: `sudo pacman -S intel-compute-runtime`.
  The helper uses only that driver (`OCL_ICD_VENDORS`), as Mesa's rusticl (`opencl-mesa`) prints a warning on every start.
  If the GPU cannot be used, it transcribes with OpenVINO on the CPU and logs why to the journal.
- `openvino-telemetry` is left out (`exclude-dependencies` in `pyproject.toml`).
  OpenVINO imports it with its model converter, and it sends usage data to Google Analytics (it writes a client ID to `~/intel`) from a forked process; in the multi-threaded helper that fork deadlocks and the helper hangs at exit.
  Without it, OpenVINO uses a built-in stub.
- Both engines cut silence and noise out of each phrase with faster-whisper's voice detector (Silero VAD) first, as Whisper tends to make up text for stretches without speech.
- Models are cached in `~/.local/share/osk-tweaks/hf`; the helper runs with `HF_HUB_OFFLINE=1`, so only the settings page downloads anything.
  Deleting an OpenVINO model also empties the compile cache, which refills on the next load.
- Recording uses `pw-cat` (PipeWire), from the default microphone.
- The helper talks to the extension over stdin and stdout, one line per message; the protocol is described at the top of `dictate.py`.

### Fixed-height suggestion bar

The bar is 17 pt high when empty, but a suggestion button is a line of 1.182 em text plus 6 px padding above and below, so the whole keyboard grew and shrank by about 10 px whenever suggestions came and went.
OSK Tweaks' stylesheet reserves the button height all the time:

```css
.word-suggestions {
  min-height: 2em;
}
```

### GNOME OSK quirks found along the way

- GNOME only keeps an OSK while in touch mode with a touchscreen as the last input device (or with the accessibility switch on), and destroys it otherwise, for example after a pen tap.
  While Show Keyboard is active, the extension counts both as true, so the preview keyboard stays.
- GNOME never disconnects a destroyed keyboard's height handler, so every later height change logged "has been already disposed" errors from `keyboard.js`; the extension disconnects it.
- Clutter reports an actor's fixed height as its minimum height, so the extension clears the height before measuring what the keys need.

---

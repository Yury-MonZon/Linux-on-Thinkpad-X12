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
- Transcription is offline with [faster-whisper](https://github.com/SYSTRAN/faster-whisper), in the language of the current layout (`us`: English, `ru`: Russian, others detected).
- The model loads while you speak and stays loaded for 5 minutes after the last dictation ("Keep model loaded"), then the helper exits and frees its RAM.
- Models: Base, Small (the default), Medium and Large v3 Turbo.
  They download from the settings page when selected, with a progress bar, and can be deleted there; the model in use cannot be deleted.

Transcription time for a 6.5 s sentence on the X12 (i5-1140G7, on battery, balanced power profile, int8): base 1.3 s, small 2.45 s (about 1.1 GB RAM while loaded), medium 5.8 s, large-v3-turbo 6.8 s.
Phrases are transcribed while you keep speaking, so after stopping only the last phrase is left.

#### Speech engine

The helper (`dictate.py`) and model tool (`models.py`) run in their own Python environment, managed by [uv](https://docs.astral.sh/uv/) with exact pins and a lock file, so a system Python update cannot break them:

```
sudo pacman -S uv
cp -r home/.local/share/osk-tweaks ~/.local/share/
cd ~/.local/share/osk-tweaks/engine && uv sync
```

- uv fetches a standalone CPython 3.13 and installs faster-whisper 1.2.1, ctranslate2 4.8.3 and PyAV 15.1.0 into `.venv`.
  PyAV must stay below 16: faster-whisper 1.2.1 passes `metadata_errors` to `av.open()`, which PyAV 16 removed.
- Models are cached in `~/.local/share/osk-tweaks/hf`; the helper runs with `HF_HUB_OFFLINE=1`, so only the settings page downloads anything.
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

// OSK Tweaks: on-screen keyboard tweaks for GNOME Shell.
//
// Layout: GNOME's stock keyboard, a staggered laptop layout (number row, Tab, Caps, Shift,
// Ctrl, Alt, Esc, arrows) or an Android layout (Gboard's pages). The non-stock layouts are
// GResource bundles in layouts/ with files at GNOME's own path
// (/org/gnome/shell/osk-layouts/us.json, ru.json); GLib searches the most recently registered
// bundle first, so registering one replaces GNOME's files for those languages without touching
// them. layouts/make-layouts.py builds them.
// Keys are placed by KeyLayout instead of GNOME's grid, so a layout can use any fraction of a
// key, and a key can move down by "top" rows, so short keys can be stacked in one column.
//
// Size: the keyboard is only as wide as its keys and centred (GNOME: the full screen width), so
// the screen beside it stays usable; its height and how much wider than tall keys may get are
// settings.
//
// Dictation: a microphone key after the language key. Tap it to start listening: the icon dims
// to 35% and fills from the bottom with the input level, like a VU meter. Tap again to stop;
// it also stops by itself after a configurable stretch without speech, so a forgotten mic
// switches off. Speech is cut into phrases at pauses and each phrase is typed at the cursor as
// soon as it is transcribed, so after stopping only the last phrase is left. Transcription is
// offline (faster-whisper) in the language of the keyboard's current layout (us -> en, ru -> ru).
// The work happens in a helper process (~/.local/share/osk-tweaks/engine/dictate.py in a
// uv-managed venv): it records, meters, cuts phrases and transcribes. It starts when the mic key
// is tapped, so the model loads while you speak, and stops after the configured idle time,
// freeing its RAM.
//
// stylesheet.css gives the word suggestion bar a fixed height, so the keyboard does not jump.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/keyboard.js';
import * as InputSourceManager from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'osk-tweaks']);
const ENGINE_DIR = GLib.build_filenamev([DATA_DIR, 'engine']);
const LANGUAGES = {us: 'en', ru: 'ru'}; // input source id -> whisper language; others: auto

const ICON_MIC = 'audio-input-microphone-symbolic';
const DIM_OPACITY = 89;                 // 35% of 255

// Lays out one keyboard page: each key's cell (x, y, w, h in keys and rows, set by
// _ownPlacement) is the same fraction of the page as of the layout, edges rounded to whole
// pixels, so rows run from the left edge to the right edge and neighbouring keys always meet.
// GNOME's Clutter.GridLayout gives homogeneous columns whole pixels with the spare ones going
// to the leftmost columns, and never shrinks a column below its widest key's share.
const KeyLayout = GObject.registerClass({
    GTypeName: 'OskTweaksKeyLayout',
}, class KeyLayout extends Clutter.LayoutManager {
    // the page's size where every key gets its own preferred size
    _preferred(container, size, units) {
        let min = 0, nat = 0;
        for (const child of container.get_children()) {
            const c = child._oskCell;
            if (!c)
                continue;
            const [cMin, cNat] = size(child, c);
            min = Math.max(min, cMin);
            nat = Math.max(nat, cNat);
        }
        return [min * units, nat * units];
    }

    vfunc_get_preferred_width(container, _forHeight) {
        return this._preferred(container,
            (child, c) => child.get_preferred_width(-1).map(s => s / c.w), container._maxCols || 1);
    }

    // Keys shorter than a row (the number pad's stacked + - * /) shrink with the row instead of
    // raising the minimum height of the whole keyboard
    vfunc_get_preferred_height(container, _forWidth) {
        return this._preferred(container,
            (child, c) => child.get_preferred_height(-1).map(s => s / Math.max(c.h, 1)), container._nRows || 1);
    }

    vfunc_allocate(container, box) {
        const kw = box.get_width() / (container._maxCols || 1);
        const kh = box.get_height() / (container._nRows || 1);
        for (const child of container.get_children()) {
            const c = child._oskCell;
            if (!c)
                continue;
            child.allocate(new Clutter.ActorBox({
                x1: Math.round(box.x1 + c.x * kw),
                y1: Math.round(box.y1 + c.y * kh),
                x2: Math.round(box.x1 + (c.x + c.w) * kw),
                y2: Math.round(box.y1 + (c.y + c.h) * kh),
            }));
        }
    }
});

export default class DictationExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject(
            'changed::model', () => this._stopHelper(),
            'changed::layout', () => this._applyLayout(),
            'changed::dictation', () => {
                if (!this._settings.get_boolean('dictation'))
                    this._stopHelper();
                Main.keyboard._keyboard?._updateKeys();
            },
            'changed::height-landscape', () => Main.keyboard._keyboard?._relayout(),
            'changed::height-portrait', () => Main.keyboard._keyboard?._relayout(),
            'changed::key-width', () => Main.keyboard._keyboard?._relayout(),
            'changed::preview', () => this._preview(),
            this);
        this._settings.set_boolean('preview', false);   // left on if the settings window crashed
        this._layoutResource = null;
        this._keys = new Set();         // mic keys currently on the keyboard
        this._state = 'idle';           // idle | listening | finishing
        this._level = 0;
        this._helper = null;            // {proc, stdin, stdout}
        this._unloadId = 0;
        this._dotsId = 0;
        this._dotPhase = 0;

        const ext = this;
        const proto = Keyboard.Keyboard.prototype;
        this._origAddRowKeys = proto._addRowKeys;
        proto._addRowKeys = function (keys, layout, emojiVisible) {
            ext._keyboard = this;
            const row = ext._prepareRow(keys);
            // the keys GNOME adds, in order (it leaves out the emoji key when emoji is off)
            const placed = row.filter(k => k.action !== 'emoji' || emojiVisible);
            ext._ownPlacement(layout);
            layout._oskTweaksTops = placed.map(k => k.top ?? 0);
            const before = new Set(layout.get_children());
            ext._origAddRowKeys.call(this, row, layout, emojiVisible);
            layout.get_children().filter(c => !before.has(c)).forEach((child, i) => {
                const action = placed[i]?.action;
                if (action === 'dictation')
                    ext._adoptKey(child);
                else if (action === 'languageNext')
                    ext._adoptLanguageKey(child);
                else if (action === 'commaEmoji')
                    ext._adoptCommaKey(child);
            });
        };
        // GNOME sizes the keyboard on opening and on monitor changes (_relayout); a page
        // change (_setActiveLevel) can change the keys' proportions
        this._origRelayout = proto._relayout;
        proto._relayout = function () {
            ext._origRelayout.call(this);
            ext._sizeKeyboard(this);
        };
        this._origSetActiveLevel = proto._setActiveLevel;
        proto._setActiveLevel = function (level) {
            ext._origSetActiveLevel.call(this, level);
            ext._sizeKeyboard(this);
        };
        // After the settings window's "Show Keyboard", nothing closes the keyboard until it closes
        this._origClose = proto.close;
        proto.close = function (immediate = false) {
            if (!ext._settings?.get_boolean('preview'))
                ext._origClose.call(this, immediate);
        };
        // GNOME never disconnects a keyboard's keyboardBox height handler when it destroys the
        // keyboard, so every later height change errors on the dead one. The wrapper is bound at
        // construction, so it closes over GNOME's function instead of reading this._ fields.
        const origOnDestroy = proto._onDestroy;
        this._origOnDestroy = origOnDestroy;
        proto._onDestroy = function () {
            if (this._keyboardHeightNotifyId) {
                Main.layoutManager.keyboardBox.disconnect(this._keyboardHeightNotifyId);
                this._keyboardHeightNotifyId = 0;
            }
            origOnDestroy.call(this);
        };
        this._applyLayout();    // also rebuilds the keyboard
        Main.keyboard._keyboard?._relayout();
    }

    disable() {
        this._stopHelper();
        this._setState('idle');     // also stops the dots animation
        this._settings.disconnectObject(this);
        this._settings = null;
        this._keepKeyboard(false);
        const proto = Keyboard.Keyboard.prototype;
        proto._addRowKeys = this._origAddRowKeys;
        proto._relayout = this._origRelayout;
        proto._setActiveLevel = this._origSetActiveLevel;
        proto.close = this._origClose;
        proto._onDestroy = this._origOnDestroy;
        this._origAddRowKeys = this._origRelayout = this._origSetActiveLevel = this._origClose = null;
        this._origOnDestroy = null;
        this._layoutResource?._unregister();
        this._layoutResource = null;
        const kb = Main.keyboard._keyboard;
        if (kb) {
            kb.x_expand = false;
            kb.x_align = Clutter.ActorAlign.FILL;
            kb._relayout();
            kb._updateKeys();
        }
        this._keys = null;
        this._keyboard = null;
    }

    // --- layout -----------------------------------------------------------------------

    // "Show Keyboard" in the settings window: open the keyboard and keep it open (see the close
    // wrapper in enable), so changes to the layout and size show as they are made
    _preview() {
        const on = this._settings.get_boolean('preview');
        if (!on)
            Main.keyboard._keyboard?.close(true);
        this._keepKeyboard(on);
        if (on)
            Main.keyboard.open(Main.layoutManager.primaryIndex);
    }

    // GNOME only has a keyboard in touch mode with a touchscreen as the last input device (or
    // with the accessibility switch on), and destroys it otherwise, e.g. after a pen tap or with
    // the keyboard cover attached. While previewing, both count as true, so it exists and stays.
    _keepKeyboard(keep) {
        const manager = Main.keyboard;
        if (keep && !this._realSeat) {
            this._realSeat = manager._seat;
            manager._seat = {get_touch_mode: () => true};
            manager._lastDeviceIsTouchscreen = () => true;
        } else if (!keep && this._realSeat) {
            manager._seat = this._realSeat;
            this._realSeat = null;
            delete manager._lastDeviceIsTouchscreen;    // back to GNOME's own
        } else {
            return;
        }
        manager._syncEnabled();
    }

    // Size the keyboard instead of GNOME's full screen width and fixed height:
    //  - the height is the configured share of the screen height (GNOME: 1/3 in landscape,
    //    1/4 in portrait), within GNOME's limits: at least what the keys need, at most half
    //  - the width is only what the keys need, centred, so the screen beside the keyboard stays
    //    visible and usable. Keys start square and may get up to key-width times wider than
    //    tall to fill the screen width, never wider than the screen.
    _sizeKeyboard(kb) {
        const monitor = Main.layoutManager.keyboardMonitor;
        const page = kb._currentPage;
        if (!monitor || !page)
            return;
        const landscape = monitor.width > monitor.height;
        const share = this._settings.get_uint(landscape ? 'height-landscape' : 'height-portrait') / 100;
        // what the keys and the suggestion bar need; with a fixed height set (GNOME's, or ours
        // from last time) Clutter would report that height as the minimum instead
        kb.height = -1;
        const [minHeight] = kb.get_preferred_height(-1);
        kb.height = Math.clamp(monitor.height * share, minHeight, monitor.height / 2);

        const [cols, rows] = page.getRatio();
        const [, barHeight] = kb._suggestions.visible ? kb._suggestions.get_preferred_height(-1) : [0, 0];
        const padding = kb.get_stage() ? kb.get_theme_node().get_vertical_padding() : 0;
        const stretch = this._settings.get_double('key-width');
        kb.width = Math.min(monitor.width, Math.round((kb.height - barHeight - padding) * cols / rows * stretch));
        kb._aspectContainer.setRatio(cols * stretch, rows);
        kb.x_expand = true;
        kb.x_align = Clutter.ActorAlign.CENTER;
    }

    _applyLayout() {
        this._layoutResource?._unregister();
        this._layoutResource = null;
        const style = this._settings.get_string('layout');
        if (style !== 'stock') {
            const path = GLib.build_filenamev([this.path, 'layouts', `${style}-layouts.gresource`]);
            try {
                this._layoutResource = Gio.Resource.load(path);
                this._layoutResource._register();
            } catch (e) {
                this._layoutResource = null;
                Main.notifyError('OSK Tweaks', `Cannot load the ${style} layout: ${e.message}`);
            }
        }
        Main.keyboard._keyboard?._updateKeys();
    }

    // --- the dictation key -------------------------------------------------------------

    // Adjust a row before GNOME builds its keys:
    //  - the language key gets its own action name, so GNOME's tap handler (open the menu) does
    //    not apply; _adoptLanguageKey gives it tap = next language, hold = menu
    //  - a one-unit mic key goes after the language key (Android: after the space bar, as in
    //    Gboard), and the space bar gives up one unit for it
    _prepareRow(keys) {
        const lang = keys.findIndex(k => k.action === 'languageMenu');
        if (lang < 0)
            return keys;
        const row = keys.map(k => ({...k, strings: k.strings ? [...k.strings] : undefined}));
        row[lang].action = 'languageNext';
        if (!this._settings.get_boolean('dictation'))
            return row;
        const space = row.findIndex(k => k.strings?.[0] === ' ' && (k.width ?? 1) >= 2);
        if (space >= 0)
            row[space].width -= 1;
        const after = this._settings.get_string('layout') === 'android' && space >= 0 ? space : lang;
        row.splice(after + 1, 0, {action: 'dictation', iconName: ICON_MIC, width: 1});
        return row;
    }

    // Let KeyLayout place the keys of a KeyContainer (one keyboard page) instead of GNOME's
    // grid. Each key's cell is its position in keys and rows, with its "top" (queued by the
    // _addRowKeys wrapper) added to its row.
    _ownPlacement(layout) {
        if (layout._oskTweaksTops)
            return;
        layout.layout_manager = new KeyLayout();
        layout.appendKey = function (key, width = 1, height = 1, leftOffset = 0) {
            const left = this._currentCol + leftOffset;
            const top = this._nRows - 1 + (this._oskTweaksTops.shift() ?? 0);
            key._oskCell = {x: left, y: top, w: width, h: height};
            this.add_child(key);
            this._currentCol += leftOffset + width;
            this._maxCols = Math.max(this._currentCol, this._maxCols);
        };
    }

    // Tap does tap(), tap and hold does hold() instead
    _tapOrHold(key, tap, hold) {
        let held = false;
        key.keyButton.connect('notify::pressed', button => {
            if (button.pressed)
                held = false;
        });
        key.connect('long-press', () => {
            held = true;
            hold();
        });
        key.connect('released', () => {
            if (!held)
                tap();
        });
    }

    // Tap: switch to the next input source, as Alt+Shift or Super+Space do.
    // Tap and hold: GNOME's language menu.
    _adoptLanguageKey(key) {
        this._tapOrHold(key,
            () => InputSourceManager.getInputSourceManager()._modifiersSwitcher(),
            () => this._keyboard?._popupLanguageMenu(key));
    }

    // Comma on the Android letter pages. Tap: type a comma, as GNOME's own keys do.
    // Tap and hold: the emoji picker, as in Gboard when its language key replaces the emoji key.
    _adoptCommaKey(key) {
        this._tapOrHold(key,
            () => {
                const kb = this._keyboard;
                kb?._keyboardController.commit(',', kb._modifiers).then(() => {
                    kb._disableAllModifiers();
                    kb._updateLevelFromHints(true);
                }).catch(console.error);
            },
            () => {
                if (this._keyboard?._emojiVisible)
                    this._keyboard._toggleEmoji();
            });
    }

    // The key shows one of two things:
    //  - the mic icon. While listening it is dimmed to 35%, and a full-brightness copy is
    //    revealed from the bottom edge up to the input level, like a VU meter. Everything is
    //    placed by hand in a fixed square the size of the icon, so the fill always starts at
    //    the bottom.
    //  - three dots lighting up in turn while the last phrase is transcribed.
    _adoptKey(key) {
        const dim = new St.Icon({icon_name: ICON_MIC});
        const bright = new St.Icon({icon_name: ICON_MIC});
        const clip = new St.Widget({clip_to_allocation: true});     // fixed layout
        clip.add_child(bright);
        const square = new St.Widget({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        square.add_child(dim);
        square.add_child(clip);

        const dots = [0, 1, 2].map(() => new St.Label({text: '\u2022', style: 'font-size: 1.4em; margin: 0 1px;'}));
        const dotsBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        dots.forEach(d => dotsBox.add_child(d));

        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        holder.add_child(square);
        holder.add_child(dotsBox);
        key.keyButton.set_child(holder);
        key._icon = dim;    // keeps Key.iconName working

        const meter = {dim, bright, clip, square, dots, dotsBox};
        this._keys.add(meter);
        key.connect('released', () => this._toggle());
        key.connect('destroy', () => this._keys?.delete(meter));
        dim.connect('notify::mapped', () => this._drawKey(meter));   // icon size is known once shown
        this._drawKey(meter);
    }

    _drawKey(m) {
        const finishing = this._state === 'finishing';
        m.square.visible = !finishing;
        m.dotsBox.visible = finishing;
        if (finishing) {
            m.dots.forEach((d, i) => (d.opacity = i === this._dotPhase ? 255 : 70));
            return;
        }

        const [, size] = m.dim.get_preferred_height(-1);
        if (size <= 0)
            return;
        m.square.set_size(size, size);
        m.dim.set_position(0, 0);
        m.dim.set_size(size, size);
        m.bright.set_size(size, size);

        const listening = this._state === 'listening';
        m.dim.opacity = listening ? DIM_OPACITY : 255;
        const h = listening ? Math.round(size * this._level) : 0;
        m.clip.visible = h > 0;
        m.clip.set_position(0, size - h);       // the clip's bottom edge is the square's
        m.clip.set_size(size, h);
        m.bright.set_position(0, h - size);     // so the bright icon lines up with the dim one
    }

    _redraw() {
        for (const m of this._keys)
            this._drawKey(m);
    }

    _setState(state) {
        this._state = state;
        if (state !== 'listening')
            this._level = 0;
        if (state === 'finishing' && !this._dotsId) {
            this._dotPhase = 0;
            this._dotsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._dotPhase = (this._dotPhase + 1) % 3;
                this._redraw();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (state !== 'finishing' && this._dotsId) {
            GLib.source_remove(this._dotsId);
            this._dotsId = 0;
        }
        this._redraw();
    }

    // --- dictation --------------------------------------------------------------------

    _toggle() {
        if (this._state === 'idle')
            this._start();
        else if (this._state === 'listening')
            this._finish();
    }

    _language() {
        const id = InputSourceManager.getInputSourceManager().currentSource?.id ?? '';
        return LANGUAGES[id.split('+')[0]] ?? 'auto';
    }

    _start() {
        if (!this._ensureHelper())
            return;
        this._cancelUnload();
        const pauseMs = Math.round(this._settings.get_double('pause-seconds') * 1000);
        const silenceMs = this._settings.get_uint('silence-stop-seconds') * 1000;
        if (!this._send(`start ${this._language()} ${pauseMs} ${silenceMs}`))
            return;
        this._setState('listening');
    }

    _finish() {
        if (this._state !== 'listening')
            return;
        this._setState('finishing');
        this._send('stop');
    }

    _onLine(line) {
        const sp = line.indexOf(' ');
        const [cmd, arg] = sp < 0 ? [line, ''] : [line.slice(0, sp), line.slice(sp + 1)];
        if (cmd === 'level') {
            if (this._state === 'listening') {
                this._level = Number(arg) || 0;
                this._redraw();
            }
        } else if (cmd === 'text') {
            const text = this._clean(arg);
            if (text)
                this._insert(text);
        } else if (cmd === 'autostop') {    // the helper stopped after the silence limit
            if (this._state === 'listening')
                this._setState('finishing');
        } else if (cmd === 'end') {
            this._setState('idle');
            this._scheduleUnload();
        } else if (cmd === 'error') {
            Main.notifyError('Dictation', arg);
        }
    }

    _clean(text) {
        return text
            .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')   // [BLANK_AUDIO], (music) and similar
            .replace(/\s+/g, ' ')
            .trim();
    }

    _insert(text) {
        const str = `${text} `;
        // Commit straight to the focused text field. The keyboard's own commit path would
        // feed every character through ibus-typing-booster while suggestions are on.
        if (Main.inputMethod.currentFocus)
            Main.inputMethod.commit(str);
        else
            this._keyboard?._keyboardController.commit(str).catch(console.error);
    }

    // --- helper process ---------------------------------------------------------------

    _ensureHelper() {
        if (this._helper)
            return true;
        const python = GLib.build_filenamev([ENGINE_DIR, '.venv', 'bin', 'python']);
        const script = GLib.build_filenamev([ENGINE_DIR, 'dictate.py']);
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            launcher.setenv('HF_HOME', GLib.build_filenamev([DATA_DIR, 'hf']), true);
            launcher.setenv('HF_HUB_OFFLINE', '1', true);   // models come from the settings page
            const proc = launcher.spawnv([python, '-I', script, this._settings.get_string('model')]);
            const helper = {
                proc,
                stdin: proc.get_stdin_pipe(),
                stdout: new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}),
            };
            this._helper = helper;
            this._readLines(helper);
            proc.wait_async(null, () => this._onHelperExit(helper));
            return true;
        } catch (e) {
            Main.notifyError('Dictation', `Speech engine failed to start: ${e.message}`);
            return false;
        }
    }

    _readLines(helper) {
        helper.stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {}
            if (line === null || this._helper !== helper)
                return;     // helper gone, or replaced
            this._onLine(line);
            this._readLines(helper);
        });
    }

    _onHelperExit(helper) {
        if (this._helper !== helper)
            return;         // stopped on purpose
        this._helper = null;
        if (this._state !== 'idle') {
            Main.notifyError('Dictation',
                'The speech engine stopped. Is the selected model downloaded? ' +
                'Open the OSK Tweaks settings to download it.');
            this._setState('idle');
        }
    }

    _send(command) {
        try {
            this._helper.stdin.write_all(new TextEncoder().encode(`${command}\n`), null);
            this._helper.stdin.flush(null);
            return true;
        } catch (e) {
            Main.notifyError('Dictation', `Speech engine stopped: ${e.message}`);
            this._stopHelper();
            this._setState('idle');
            return false;
        }
    }

    _stopHelper() {
        this._cancelUnload();
        if (!this._helper)
            return;
        const {proc} = this._helper;
        this._helper = null;
        proc.send_signal(15);   // SIGTERM to this exact process; it stops its recorder too
        if (this._state !== 'idle')
            this._setState('idle');
    }

    _scheduleUnload() {
        this._cancelUnload();
        const minutes = this._settings.get_uint('keep-loaded-minutes');
        if (minutes === 0) {
            this._stopHelper();
            return;
        }
        this._unloadId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._unloadId = 0;
            this._stopHelper();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelUnload() {
        if (this._unloadId) {
            GLib.source_remove(this._unloadId);
            this._unloadId = 0;
        }
    }
}

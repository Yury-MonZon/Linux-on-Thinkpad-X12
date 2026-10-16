import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'osk-tweaks']);
const ENGINE_DIR = GLib.build_filenamev([DATA_DIR, 'engine']);

// [setting value, short name for the dropdown, details shown under the row title]
const MODELS = [
    ['base', 'Base', 'Fastest; about 0.6 GB while loaded'],
    ['small', 'Small', 'More accurate; about 1.1 GB while loaded'],
    ['medium', 'Medium', 'More accurate still, about 2.5x slower than small; about 2.8 GB while loaded'],
    ['large-v3-turbo', 'Large v3 Turbo', 'Most accurate, about 3x slower than small; about 2.5 GB while loaded'],
];

// Runs engine/models.py with the model cache the speech helper uses
function modelsTool(args, flags) {
    const launcher = new Gio.SubprocessLauncher({flags});
    launcher.setenv('HF_HOME', GLib.build_filenamev([DATA_DIR, 'hf']), true);
    return launcher.spawnv([
        GLib.build_filenamev([ENGINE_DIR, '.venv', 'bin', 'python']), '-I',
        GLib.build_filenamev([ENGINE_DIR, 'models.py']), ...args,
    ]);
}

const LAYOUTS = [
    ['stock', 'Stock', "GNOME's own on-screen keyboard"],
    ['laptop', 'Laptop', 'Staggered laptop keyboard: number row, Tab, Caps, Shift, Ctrl, Alt, Esc, arrows'],
    ['android', 'Android', 'Android layout: digits on long-press of the top row, symbol pages and a number pad'],
];

export default class OskTweaksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._downloaded = null;    // Set of complete model names, once known
        this._download = null;      // running download: {proc, name}

        const page = new Adw.PreferencesPage();

        // Keyboard layout
        const kbGroup = new Adw.PreferencesGroup({
            title: 'Keyboard',
            description: 'Keyboard layouts without a Laptop or Android version keep the stock keyboard.',
        });
        page.add(kbGroup);
        const layout = new Adw.ComboRow({
            title: 'Layout',
            model: Gtk.StringList.new(LAYOUTS.map(([, name]) => name)),
        });
        const syncLayout = () => {
            const i = Math.max(0, LAYOUTS.findIndex(([id]) => id === settings.get_string('layout')));
            layout.selected = i;
            layout.subtitle = LAYOUTS[i][2];
        };
        syncLayout();
        settings.connect('changed::layout', syncLayout);
        layout.connect('notify::selected', () => settings.set_string('layout', LAYOUTS[layout.selected][0]));
        kbGroup.add(layout);

        // Opens the keyboard and keeps it open while the settings are changed, until the window
        // closes
        const preview = new Adw.ButtonRow({
            title: 'Show Keyboard',
            start_icon_name: 'input-keyboard-symbolic',
            tooltip_text: 'Keeps the on-screen keyboard open until this window closes, to see changes as you make them',
        });
        preview.connect('activated', () => {
            // switch it off first if it is still on, so the extension always sees a change and
            // opens the keyboard again (for example after GNOME replaced the keyboard)
            if (settings.get_boolean('preview'))
                settings.set_boolean('preview', false);
            settings.set_boolean('preview', true);
        });
        kbGroup.add(preview);
        window.connect('close-request', () => {
            settings.set_boolean('preview', false);
            return false;
        });

        const heightLandscape = new Adw.SpinRow({
            title: 'Height in landscape',
            subtitle: 'Percent of the screen height, suggestion bar included; GNOME uses 33',
            adjustment: new Gtk.Adjustment({lower: 25, upper: 45, step_increment: 1, page_increment: 5}),
        });
        settings.bind('height-landscape', heightLandscape, 'value', Gio.SettingsBindFlags.DEFAULT);
        kbGroup.add(heightLandscape);

        const heightPortrait = new Adw.SpinRow({
            title: 'Height in portrait',
            subtitle: 'Percent of the screen height, suggestion bar included; GNOME uses 25',
            adjustment: new Gtk.Adjustment({lower: 20, upper: 35, step_increment: 1, page_increment: 5}),
        });
        settings.bind('height-portrait', heightPortrait, 'value', Gio.SettingsBindFlags.DEFAULT);
        kbGroup.add(heightPortrait);

        const keyWidth = new Adw.SpinRow({
            title: 'Widest keys',
            subtitle: 'How much wider than tall keys may get to fill the screen width; 1 keeps them square',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 1.0, upper: 1.6, step_increment: 0.05, page_increment: 0.1}),
        });
        settings.bind('key-width', keyWidth, 'value', Gio.SettingsBindFlags.DEFAULT);
        kbGroup.add(keyWidth);

        // Dictation
        const group = new Adw.PreferencesGroup({
            title: 'Dictation',
            description: 'A microphone key after the language key. Offline, with faster-whisper; changes apply to the next dictation.',
        });
        page.add(group);
        const enabled = new Adw.SwitchRow({title: 'Dictation key'});
        settings.bind('dictation', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        const keep = new Adw.SpinRow({
            title: 'Keep model loaded',
            subtitle: 'Minutes after the last dictation; 0 unloads it right away',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 120, step_increment: 1, page_increment: 5}),
        });
        settings.bind('keep-loaded-minutes', keep, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(keep);

        const pause = new Adw.SpinRow({
            title: 'Pause that ends a phrase',
            subtitle: 'Seconds of quiet before the phrase so far is typed; longer suits slower speech',
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0.5, upper: 3.0, step_increment: 0.1, page_increment: 0.5}),
        });
        settings.bind('pause-seconds', pause, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pause);

        const silence = new Adw.SpinRow({
            title: 'Stop after silence',
            subtitle: 'Seconds without speech before listening stops by itself; 0 never stops',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 600, step_increment: 5, page_increment: 30}),
        });
        settings.bind('silence-stop-seconds', silence, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(silence);

        const model = new Adw.ComboRow({
            title: 'Model',
            model: Gtk.StringList.new(MODELS.map(([, name]) => name)),
        });
        group.add(model);

        // Shown while a model downloads
        const progress = new Gtk.ProgressBar({valign: Gtk.Align.CENTER, hexpand: true});
        const cancel = new Gtk.Button({
            icon_name: 'process-stop-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Cancel download', css_classes: ['flat'],
        });
        const downloadRow = new Adw.ActionRow({visible: false});
        downloadRow.add_suffix(progress);
        downloadRow.add_suffix(cancel);
        group.add(downloadRow);
        for (const row of [keep, pause, silence, model])
            enabled.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        const storage = new Adw.PreferencesGroup({
            title: 'Downloaded speech models',
            description: 'The model in use cannot be deleted; select another one first.',
        });
        page.add(storage);
        let storageRows = [];
        const refreshStatus = () => {
            let proc;
            try {
                proc = modelsTool(['status'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            } catch {
                this._downloaded = new Set();
                return;
            }
            proc.communicate_utf8_async(null, null, (p, res) => {
                let entries = [];
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    entries = (out ?? '').trim().split(/\s+/).filter(Boolean).map(e => e.split(':'));
                } catch {}
                this._downloaded = new Set(entries.filter(([, , st]) => st === 'complete').map(([n]) => n));
                showSelection(model.selected);
                fillStorage(entries);
            });
        };
        const fillStorage = entries => {
            storageRows.forEach(r => storage.remove(r));
            storageRows = [];
            const inUse = settings.get_string('model');
            for (const [name, size, state] of entries) {
                const label = MODELS[indexOf(name)][1];
                const row = new Adw.ActionRow({
                    title: label,
                    subtitle: `${GLib.format_size(Number(size))}${state === 'partial' ? ', partial download' : ''}`,
                });
                const del = new Gtk.Button({
                    icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                    tooltip_text: name === inUse ? 'In use' : `Delete ${label}`,
                    sensitive: name !== inUse && this._download?.name !== name,
                });
                del.connect('clicked', () => {
                    del.sensitive = false;
                    row.subtitle = 'Deleting';
                    try {
                        modelsTool(['delete', name], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
                            .communicate_utf8_async(null, null, () => refreshStatus());
                    } catch (e) {
                        row.subtitle = `Delete failed: ${e.message}`;
                    }
                });
                row.add_suffix(del);
                storage.add(row);
                storageRows.push(row);
            }
            if (!entries.length) {
                const row = new Adw.ActionRow({title: 'No models downloaded'});
                storage.add(row);
                storageRows.push(row);
            }
        };

        const indexOf = name => Math.max(0, MODELS.findIndex(([id]) => id === name));
        let syncing = false;
        const showSelection = i => {
            const [id, , details] = MODELS[i];
            const missing = this._downloaded && !this._downloaded.has(id);
            model.subtitle = missing ? `${details}. Not downloaded yet: selecting it downloads it` : details;
        };
        const syncFromSettings = () => {
            syncing = true;
            model.selected = indexOf(settings.get_string('model'));
            syncing = false;
            showSelection(model.selected);
        };

        const stopDownload = () => {
            this._download?.proc.force_exit();
            this._download = null;
            downloadRow.visible = false;
        };

        const startDownload = name => {
            stopDownload();
            const label = MODELS[indexOf(name)][1];
            downloadRow.title = `Downloading ${label}`;
            downloadRow.subtitle = 'Starting';
            progress.fraction = 0;
            downloadRow.visible = true;

            let proc;
            try {
                proc = modelsTool(['download', name],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            } catch (e) {
                downloadRow.title = `Download failed: ${e.message}`;
                syncFromSettings();
                return;
            }
            const job = {proc, name};
            this._download = job;
            const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
            let total = 0;
            let error = '';
            const readLine = () => stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
                if (this._download !== job)
                    return;     // cancelled or replaced
                let line = null;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch {}
                if (line === null) {    // process finished
                    this._download = null;
                    if (error || !this._doneSeen) {
                        downloadRow.title = `Download of ${label} failed`;
                        downloadRow.subtitle = error || 'The download stopped unexpectedly';
                        syncFromSettings();
                        refreshStatus();
                        return;
                    }
                    downloadRow.visible = false;
                    this._downloaded?.add(name);
                    settings.set_string('model', name);
                    refreshStatus();
                    return;
                }
                const [key, ...rest] = line.split(' ');
                if (key === 'total') {
                    total = Number(rest[0]);
                } else if (key === 'progress' && total > 0) {
                    const done = Number(rest[0]);
                    progress.fraction = done / total;
                    downloadRow.subtitle = `${GLib.format_size(done)} of ${GLib.format_size(total)}`;
                } else if (key === 'done') {
                    this._doneSeen = true;
                } else if (key === 'error') {
                    error = rest.join(' ');
                }
                readLine();
            });
            this._doneSeen = false;
            readLine();
        };

        cancel.connect('clicked', () => {
            stopDownload();
            syncFromSettings();
            refreshStatus();
        });

        model.connect('notify::selected', () => {
            if (syncing)
                return;
            const [id] = MODELS[model.selected];
            showSelection(model.selected);
            if (id === settings.get_string('model')) {
                stopDownload();
                return;
            }
            // Switch only once the model is on disk, so dictation never points at a missing one
            if (this._downloaded?.has(id)) {
                stopDownload();
                settings.set_string('model', id);
            } else {
                startDownload(id);
            }
        });
        settings.connect('changed::model', () => {
            syncFromSettings();
            refreshStatus();    // the model in use changed: update which one can be deleted
        });
        syncFromSettings();

        refreshStatus();    // which models are on disk

        window.connect('close-request', () => {
            stopDownload();     // a half-finished download is resumed next time
            return false;
        });
        window.add(page);
    }
}

// Hibernate (X12): add "Hibernate" to the Quick Settings Power Off menu, below Suspend.
// GNOME Shell 51 has no hibernate entry of its own; this calls logind's Hibernate directly.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LOGIND = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'];

function logind(method, params, callback) {
    Gio.DBus.system.call(...LOGIND, method, params, null,
        Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
            try {
                callback(conn.call_finish(res), null);
            } catch (e) {
                callback(null, e);
            }
        });
}

export default class HibernateX12Extension extends Extension {
    enable() {
        this._item = null;
        this._menu = null;
        this._waitId = 0;
        this._attach();
    }

    disable() {
        if (this._waitId) {
            GLib.source_remove(this._waitId);
            this._waitId = 0;
        }
        this._menu?.disconnectObject(this);
        this._menu = null;
        this._item?.destroy();
        this._item = null;
    }

    _attach() {
        // The panel adds the system indicator asynchronously at startup
        const system = Main.panel.statusArea.quickSettings?._system;
        if (!system) {
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._waitId = 0;
                this._attach();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        this._menu = system._systemItem.menu;
        this._item = new PopupMenu.PopupMenuItem('Hibernate');
        this._item.connect('activate', () => {
            Main.panel.closeQuickSettings();
            logind('Hibernate', new GLib.Variant('(b)', [true]), (_r, err) => {
                if (err)
                    Main.notifyError('Hibernate failed', err.message);
            });
        });
        this._menu.addMenuItem(this._item, 1); // after Suspend
        this._menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._sync();
        }, this);
        this._sync();
    }

    _sync() {
        logind('CanHibernate', null, (result, err) => {
            if (!this._item)
                return;
            const answer = err ? 'no' : result.deepUnpack()[0];
            this._item.visible = answer === 'yes' || answer === 'challenge';
        });
    }
}

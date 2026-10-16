// Touch Haptics: feedback for touch actions on GNOME Shell UI and the on-screen keyboard.
//
// Each finger is tracked by its touch sequence:
//   OSK key        -> KEY feedback at touch-down (typing must feel immediate)
//   tap            -> TAP feedback early, once the finger has stayed within TAP_STILL_PX
//                     for TAP_CONFIRM_MS (a resting finger barely moves). If it crept
//                     further but stayed within TAP_SLOP_PX, the click waits for lift-off.
//                     A lift before TAP_CONFIRM_MS clicks at once.
//   long press     -> LONG feedback when the finger has been held still for LONG_PRESS_MS
//   drag, scroll, swipe, pinch -> nothing: moving past TAP_SLOP_PX before the tap is
//                     confirmed, a cancelled sequence (a Shell gesture took it over) or a
//                     second finger drops the pending tap
// Pen and mouse only give KEY feedback on the OSK.
// Timings follow Android's ViewConfiguration (8 dp touch slop, 400 ms long press).
//
// OUTPUT selects where the feedback goes:
//   'sound'     -> play the WAV files in this folder (stand-in until the motor is fitted)
//   'feedbackd' -> send events to feedbackd, which drives the vibration motor
//   'both'      -> do both
// To change a sound, replace click.wav or buzz.wav in this folder (WAV or OGG).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUTPUT = 'sound';

// 'osk'   -> only on-screen keyboard presses
// 'shell' -> OSK presses plus taps and long presses on GNOME Shell's own UI
const MODE = 'shell';

// Sound file and feedbackd event per action. feedbackd has no long-press event;
// bell-terminal is a 100 ms rumble in its default theme, longer than a tap.
const FEEDBACK = {
    key:  {sound: 'click.wav', event: 'key-pressed'},
    tap:  {sound: 'click.wav', event: 'button-pressed'},
    long: {sound: 'buzz.wav',  event: 'bell-terminal'},
};

const TAP_SLOP_PX = 10;          // movement (logical px) that turns a touch into a drag
const TAP_STILL_PX = 3;          // movement allowed for the early (pre-lift) tap click
const TAP_CONFIRM_MS = 60;       // still this long -> it is a tap (or a long press starting)
const LONG_PRESS_MS = 400;
const MIN_GAP_US = 40 * 1000;    // drop feedback closer than 40 ms apart
// A touch whose end we never saw (a menu grabbed the sequence mid-touch) would otherwise
// count as a held finger and make every later touch look like a pinch.
const STALE_US = 2 * 1000 * 1000;
const APP_ID = 'org.gnome.Shell';
const DEBUG = false;             // log one line per touch: journalctl --user -g touch-haptics

export default class TouchHapticsExtension extends Extension {
    enable() {
        this._last = 0;
        this._lastKey = '';
        this._warned = false;
        this._touches = new Map();      // slot -> per-finger state, see _touchBegin
        this._files = {};
        for (const [kind, f] of Object.entries(FEEDBACK))
            this._files[kind] = Gio.File.new_for_path(GLib.build_filenamev([this.path, f.sound]));

        this._handlerId = global.stage.connect('captured-event',
            (_stage, event) => this._onEvent(event));

        // While a menu or other modal holds a grab, touches go only to the grab actor and
        // the stage's captured-event never fires. Every Shell grab goes through
        // global.stage.grab(), so wrap it and listen on each grab actor too.
        this._grabActors = new Map();   // actor -> [captured-event id, destroy id]
        const ext = this;
        global.stage.grab = function (actor) {
            const grab = Clutter.Stage.prototype.grab.call(this, actor);
            ext._watchGrabActor(actor);
            return grab;
        };
    }

    disable() {
        global.stage.disconnect(this._handlerId);
        delete global.stage.grab;       // back to Clutter.Stage.prototype.grab
        for (const [actor, ids] of this._grabActors)
            ids.forEach(id => actor.disconnect(id));
        for (const t of this._touches.values())
            this._stopTimers(t);
        this._grabActors = null;
        this._touches = null;
        this._files = null;
    }

    _watchGrabActor(actor) {
        if (!actor || actor === global.stage || this._grabActors.has(actor))
            return;
        const eventId = actor.connect('captured-event', (_actor, event) => this._onEvent(event));
        const destroyId = actor.connect('destroy', () => this._grabActors.delete(actor));
        this._grabActors.set(actor, [eventId, destroyId]);
    }

    _onEvent(event) {
        // Outside a grab the same event reaches both the stage and a watched actor; handle it once
        const type = event.type();
        const key = `${type}:${this._slot(event)}:${event.get_time_us()}`;
        if (key === this._lastKey)
            return Clutter.EVENT_PROPAGATE;
        this._lastKey = key;

        switch (type) {
        case Clutter.EventType.TOUCH_BEGIN:
            this._touchBegin(event);
            break;
        case Clutter.EventType.TOUCH_UPDATE:
            this._touchUpdate(event);
            break;
        case Clutter.EventType.TOUCH_END:
            this._touchEnd(event, false);
            break;
        case Clutter.EventType.TOUCH_CANCEL:
            this._touchEnd(event, true);
            break;
        case Clutter.EventType.BUTTON_PRESS:
            // Pen tip and mouse on the OSK; skip presses emulated from touch
            if (!(event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) &&
                this._isOnOsk(event))
                this._trigger('key');
            break;
        }
        // Never consume the event; we only observe it.
        return Clutter.EVENT_PROPAGATE;
    }

    _isOnOsk(event) {
        const actor = global.stage.get_event_actor(event);
        const keyboardBox = Main.layoutManager.keyboardBox;
        return !!(actor && keyboardBox && keyboardBox.contains(actor));
    }

    _slot(event) {
        return event.get_event_sequence()?.get_slot() ?? -1;
    }

    _touchBegin(event) {
        const [x, y] = event.get_coords();
        const onOsk = this._isOnOsk(event);
        const slot = this._slot(event);
        const now = GLib.get_monotonic_time();

        for (const [s, other] of this._touches) {
            if (s === slot || now - other.lastEvent > STALE_US) {
                this._stopTimers(other);
                this._touches.delete(s);
            }
        }
        // A second finger means a multi-finger gesture: no taps for any of them
        const multi = this._touches.size > 0;
        for (const other of this._touches.values())
            this._cancel(other);

        const t = {x, y, onOsk, cancelled: multi, tapped: false, longFired: false,
            tapId: 0, longId: 0, maxDist: 0, start: now, lastEvent: now,
            result: multi ? 'multi-finger' : ''};
        this._touches.set(slot, t);

        if (onOsk)
            this._trigger('key');
        if (t.cancelled || !(onOsk || MODE === 'shell'))
            return;
        if (!onOsk) {
            t.tapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TAP_CONFIRM_MS, () => {
                t.tapId = 0;
                if (t.maxDist <= TAP_STILL_PX)
                    this._tap(t, 'early');
                return GLib.SOURCE_REMOVE;
            });
        }
        t.longId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            t.longId = 0;
            if (!t.cancelled) {
                t.longFired = true;
                this._trigger('long');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _touchUpdate(event) {
        const t = this._touches.get(this._slot(event));
        if (!t)
            return;
        t.lastEvent = GLib.get_monotonic_time();
        if (t.cancelled)
            return;
        const [x, y] = event.get_coords();
        const dist = Math.hypot(x - t.x, y - t.y);
        t.maxDist = Math.max(t.maxDist, dist);
        if (dist > TAP_SLOP_PX) {
            t.result ||= 'drag';
            this._cancel(t);
        }
    }

    _touchEnd(event, cancelled) {
        const slot = this._slot(event);
        const t = this._touches.get(slot);
        if (!t)
            return;
        this._touches.delete(slot);
        this._stopTimers(t);
        if (cancelled)
            t.result ||= 'cancelled';
        else
            this._tap(t, 'on lift');    // lifted early, or crept past TAP_STILL_PX

        if (DEBUG) {
            const ms = Math.round((GLib.get_monotonic_time() - t.start) / 1000);
            console.log(`touch-haptics: ${ms} ms, moved ${t.maxDist.toFixed(1)} px, ` +
                `${t.onOsk ? 'osk' : 'shell'}: ${t.result || 'silent'}${t.longFired ? ' + long' : ''}`);
        }
    }

    _tap(t, when) {
        if (t.cancelled || t.tapped || t.onOsk || MODE !== 'shell')
            return;
        t.tapped = true;
        t.result = `tap ${when}`;
        this._trigger('tap');
    }

    _cancel(t) {
        t.cancelled = true;
        this._stopTimers(t);
    }

    _stopTimers(t) {
        for (const id of ['tapId', 'longId']) {
            if (t[id]) {
                GLib.source_remove(t[id]);
                t[id] = 0;
            }
        }
    }

    _trigger(kind) {
        const now = GLib.get_monotonic_time();
        if (now - this._last < MIN_GAP_US)
            return;
        this._last = now;

        if (OUTPUT === 'sound' || OUTPUT === 'both')
            this._playSound(kind);
        if (OUTPUT === 'feedbackd' || OUTPUT === 'both')
            this._sendFeedback(FEEDBACK[kind].event);
    }

    _playSound(kind) {
        try {
            global.display.get_sound_player().play_from_file(
                this._files[kind], 'Touch haptics', null);
        } catch (e) {
            this._warnOnce(`sound playback failed: ${e.message}`);
        }
    }

    _sendFeedback(name) {
        Gio.DBus.session.call(
            'org.sigxcpu.Feedback',
            '/org/sigxcpu/Feedback',
            'org.sigxcpu.Feedback',
            'TriggerFeedback',
            new GLib.Variant('(ssa{sv}i)', [APP_ID, name, {}, -1]),
            null,
            Gio.DBusCallFlags.NONE,
            1000,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    this._warnOnce(`feedbackd call failed: ${e.message}`);
                }
            });
    }

    _warnOnce(msg) {
        if (!this._warned) {
            console.warn(`touch-haptics: ${msg}`);
            this._warned = true;
        }
    }
}

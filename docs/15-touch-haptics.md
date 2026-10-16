## 15. Touch feedback (fake haptics)

The X12 has no vibration motor, so touching the screen gives no feedback at all.
`home/.local/share/gnome-shell/extensions/touch-haptics-x12@monzon/` ("Touch Haptics (X12)") plays short sounds for touch actions on GNOME Shell's own UI and the on-screen keyboard.
It can also drive a vibration motor through feedbackd once one is fitted (`OUTPUT` at the top of `extension.js`).

### What it does

| Action | Feedback |
|---|---|
| Tap | `click.wav`, once the finger has stayed within 3 px for 60 ms, or at lift-off if that comes sooner |
| Long press (400 ms) | `buzz.wav` while the finger is still down; no click on release |
| Drag, scroll, swipe | nothing: moving more than 10 px before the tap is confirmed cancels it |
| Two fingers (pinch) | nothing |
| A gesture the Shell takes over (swipe to the overview) | nothing |
| On-screen keyboard key | `click.wav` at key-down |
| Pen or mouse on the on-screen keyboard | `click.wav` |

Touches inside app windows go straight to the app, so the extension never sees them.

The timings follow Android's `ViewConfiguration`: 8 dp touch slop (10 px here) and 400 ms long press.
Android itself never vibrates on an ordinary tap; it plays a click sound on release and vibrates only on long press and keyboard keys.
A click at touch-down made every scroll click, and a click on release felt late, so the tap is confirmed after 60 ms of a still finger instead.
That is close to Android's 100 ms "is this a scroll?" delay before showing a pressed state.

### Install

```
cp -r home/.local/share/gnome-shell/extensions/touch-haptics-x12@monzon ~/.local/share/gnome-shell/extensions/
gnome-extensions enable touch-haptics-x12@monzon    # or add it to org.gnome.shell enabled-extensions
```

Log out and in once; GNOME Shell only loads new or changed extension code at login.
Replacing `click.wav` or `buzz.wav` works without logging out.

### How it works

- It listens to `captured-event` on the stage and tracks each finger by its touch sequence slot.
- Shell menus and other popups take an input grab (`global.stage.grab()`, used by `Main.pushModal`).
  During a grab, touches go only to the grab actor and the stage never sees them, so taps on an open menu stayed silent.
  The extension wraps `global.stage.grab()` and listens on every grab actor as well; an event that reaches both is handled once.
- A grab that starts in the middle of a touch (a long press opening a menu) swallows that finger's end event.
  A touch on the same slot, or one with no events for 2 s, replaces the stale one; otherwise every later touch looked like a second finger.
- `DEBUG = true` logs one line per touch (duration, movement, result): `journalctl --user -g touch-haptics`.

### The sounds

- `click.wav`: 39 ms, a few cycles of about 200 Hz with a sharp start.
- `buzz.wav`: 100 ms smooth 180 Hz hum with two overtones, set to the same loudness as the click through a small-speaker model.
- Both start and end exactly on zero, with raised-cosine fades and no DC offset; anything else pops on the speakers.
  Peaks are 50 to 57 %, because the EasyEffects speaker preset (section 10) adds gain.

### Works well with TouchUp

[TouchUp](https://github.com/mityax/gnome-extension-touchup) (`touchup@mityax`, GNOME 49 to 51) is a very useful touch extension on the X12 in tablet mode.
It adds an Android-style navigation bar, swipe gestures for notifications, the panel, the overview and the desktop, key popups and extra keys for the on-screen keyboard, a floating rotate button when auto-rotation is off, and double tap to lock.
It runs alongside Touch Haptics (X12) without conflicts; TouchUp's own gestures stay silent because they move past the tap threshold.
Install it from [extensions.gnome.org](https://extensions.gnome.org/) or the GitHub page.

### Testing sounds

- `pw-play` loses very short files: it can finish before PipeWire has linked the stream.
  Use `paplay` or `canberra-gtk-play`, which play the way GNOME Shell does.
- Recording the speaker sink's monitor keeps the whole audio path awake, so it cannot show idle wake-up effects.

---

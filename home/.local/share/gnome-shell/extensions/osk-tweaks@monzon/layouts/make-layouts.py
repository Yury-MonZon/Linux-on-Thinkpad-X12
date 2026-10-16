#!/usr/bin/env python3
"""Generate the on-screen keyboard layouts for OSK Tweaks.

For each style ("laptop", "android") writes <style>/us.json and <style>/ru.json in GNOME Shell's
OSK layout format and compiles them into <style>-layouts.gresource under
/org/gnome/shell/osk-layouts/, the same path as GNOME's own layouts. The extension registers
the bundle for the chosen style, and it then takes precedence over GNOME's files.
Long-press variants of each character are copied from GNOME's stock layout.

Besides <group>.json, GNOME loads other files for some text fields, by the field's input purpose:
<group>-extended.json in terminals, url.json, email.json, digits.json, number.json and phone.json.
The extension maps web address and email fields to <group>+url.json and <group>+email.json, so
they keep the current language, or to the normal layout if that kind is switched off.

Two additions to GNOME's format, which the extension places itself (extension.js, KeyLayout):
widths and offsets can be any fraction of a key, not only halves, and a key can have "top", a
downward shift in rows, so short keys ("height" below 1) can be stacked in one column.
Run again after editing: python3 make-layouts.py
"""
import copy
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
STOCK = '/usr/share/gnome-shell/gnome-shell-osk-layouts.gresource'

# Special keys, in GNOME's layout format
DELETE = {'action': 'delete', 'iconName': 'osk-delete-symbolic'}
ENTER = {'iconName': 'osk-enter-symbolic', 'keyval': '0xff0d'}
EMOJI = {'action': 'emoji', 'iconName': 'osk-emoji-picker-symbolic'}
LANG = {'action': 'languageMenu', 'iconName': 'osk-layout-symbolic'}
HIDE = {'action': 'hide', 'iconName': 'osk-hide-symbolic'}
SPACE = {'strings': [' ']}


def w(key, width):
    return dict(key, width=round(width, 4))


def level_switch(to, icon=None, label=None):
    key = {'action': 'levelSwitch', 'level': to}
    if icon:
        key['iconName'] = icon
    if label:
        key['label'] = label
    return key


def stock_variants(group):
    """GNOME's own layout and {char: [char, variants...]} from it, for long-press popups."""
    data = subprocess.run(['gresource', 'extract', STOCK, f'/org/gnome/shell/osk-layouts/{group}.json'],
                          capture_output=True, check=True).stdout
    model = json.loads(data)
    found = {}
    for level in model['levels']:
        for row in level['rows']:
            for key in row:
                s = key.get('strings')
                if s and len(s) > 1 and s[0] not in found:
                    found[s[0]] = s
    return model, found


def keys(chars, variants, extra=None):
    """One key per character, with stock long-press variants; extra: {index: [more variants]}."""
    out = []
    for i, c in enumerate(chars):
        strings = list(variants.get(c, [c]))
        for v in (extra or {}).get(i, []):
            if v not in strings:
                strings.insert(1, v)
        out.append({'strings': strings})
    return out


# --- Laptop: staggered 15-unit rows, like a real keyboard -------------------------------

LAPTOP_CHARS = {
    'us': [('`1234567890-=', '~!@#$%^&*()_+'), ('qwertyuiop[]', 'QWERTYUIOP{}'),
           ('asdfghjkl;\'', 'ASDFGHJKL:"'), ('zxcvbnm,./', 'ZXCVBNM<>?')],
    'ru': [('ё1234567890-=', 'Ё!"№;%:?*()_+'), ('йцукенгшщзхъ', 'ЙЦУКЕНГШЩЗХЪ'),
           ('фывапролджэ', 'ФЫВАПРОЛДЖЭ'), ('ячсмитьбю.', 'ЯЧСМИТЬБЮ,')],
}
LAPTOP_BACKSLASH = {'us': ('\\', '|'), 'ru': ('\\', '/')}


def laptop(group, variants):
    def rows(i):
        other = 'default' if i else 'shift'
        shift = level_switch(other, icon='osk-shift-symbolic')
        caps = level_switch(other, icon='osk-caps-lock-symbolic')
        c = [r[i] for r in LAPTOP_CHARS[group]]
        # The letter rows start at 1, 1.5 and 2: each half a key further right, as on a laptop.
        return [
            keys(c[0], variants) + [w(DELETE, 2)],                                     # 13 + 2
            [{'keyval': '0xff09', 'label': 'Tab'}] + keys(c[1], variants)
            + [{'strings': [LAPTOP_BACKSLASH[group][i]], 'width': 2}],                 # 1 + 12 + 2
            [w(caps, 1.5)] + keys(c[2], variants) + [w(ENTER, 2.5)],                   # 1.5 + 11 + 2.5
            [w(shift, 2)] + keys(c[3], variants)
            + [{'iconName': 'go-up-symbolic', 'keyval': '0xff52'}, w(shift, 2)],       # 2 + 10 + 1 + 2
            # Left starts at 11 so Down sits under Up (12..13); the dictation key, after the
            # language key, takes 1 unit from Space
            [{'action': 'modifier', 'keyval': '0xffe3', 'label': 'Ctrl', 'width': 1.5},
             {'action': 'modifier', 'keyval': '0xffe9', 'label': 'Alt'},
             {'keyval': '0xff1b', 'label': 'Esc'}, EMOJI, w(SPACE, 5.5), LANG,
             {'iconName': 'go-previous-symbolic', 'keyval': '0xff51'},
             {'iconName': 'go-down-symbolic', 'keyval': '0xff54'},
             {'iconName': 'go-next-symbolic', 'keyval': '0xff53'}, HIDE],
        ]
    return 15, [
        {'level': 'default', 'mode': 'default', 'rows': rows(0)},
        {'level': 'shift', 'mode': 'latched', 'rows': rows(1)},
    ]


# --- Android: an Android-like layout, measured on screenshots of a phone keyboard ---------
# Every page is 10 keys wide. Russian fits 11 letters in the same width, and its bottom letter
# row has wider Shift and Backspace keys with narrower letters between them.

ANDROID_WIDTH = 10
ANDROID_LETTERS = {
    'us': ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
    'ru': ['йцукенгшщзх', 'фывапролджэ', 'ячсмитьбю'],
}
ANDROID_SHIFT = {'us': 1.5, 'ru': 1.125}      # Shift and Backspace on the bottom letter row
ANDROID_EXTRA = {'ru': {'ь': 'ъ', 'Ь': 'Ъ', 'е': 'ё', 'Е': 'Ё'}}   # long-press letters, as on Android
ANDROID_ABC = {'us': 'ABC', 'ru': 'АБВ'}
# The symbol pages (?123 and =\<), as Android shows them for each language
SYMBOLS1 = {'us': ['1234567890', '@#$_&-+()/', '*"\':;!?'],
            'ru': ['1234567890', '@#₽_&-+()/', '*"\':;!?']}
SYMBOLS2 = {'us': ['~`|•√π÷×§∆', '£¢€¥^°={}\\', '%©®™✓[]'],
            'ru': ['~`|•√π÷×§∆', '£€$¢^°={}\\', '%©®™✓[]']}
# Android-style long-press extras on symbols and digits;
# cross-checked with AOSP LatinIME's rowkeys_symbols*.xml
SYMBOL_VARIANTS = {
    '$': '$¢£€¥₽', '₽': '₽$€£¥', '?': '?¿‽', '!': '!¡', '"': '"“”„«»', "'": "'‘’‚‹›",
    '(': '(<[{', ')': ')>]}', '/': '/\\', '*': '*★†‡', '%': '%‰', '+': '+±', '=': '=≠≈∞',
    '#': '#№', '1': '1¹½⅓¼⅛', '2': '2²⅔', '3': '3³¾⅜', '4': '4⁴', '5': '5⅝', '7': '7⅞', '0': '0ⁿ∅',
    '.': '.,?!\'"@#%&*-:;/', ',': ',;:',
    # from AOSP LatinIME's symbol pages (Android's open-source keyboard)
    '^': '^↑↓←→', '°': '°′″', 'π': 'πΠ', '§': '§¶', '-': '-_\u2013\u2014·',   # en and em dash
}
# Comma on the letter pages: types a comma, tap and hold opens the emoji picker, as Android does
# when its language key takes the emoji key's place (the extension handles the action)
COMMA_EMOJI = {'action': 'commaEmoji', 'label': ','}


def sym(c):
    return {'strings': list(SYMBOL_VARIANTS.get(c, c))}


def android(group, variants):
    width = ANDROID_WIDTH
    letters = ANDROID_LETTERS[group]
    unit = width / len(letters[0])      # 1 for English, 10/11 for Russian
    abc = level_switch('default', label=ANDROID_ABC[group])
    numbers = level_switch('numpad', label='12\n34')
    digits = {i: [str((i + 1) % 10)] for i in range(10)}

    def letter_rows(upper):
        top, mid, bottom = (r.upper() if upper else r for r in letters)
        extra = ANDROID_EXTRA.get(group, {})

        def row(chars, size, more=None):
            ks = keys(chars, variants, more)
            for k in ks:
                if k['strings'][0] in extra and extra[k['strings'][0]] not in k['strings']:
                    k['strings'].insert(1, extra[k['strings'][0]])
                if size != 1:
                    k['width'] = round(size, 4)
            return ks
        shift = level_switch('default' if upper else 'shift', icon='osk-shift-symbolic')
        side = ANDROID_SHIFT[group]
        mid_keys = row(mid, unit)
        offset = (width - len(mid) * unit) / 2      # English: half a key on each side
        if offset:
            mid_keys[0]['leftOffset'] = offset
        return [
            row(top, unit, digits),
            mid_keys,
            [w(shift, side)] + row(bottom, (width - 2 * side) / len(bottom)) + [w(DELETE, side)],
        ]

    # Bottom rows: 1.5 + 1 + 1 + 4 + 1 + 1.5. On the letter pages the dictation key goes right
    # after Space and takes 1 from it. Android has no hide key; GNOME's keyboard also closes
    # when the text field loses focus.
    letters_bottom = [w(level_switch('opt', label='?123'), 1.5), COMMA_EMOJI, LANG,
                      w(SPACE, 4), sym('.'), w(ENTER, 1.5)]

    def symbol_rows(chars, page_label, page_to, around_space):
        top, mid, bottom = chars
        return [
            [sym(c) for c in top],
            [sym(c) for c in mid],
            [w(level_switch(page_to, label=page_label), 1.5)] + [sym(c) for c in bottom]
            + [w(DELETE, 1.5)],
            [w(abc, 1.5), sym(around_space[0]), numbers, w(SPACE, 4), sym(around_space[1]), w(ENTER, 1.5)],
        ]

    def numpad_rows():
        # The number pad (12/34 on the symbol pages): + - * / stacked in one column on the
        # left, three columns of digits, % Space Backspace on the right; !?# and = flank the 0
        side = 1.5
        digit = (width - 2 * side) / 3

        def stacked(c, i):
            key = dict(sym(c), width=side, height=0.75)
            if i:
                key.update(leftOffset=-side, top=0.75 * i)
            return key
        dig = lambda c: w(sym(c), digit)
        row2 = [dig(c) for c in '456']
        row3 = [dig(c) for c in '789']
        row2[0]['leftOffset'] = row3[0]['leftOffset'] = side
        flank = 1.5 + digit - 2.5           # from the comma to the middle digit column
        return [
            [stacked(c, i) for i, c in enumerate('+-*/')] + [dig(c) for c in '123'] + [w(sym('%'), side)],
            row2 + [{'strings': [' '], 'label': '␣', 'width': side}],
            row3 + [w(DELETE, side)],
            [w(abc, 1.5), sym(','), w(level_switch('opt', label='!?#'), flank), w(sym('0'), digit),
             w(sym('='), flank), sym('.'), w(ENTER, 1.5)],
        ]

    return width, [
        {'level': 'default', 'mode': 'default', 'rows': letter_rows(False) + [letters_bottom]},
        {'level': 'shift', 'mode': 'latched', 'rows': letter_rows(True) + [letters_bottom]},
        {'level': 'opt', 'mode': 'locked',
         'rows': symbol_rows(SYMBOLS1[group], '=\\<', 'opt+shift', (',', '.'))},
        {'level': 'opt+shift', 'mode': 'locked',
         'rows': symbol_rows(SYMBOLS2[group], '?123', 'opt', ('<', '>'))},
        {'level': 'numpad', 'mode': 'locked', 'rows': numpad_rows()},
    ]


# --- Layouts for special text fields ------------------------------------------------------

# Terminals: a Termux-style row of extra keys on top of every page
TERMINAL_ROW = [
    {'keyval': '0xff1b', 'label': 'Esc'}, {'keyval': '0xff09', 'label': 'Tab'},
    {'action': 'modifier', 'keyval': '0xffe3', 'label': 'Ctrl'},
    {'action': 'modifier', 'keyval': '0xffe9', 'label': 'Alt'},
    {'strings': ['/']}, {'strings': ['-']},
    {'iconName': 'go-previous-symbolic', 'keyval': '0xff51'},
    {'iconName': 'go-down-symbolic', 'keyval': '0xff54'},
    {'iconName': 'go-up-symbolic', 'keyval': '0xff52'},
    {'iconName': 'go-next-symbolic', 'keyval': '0xff53'},
]
# Web addresses and email: the comma next to Space becomes / or @, and the period offers domains
DOMAINS = {'us': ['.', '.com', '.org', '.net', '.ru'], 'ru': ['.', '.ru', '.com', '.org', '.net', '.рф']}


def with_terminal_row(levels):
    out = copy.deepcopy(levels)
    for lv in out:
        lv['rows'].insert(0, copy.deepcopy(TERMINAL_ROW))
    return out


def with_field_keys(levels, group, key):
    """Letter pages with `key` in place of the comma and domain endings on the period."""
    out = [copy.deepcopy(lv) for lv in levels]     # the letter pages share one bottom row
    for lv in out:
        if lv['level'] in ('default', 'shift'):
            bottom = lv['rows'][-1]
            i = next(i for i, k in enumerate(bottom) if k.get('action') == 'commaEmoji')
            bottom[i] = {'strings': [key]}
            period = next(k for k in bottom if (k.get('strings') or [''])[0] == '.')
            period['strings'] = list(DOMAINS[group])
    return out


def number_pad(last_row):
    """Android-like pad for number fields: 1 2 3 -, 4 5 6 Space, 7 8 9 Backspace, then last_row;
    four equal columns, no letters, and no fractions or symbols on long-press."""
    col = ANDROID_WIDTH / 4
    sym = lambda c: {'strings': [c]}
    pad = lambda keys: [w(k, col) for k in keys]
    return [{'level': 'default', 'mode': 'default', 'rows': [
        pad([sym('1'), sym('2'), sym('3'), sym('-')]),
        pad([sym('4'), sym('5'), sym('6'), {'strings': [' '], 'label': '␣'}]),
        pad([sym('7'), sym('8'), sym('9'), DELETE]),
        pad(last_row),
    ]}]


def number_pads():
    return ANDROID_WIDTH, {
        'number': number_pad([{'strings': [',']}, {'strings': ['0']}, {'strings': ['.']}, ENTER]),
        'digits': number_pad([{'strings': [',']}, {'strings': ['0']}, {'strings': ['.']}, ENTER]),
        'phone': number_pad([{'strings': ['*', '#']}, {'strings': ['0', '+']}, {'strings': ['#', '*']}, ENTER]),
    }


def android_files(group, variants):
    width, levels = android(group, variants)
    return width, {
        group: levels,
        f'{group}-extended': with_terminal_row(levels),
        f'{group}+url': with_field_keys(levels, group, '/'),
        f'{group}+email': with_field_keys(levels, group, '@'),
    }


def laptop_files(group, variants):
    # the laptop layout already has Tab, Ctrl, Alt, Esc, arrows, / and @
    width, levels = laptop(group, variants)
    return width, {name: levels for name in (group, f'{group}-extended', f'{group}+url', f'{group}+email')}


def row_extent(row):
    """Where the row ends, in keys; stacked keys step back with a negative offset."""
    return sum(k.get('width', 1) + k.get('leftOffset', 0) for k in row)


def main():
    for style, build in (('laptop', laptop_files), ('android', android_files)):
        out_dir = os.path.join(HERE, style)
        os.makedirs(out_dir, exist_ok=True)
        files = []
        models = []     # (name, width, levels, stock model for locale and name)
        for group in ('us', 'ru'):
            stock, variants = stock_variants(group)
            width, by_name = build(group, variants)
            models += [(name, width, levels, stock) for name, levels in by_name.items()]
        width, pads = number_pads()
        models += [(name, width, levels, {}) for name, levels in pads.items()]
        for name, width, levels, stock in models:
            for lv in levels:
                for r, row in enumerate(lv['rows']):
                    end = row_extent(row)
                    # a row that starts with an offset either fills the rest or is centred
                    assert any(abs(e - width) < 1e-3 for e in (end, end + row[0].get('leftOffset', 0))), \
                        f'{style} {name} {lv["level"]} row {r} ends at {end}, not {width}'
            with open(os.path.join(out_dir, f'{name}.json'), 'w', encoding='utf-8') as f:
                json.dump({'locale': stock.get('locale'), 'name': stock.get('name'), 'levels': levels},
                          f, ensure_ascii=False, indent=1)
            files.append(f'{name}.json')
        xml = os.path.join(out_dir, 'layouts.gresource.xml')
        with open(xml, 'w') as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gresources>\n'
                    '  <gresource prefix="/org/gnome/shell/osk-layouts">\n'
                    + ''.join(f'    <file>{name}</file>\n' for name in files)
                    + '  </gresource>\n</gresources>\n')
        target = os.path.join(HERE, f'{style}-layouts.gresource')
        subprocess.run(['glib-compile-resources', '--sourcedir', out_dir, '--target', target, xml], check=True)
        print(f'{style}: wrote {", ".join(files)} and {os.path.basename(target)}')


if __name__ == '__main__':
    main()

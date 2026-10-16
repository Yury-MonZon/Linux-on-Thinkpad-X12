"""Speech-to-text helper for the OSK Tweaks GNOME extension (dictation key).

Usage: dictate.py <model>
Started by the extension when the mic key is tapped; it loads the faster-whisper model in
the background (so loading overlaps with speaking) and stays until the extension stops it
after the configured idle time, which frees the model's RAM.

Commands on stdin, one per line:
    start <language|auto> <pause ms> <silence ms>
                                       record from the default microphone (PipeWire);
                                       silence ms > 0: stop by itself after that long without speech
    stop                               finish: transcribe what is left, then "end"
    cancel                             drop everything, then "end"
Replies on stdout, one per line:
    level <0..1>                       input level, about 20 per second, for the meter
    text <phrase>                      a transcribed phrase, as soon as it is ready
    autostop                           stopped by itself after the silence limit ("end" follows)
    end                                recording finished and all phrases are out
    error <message>

Recording is cut into phrases at pauses longer than <pause ms>. Each phrase is transcribed
while recording continues, with the text so far as context, so after "stop" only the last
phrase is left to transcribe.
Models are cached in ~/.local/share/osk-tweaks/hf (HF_HOME, set by the extension).
"""
import os
import queue
import shlex
import signal
import subprocess
import sys
import threading

import numpy as np
from faster_whisper import WhisperModel

RATE = 16000
BLOCK = 800                     # 50 ms of 16-bit mono samples per read
PRE_ROLL = 6                    # blocks kept before speech starts (300 ms)
MAX_PHRASE_S = 25               # force a cut before whisper's 30 s window
METER_FLOOR_DB = -60.0          # meter scale: -60 dBFS empty .. -10 dBFS full
METER_TOP_DB = -10.0

out_lock = threading.Lock()


def say(*parts):
    with out_lock:
        print(*parts, flush=True)


class Dictation:
    def __init__(self, model_name):
        self.model = None
        self.model_ready = threading.Event()
        threading.Thread(target=self._load, args=(model_name,), daemon=True).start()
        self.jobs = queue.Queue()       # (audio, language) or None (= recording finished)
        threading.Thread(target=self._worker, daemon=True).start()
        self.rec = None
        self.reader = None
        self.cancelled = False
        self.context = ''

    def _load(self, name):
        try:
            self.model = WhisperModel(name, device='cpu', compute_type='int8', cpu_threads=4)
        except Exception as e:
            say('error', f'cannot load model {name}: {e}'.replace('\n', ' '))
            sys.exit(1)
        self.model_ready.set()

    # Transcription runs here, in order, while recording continues
    def _worker(self):
        while True:
            job = self.jobs.get()
            if job is None:
                say('end')
                continue
            if self.cancelled:
                continue
            audio, lang = job
            self.model_ready.wait()
            try:
                segments, _ = self.model.transcribe(
                    audio,
                    language=None if lang == 'auto' else lang,
                    beam_size=5,
                    vad_filter=True,                    # drop noise-only stretches
                    initial_prompt=self.context[-200:] or None,
                )
                text = ' '.join(s.text.strip() for s in segments).strip()
            except Exception as e:
                say('error', str(e).replace('\n', ' '))
                text = ''
            if text and not self.cancelled:
                self.context += ' ' + text
                say('text', text.replace('\n', ' '))

    def start(self, lang, pause_ms, silence_ms):
        if self.rec and self.rec.poll() is None:
            return              # already recording
        self.cancelled = False
        self.context = ''
        cmd = ['pw-cat', '--record', '--raw', '--rate', str(RATE), '--channels', '1',
               '--format', 's16', '-']
        if os.environ.get('DICTATION_TEST_CMD'):    # tests: raw 16 kHz s16 audio from a command
            cmd = shlex.split(os.environ['DICTATION_TEST_CMD'])
        self.rec = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.reader = threading.Thread(target=self._record, args=(self.rec, lang, pause_ms, silence_ms),
                                       daemon=True)
        self.reader.start()

    def _record(self, rec, lang, pause_ms, silence_ms):
        pause_blocks = max(1, pause_ms // 50)
        silence_blocks = silence_ms // 50       # 0: never stop by itself
        since_speech = 0
        noise_db = -55.0            # adaptive noise floor
        phrase = []                 # blocks of the current phrase (with pre-roll)
        pre = []
        speaking = False
        quiet = 0
        while True:
            data = rec.stdout.read(BLOCK * 2)
            if not data:
                break               # pw-cat stopped (stop/cancel)
            block = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(block * block))) if block.size else 0.0
            db = 20 * np.log10(rms) if rms > 1e-6 else -120.0
            say('level', f'{min(1.0, max(0.0, (db - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB))):.2f}')

            threshold = max(noise_db + 12, -50.0)
            if db < noise_db + 6:   # follow the background level slowly
                noise_db = 0.95 * noise_db + 0.05 * db
            loud = db > threshold
            since_speech = 0 if loud else since_speech + 1
            if silence_blocks and since_speech == silence_blocks:
                say('autostop')
                rec.terminate()     # EOF follows: the last phrase and "end" are queued below

            if not speaking:
                pre = (pre + [block])[-PRE_ROLL:]
                if loud:
                    speaking, quiet, phrase = True, 0, pre[:]
                continue
            phrase.append(block)
            quiet = 0 if loud else quiet + 1
            if quiet >= pause_blocks or len(phrase) * BLOCK >= MAX_PHRASE_S * RATE:
                self.jobs.put((np.concatenate(phrase), lang))
                speaking, pre, phrase = False, [], []
        if speaking and phrase and not self.cancelled:
            self.jobs.put((np.concatenate(phrase), lang))
        self.jobs.put(None)         # -> "end" once everything before it is transcribed

    def stop(self, cancel=False):
        if not self.rec:
            say('end')
            return
        self.cancelled = cancel
        self.rec.terminate()        # the reader sees EOF, queues the last phrase and the end marker
        self.rec.wait()
        self.rec = None


def main():
    d = Dictation(sys.argv[1])

    def on_term(_signum, _frame):
        # The extension stops us with SIGTERM: never leave the recorder (and the mic) running
        if d.rec:
            d.rec.terminate()
        sys.exit(0)
    signal.signal(signal.SIGTERM, on_term)
    for line in sys.stdin:
        cmd, *args = line.split()
        if cmd == 'start' and len(args) == 3:
            d.start(args[0], int(args[1]), int(args[2]))
        elif cmd == 'stop':
            d.stop()
        elif cmd == 'cancel':
            d.stop(cancel=True)
    if d.rec:
        d.stop(cancel=True)


if __name__ == '__main__':
    main()

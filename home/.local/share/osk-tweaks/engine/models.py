"""Model management for the OSK Tweaks settings page (speech models).

    models.py status                     -> one line, space separated engine:name:bytes:state,
                                            state being "complete" or "partial" (an interrupted
                                            download)
    models.py delete <engine> <model>    -> "done" or "error <message>"; also removes partial
                                            downloads
    models.py download <engine> <model>  -> progress lines, then "done" or "error <message>":
                                                total <bytes>
                                                progress <bytes>
Engines: openvino (Intel iGPU) and faster-whisper (CPU); each has its own copy of
every model. Models go to HF_HOME (set by the caller), the same cache the speech helper reads
offline. Deleting an OpenVINO model also empties the OpenVINO compile cache (dictate.py
CACHE_DIR), which only holds compiled copies of models; it refills on the next load.
"""
import fnmatch
import os
import shutil
import sys
import threading
import time

from faster_whisper.utils import _MODELS
from huggingface_hub import HfApi, scan_cache_dir, snapshot_download

MODELS = ('base', 'small', 'medium', 'large-v3-turbo')
# The same as in dictate.py (run with python -I, which cannot import its neighbours)
OV_CACHE = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'),
                        'osk-tweaks', 'openvino')


def ov_repo(name):
    return f'OpenVINO/whisper-{name}-int8-ov'


ENGINES = {
    # engine: (model name -> Hugging Face repo, files to fetch, the file a complete download has)
    # OpenVINO: the whole repo, as dictate.py finds it with snapshot_download(), which offline
    # refuses a snapshot with any file missing
    'openvino': (ov_repo, ('*',), 'openvino_decoder_model.bin'),
    # the files faster_whisper.utils.download_model() fetches
    'faster-whisper': (_MODELS.get, ('config.json', 'preprocessor_config.json', 'model.bin',
                                     'tokenizer.json', 'vocabulary.*'), 'model.bin'),
}


def say(*parts):
    print(*parts, flush=True)


def repo_id(engine, name):
    return ENGINES[engine][0](name)


def repo_dir(engine, name):
    return os.path.join(os.environ['HF_HOME'], 'hub', 'models--' + repo_id(engine, name).replace('/', '--'))


def dir_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def downloaded():
    """{(engine, model name): (bytes on disk, 'complete' or 'partial')}"""
    try:
        repos = {r.repo_id: r for r in scan_cache_dir().repos}
    except Exception:
        repos = {}
    found = {}
    for engine, (_repo, _patterns, last) in ENGINES.items():
        for name in MODELS:
            repo = repos.get(repo_id(engine, name))
            if repo and any(f.file_name == last for rev in repo.revisions for f in rev.files):
                found[engine, name] = (repo.size_on_disk, 'complete')
            elif os.path.isdir(repo_dir(engine, name)):
                found[engine, name] = (dir_bytes(repo_dir(engine, name)), 'partial')
    return found


def delete(engine, name):
    try:
        info = scan_cache_dir()
        revs = [rev.commit_hash for r in info.repos if r.repo_id == repo_id(engine, name) for rev in r.revisions]
        if revs:
            info.delete_revisions(*revs).execute()
        # Whatever is left in the model's folder: partial (.incomplete) downloads, refs
        if os.path.isdir(repo_dir(engine, name)):
            shutil.rmtree(repo_dir(engine, name))
        if engine == 'openvino' and os.path.isdir(OV_CACHE):
            shutil.rmtree(OV_CACHE)
    except Exception as e:
        say('error', str(e).replace('\n', ' '))
        sys.exit(1)
    say('done')


def cache_bytes():
    """Bytes under HF_HOME, including partial (.incomplete) downloads."""
    total = 0
    for root, _dirs, files in os.walk(os.environ['HF_HOME']):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def download(engine, name):
    repo = repo_id(engine, name)
    patterns = ENGINES[engine][1]
    info = HfApi().model_info(repo, files_metadata=True)
    total = sum(s.size or 0 for s in info.siblings
                if any(fnmatch.fnmatch(s.rfilename, p) for p in patterns))
    say('total', total)

    start = cache_bytes()
    result = {}

    def run():
        try:
            snapshot_download(repo, allow_patterns=list(patterns))
        except Exception as e:      # reported below
            result['error'] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    while t.is_alive():
        say('progress', min(total, max(0, cache_bytes() - start)))
        t.join(0.5)
    if 'error' in result:
        say('error', str(result['error']).replace('\n', ' '))
        sys.exit(1)
    say('progress', total)
    say('done')


if __name__ == '__main__':
    args = sys.argv[1:]
    if args == ['status']:
        say(' '.join(f'{engine}:{name}:{size}:{state}'
                     for (engine, name), (size, state) in downloaded().items()))
    elif len(args) == 3 and args[0] in ('delete', 'download') and args[1] in ENGINES and args[2] in MODELS:
        (delete if args[0] == 'delete' else download)(args[1], args[2])
    else:
        sys.exit(__doc__)

"""Model management for the OSK Tweaks settings page (speech models).

    models.py status            -> one line, space separated name:bytes:state, state being
                                   "complete" or "partial" (an interrupted download)
    models.py delete <model>    -> "done" or "error <message>"; also removes partial downloads
    models.py download <model>  -> progress lines, then "done" or "error <message>":
                                       total <bytes>
                                       progress <bytes>
Models go to HF_HOME (set by the caller), the same cache the speech helper reads offline.
"""
import fnmatch
import os
import shutil
import sys
import threading
import time

from faster_whisper.utils import _MODELS, download_model
from huggingface_hub import HfApi, scan_cache_dir

MODELS = ('base', 'small', 'medium', 'large-v3-turbo')
# The files faster_whisper.utils.download_model() fetches
PATTERNS = ('config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*')


def say(*parts):
    print(*parts, flush=True)


def repo_dir(name):
    return os.path.join(os.environ['HF_HOME'], 'hub', 'models--' + _MODELS[name].replace('/', '--'))


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
    """{model name: (bytes on disk, 'complete' or 'partial')}"""
    try:
        repos = {r.repo_id: r for r in scan_cache_dir().repos}
    except Exception:
        repos = {}
    found = {}
    for name in MODELS:
        repo = repos.get(_MODELS[name])
        if repo and any(f.file_name == 'model.bin' for rev in repo.revisions for f in rev.files):
            found[name] = (repo.size_on_disk, 'complete')
        elif os.path.isdir(repo_dir(name)):
            found[name] = (dir_bytes(repo_dir(name)), 'partial')
    return found


def delete(name):
    try:
        info = scan_cache_dir()
        revs = [rev.commit_hash for r in info.repos if r.repo_id == _MODELS[name] for rev in r.revisions]
        if revs:
            info.delete_revisions(*revs).execute()
        # Whatever is left in the model's folder: partial (.incomplete) downloads, refs
        if os.path.isdir(repo_dir(name)):
            shutil.rmtree(repo_dir(name))
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


def download(name):
    repo = _MODELS[name]
    info = HfApi().model_info(repo, files_metadata=True)
    total = sum(s.size or 0 for s in info.siblings
                if any(fnmatch.fnmatch(s.rfilename, p) for p in PATTERNS))
    say('total', total)

    start = cache_bytes()
    result = {}

    def run():
        try:
            download_model(name)
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
    if sys.argv[1:2] == ['status']:
        say(' '.join(f'{name}:{size}:{state}' for name, (size, state) in downloaded().items()))
    elif sys.argv[1:2] == ['delete'] and len(sys.argv) == 3 and sys.argv[2] in MODELS:
        delete(sys.argv[2])
    elif sys.argv[1:2] == ['download'] and len(sys.argv) == 3 and sys.argv[2] in MODELS:
        download(sys.argv[2])
    else:
        sys.exit(__doc__)

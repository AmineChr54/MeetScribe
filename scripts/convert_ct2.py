#!/usr/bin/env python3
"""
Convert a Hugging Face Whisper checkpoint (Transformers format) to CTranslate2
so faster-whisper can load it.

Used by Settings > Models for fine-tunes that are published only as plain
Transformers weights (for example a Tunisian Arabic large-v3 fine-tune).

  python convert_ct2.py <hf-repo> <output-dir> [quantization]

The result is written to "<output-dir>.partial" and renamed on success, so an
interrupted run never leaves something that looks like a finished model.
Progress goes to stdout/stderr as plain lines; the model store only looks at
the exit code. This is not a live worker, so the JSON-lines rule does not apply.

The converter needs torch + transformers. They are installed into the venv on
first use (CPU torch is enough) and stay there for later conversions.
"""

import importlib.util
import os
import shutil
import subprocess
import sys

# Whisper large-v3 uses 128 mel bins; faster-whisper reads that from
# preprocessor_config.json, and the tokenizer from tokenizer.json.
COPY_FILES = ['tokenizer.json', 'preprocessor_config.json']
NEEDED = ['torch', 'transformers', 'safetensors', 'sentencepiece']


def say(message):
    print(message, flush=True)


def ensure_dependencies():
    missing = [name for name in NEEDED if importlib.util.find_spec(name) is None]
    if not missing:
        return
    say('Installing conversion tools: ' + ', '.join(missing) + ' (one time, a few hundred MB)...')
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check'] + missing)


def main():
    if len(sys.argv) < 3:
        say('usage: convert_ct2.py <hf-repo> <output-dir> [quantization]')
        return 2
    repo, output = sys.argv[1], os.path.abspath(sys.argv[2])
    quantization = sys.argv[3] if len(sys.argv) > 3 else 'float16'

    ensure_dependencies()
    from ctranslate2.converters import TransformersConverter

    partial = output + '.partial'
    shutil.rmtree(partial, ignore_errors=True)
    os.makedirs(os.path.dirname(output), exist_ok=True)

    say('Downloading and converting {} ({})...'.format(repo, quantization))
    TransformersConverter(repo, copy_files=COPY_FILES).convert(partial, quantization=quantization, force=True)

    if not os.path.isfile(os.path.join(partial, 'model.bin')):
        raise RuntimeError('conversion finished without a model.bin')
    shutil.rmtree(output, ignore_errors=True)
    os.replace(partial, output)
    say('Converted model ready: ' + output)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print('ERROR: {}'.format(exc), file=sys.stderr, flush=True)
        sys.exit(1)

#!/usr/bin/env python3
"""
Speaker-embedding worker (sherpa-onnx), used for "You / Other n" labels.

Newline-delimited JSON over stdin/stdout, same shape as whisper_worker.py:

  ->  {"id":1,"action":"load","model_path":"...","threads":1}
  <-  {"id":1,"ok":true,"dim":512,"load_s":1.9}

  ->  {"id":2,"action":"embed","audio_path":"...wav"}      16 kHz mono PCM16
  <-  {"id":2,"ok":true,"embedding":[...],"seconds":3.2,"elapsed_ms":80}

  ->  {"id":3,"action":"shutdown"}

On startup it emits {"event":"ready"}. Errors reply with
{"id":N,"ok":false,"error":"..."}.

stdout is the protocol channel and nothing else may be printed to it, so the
real stdout is kept aside and sys.stdout is pointed at stderr: any library that
prints would otherwise corrupt the stream.
"""

import json
import sys
import time
import traceback
import wave

PROTOCOL = sys.stdout
sys.stdout = sys.stderr

EXTRACTOR = None


def send(payload):
    PROTOCOL.write(json.dumps(payload) + '\n')
    PROTOCOL.flush()


def log(message):
    sys.stderr.write('[voice] {}\n'.format(message))
    sys.stderr.flush()


def load(request):
    global EXTRACTOR

    import sherpa_onnx

    started = time.time()
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=request['model_path'],
        num_threads=int(request.get('threads') or 1),
        debug=False,
        provider='cpu',
    )
    EXTRACTOR = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    return {'dim': EXTRACTOR.dim, 'load_s': round(time.time() - started, 2)}


def read_wav(path):
    import numpy as np

    with wave.open(path, 'rb') as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise ValueError('expected 16-bit mono WAV')
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, rate


def embed(request):
    if EXTRACTOR is None:
        raise RuntimeError('model not loaded')
    started = time.time()
    samples, rate = read_wav(request['audio_path'])
    stream = EXTRACTOR.create_stream()
    stream.accept_waveform(sample_rate=rate, waveform=samples)
    stream.input_finished()
    embedding = EXTRACTOR.compute(stream)
    return {
        'embedding': [float(value) for value in embedding],
        'seconds': round(len(samples) / float(rate), 2),
        'elapsed_ms': int((time.time() - started) * 1000),
    }


def main():
    send({'event': 'ready'})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            action = request.get('action')
            if action == 'shutdown':
                send({'id': request_id, 'ok': True})
                return
            if action == 'load':
                result = load(request)
            elif action == 'embed':
                result = embed(request)
            else:
                raise ValueError('unknown action: {}'.format(action))
            send({'id': request_id, 'ok': True, **result})
        except Exception as exc:  # noqa: BLE001
            log(traceback.format_exc())
            send({'id': request_id, 'ok': False, 'error': str(exc)})


if __name__ == '__main__':
    main()

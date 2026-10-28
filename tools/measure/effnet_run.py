"""Discogs-EffNet (MTG, Essentia models) style activations per track, for
tools/measure/compare_effnet.mjs. One JSON line each; resumes.

Preprocessing as Essentia's TensorflowPredictEffnetDiscogs does it: mono at
16 kHz, 512-sample frames every 256, the TensorflowInputMusiCNN mel bands (96),
patches of 128 frames every 62. The 400 style activations of all patches are
averaged, over the whole track and over its first two minutes (what the app
analyses), and the top fifteen of each are kept.

Decoding is ffmpeg's, with its own resampler at a long filter, not Essentia's
MonoLoader: MonoLoader crashed the process (signal 11) on one MP3 of the library,
and this ffmpeg build has no soxr.

Not part of the app (its weights are CC BY-NC-SA 4.0, 18 MB). Its own environment:

  uv venv .venv-effnet --python 3.12
  uv pip install --python .venv-effnet/bin/python essentia==2.1b6.dev1389 onnxruntime numpy
  curl -O https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx
  curl -O https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.json
  .venv-effnet/bin/python tools/measure/effnet_run.py LIST.json OUT.jsonl discogs-effnet-bsdynamic-1.onnx discogs-effnet-bs64-1.json
"""
import json, os, subprocess, sys, time
import numpy as np
import essentia.standard as es
import onnxruntime as ort

def main():
    files, out_path, model_path, meta_path = sys.argv[1:5]
    files = json.load(open(files))
    classes = json.load(open(meta_path))["classes"]
    sess = ort.InferenceSession(model_path)
    done = set()
    if os.path.exists(out_path):
        for line in open(out_path):
            try: done.add(json.loads(line)["file"])
            except Exception: pass
    mel = es.TensorflowInputMusiCNN()
    with open(out_path, "a") as out:
        for i, f in enumerate(files):
            if f in done: continue
            try:
                t0 = time.perf_counter()
                raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", f, "-ac", "1", "-af", "aresample=filter_size=64:phase_shift=10:cutoff=0.97",
                                      "-ar", "16000", "-c:a", "pcm_f32le", "-f", "f32le", "-"], capture_output=True, check=True).stdout
                audio = np.frombuffer(raw, dtype=np.float32)
                frames = np.array([mel(fr) for fr in es.FrameGenerator(audio, frameSize=512, hopSize=256, startFromZero=True)], dtype=np.float32)
                patches = [frames[s:s + 128] for s in range(0, len(frames) - 127, 62)]
                if not patches:
                    raise ValueError("shorter than one patch")
                act = sess.run(["activations"], {"melspectrogram": np.stack(patches)})[0]
                # Patch start in seconds: frame s starts at s * 256 / 16000.
                first = [k for k, s in enumerate(range(0, len(frames) - 127, 62)) if s * 256 / 16000 < 120]
                def top(v):
                    idx = np.argsort(-v)[:15]
                    return [[classes[j], round(float(v[j]), 4)] for j in idx]
                row = {"file": f, "seconds": len(audio) / 16000, "ms": round((time.perf_counter() - t0) * 1000),
                       "whole": top(act.mean(axis=0)), "first120": top(act[first].mean(axis=0))}
            except Exception as e:
                row = {"file": f, "error": str(e)[:200]}
            out.write(json.dumps(row) + "\n"); out.flush()
            print(f"\r  {i + 1}/{len(files)}", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)

if __name__ == "__main__":
    main()

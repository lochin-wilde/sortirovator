"""Beat This! (CPJKU, ISMIR 2024) over a list of tracks, for tools/measure/compare_beat_this.mjs.

Beats and downbeats per track, one JSON line each. Decodes with ffmpeg the way the
measurement harness does (mono, whole track up to 900 s), so the MP3 decoder offset
the scorer corrects for is the same one. Resumes: tracks already in the output are
skipped, so two processes on two halves of the list can run side by side.

Not part of the app, and not a dependency of it: run it in its own environment.

  uv venv .venv-beat-this --python 3.12
  uv pip install --python .venv-beat-this/bin/python torch tqdm einops soxr rotary-embedding-torch beat-this
  .venv-beat-this/bin/python tools/measure/beat_this_run.py LIST.json OUT.jsonl [--checkpoint final0|PATH] [--threads N]

The checkpoint name downloads from the authors' server (about 80 MB, MIT); in October
2026 that address answered 500 and the file had to be fetched from the same server's
older address, public.php/webdav/final0.ckpt with the share token as user name, and
passed as a path.
"""
import json, os, subprocess, sys, time
import numpy as np
import torch
from beat_this.inference import Audio2Beats

RATE = 22050
MAX_SECONDS = 900

def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-t", str(MAX_SECONDS), "-ac", "1", "-ar", str(RATE),
                          "-c:a", "pcm_f32le", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)

def main():
    files = json.load(open(sys.argv[1]))
    out_path = sys.argv[2]
    args = sys.argv[3:]
    checkpoint = args[args.index("--checkpoint") + 1] if "--checkpoint" in args else "final0"
    if "--threads" in args:
        torch.set_num_threads(int(args[args.index("--threads") + 1]))
    done = set()
    if os.path.exists(out_path):
        for line in open(out_path):
            try: done.add(json.loads(line)["file"])
            except Exception: pass
    model = Audio2Beats(checkpoint_path=checkpoint, device="cpu", dbn=False)
    with open(out_path, "a") as out:
        for i, f in enumerate(files):
            if f in done: continue
            try:
                y = decode(f)
                t0 = time.perf_counter()
                beats, downbeats = model(y, RATE)
                ms = round((time.perf_counter() - t0) * 1000)
                row = {"file": f, "seconds": len(y) / RATE, "ms": ms,
                       "beats": [round(float(b), 4) for b in beats], "downbeats": [round(float(d), 4) for d in downbeats]}
            except Exception as e:
                row = {"file": f, "error": str(e)[:200]}
            out.write(json.dumps(row) + "\n"); out.flush()
            print(f"\r  {i + 1}/{len(files)}", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)

if __name__ == "__main__":
    main()

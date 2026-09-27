#!/usr/bin/env python3
"""
Pairs the tempo ground truth with the files it describes.

tools/measure_bpm.mjs needs one thing the two collectors do not give it on
their own: a track name, the tempo Rekordbox decided on, and a path to audio
that still exists. This builds that list.

Which tempo counts
------------------
The database, when it has one. The analysis files carry the beat grid and the
database carries the number Rekordbox shows the DJ, and on a handful of tracks
they differ by exactly a factor of two -- a grid laid at double time under a
track counted in half. Measured across the library it was 10 disagreements in
2432, every one of them a clean 2x. The displayed value is the one a DJ would
call correct, so it wins, and the analysis files fill in anything the database
is missing.

This used to be a snippet pasted into a shell. The reports claim the
measurements reproduce, which was not true while one step of the chain existed
only in a scrollback buffer.

    python3 tools/match_tracks.py [--root DIR] [--out FILE]
"""

import argparse
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_ROOT = pathlib.Path("/Volumes/HomeSSD/Lochin")
DEFAULT_OUT = HERE / "ground-truth/matched.json"


def load(name):
    path = HERE / "ground-truth" / name
    if not path.is_file():
        raise SystemExit("нет %s — сначала соберите эталон" % path)
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOT)
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    db = load("rekordbox_db.json")["byPath"]
    anlz = load("rekordbox_bpm.json")["byName"]

    matched = {}
    missing_file = 0
    disagreed = []

    for path, track in db.items():
        if not track.get("bpm"):
            continue
        if not os.path.exists(path):
            missing_file += 1
            continue
        name = os.path.basename(path)
        grid = anlz.get(name, {}).get("bpm")
        if grid and abs(grid - track["bpm"]) > 0.05:
            disagreed.append((name, track["bpm"], grid))
        matched[name] = {"bpm": track["bpm"], "file": path}

    # Anything the database did not cover but the analysis files did, provided
    # the file can still be found under the library root.
    by_name = {}
    for path in db:
        by_name.setdefault(os.path.basename(path), path)
    added_from_grid = 0
    for name, entry in anlz.items():
        if name in matched or not entry.get("bpm"):
            continue
        path = by_name.get(name)
        if path and os.path.exists(path):
            matched[name] = {"bpm": entry["bpm"], "file": path}
            added_from_grid += 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(matched, ensure_ascii=False, indent=1), encoding="utf-8")

    print("в базе           %d" % len(db))
    print("файл не найден   %d" % missing_file)
    print("добавлено сеткой %d" % added_from_grid)
    print("итого пар        %d" % len(matched))
    print("расхождений базы и сетки %d%s" % (
        len(disagreed),
        "" if not disagreed else "  (берём значение базы)"))
    for name, shown, grid in disagreed[:5]:
        print("   %-46s база %.2f  сетка %.2f  (x%.2f)"
              % (name[:46], shown, grid, grid / shown))
    print("записано %s" % args.out)


if __name__ == "__main__":
    main()

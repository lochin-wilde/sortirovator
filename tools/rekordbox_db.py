#!/usr/bin/env python3
"""
Reads the Rekordbox library database and writes out what it knows per track.

Complements tools/rekordbox_anlz.py. The analysis files hold the beat grid but
not the musical key and not the genre, because those live only in `master.db`.
This reaches them through pyrekordbox, which handles the SQLCipher layer that
Rekordbox 6+ wraps the database in.

Read-only, and enforced rather than promised
--------------------------------------------
The database is copied to a scratch directory and the copy is what gets opened.
Nothing here can touch the library even by mistake, which matters more than
usual: this is a working DJ collection with beat grids and cue points in it, and
pyrekordbox is perfectly capable of writing. Rekordbox should be closed when the
copy is taken, so that the write-ahead log has been folded in; the script warns
when it finds one.

What the data is actually good for
----------------------------------
  key    2747 of 2764 tracks, in Camelot notation -- the same notation dsp.js
         emits, so it compares directly. This is the real prize.
  BPM    complete, but tools/rekordbox_anlz.py already supplies it from the beat
         grid; kept here as a cross-check that the two agree.
  genre  set on 495 of 2764, and most of what is set came from whatever the
         download stamped in the ID3 tag -- "RUSSIAN", "Other", "UNDERGROUND",
         "Electro, Dance". It is not a judgement about the music and must not be
         used as ground truth for genre. The folder tree is the honest source
         for that.

Usage
-----
    .venv/bin/python tools/rekordbox_db.py [--out FILE]
"""

import argparse
import json
import pathlib
import shutil
import sys
import tempfile

DEFAULT_DB = pathlib.Path.home() / "Library/Pioneer/rekordbox/master.db"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent.parent / "ground-truth/rekordbox_db.json"


def attr(row, name):
    value = getattr(row, name, None)
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=pathlib.Path, default=DEFAULT_DB)
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        sys.exit("pyrekordbox is not installed: .venv/bin/pip install pyrekordbox")

    if not args.db.is_file():
        sys.exit("no database at %s" % args.db)

    wal = args.db.with_name(args.db.name + "-wal")
    if wal.exists():
        print("warning: %s exists -- close Rekordbox so recent edits are included" % wal.name)

    with tempfile.TemporaryDirectory(prefix="rbread-") as tmp:
        copy = pathlib.Path(tmp) / "master.db"
        shutil.copy2(args.db, copy)
        for suffix in ("-wal", "-shm"):
            side = args.db.with_name(args.db.name + suffix)
            if side.exists():
                shutil.copy2(side, copy.with_name(copy.name + suffix))

        db = Rekordbox6Database(path=str(copy), unlock=True)
        tracks = {}
        for row in db.get_content():
            path = attr(row, "FolderPath")
            if not path:
                continue
            bpm = attr(row, "BPM")
            tracks[path] = {
                "name": attr(row, "FileNameL") or pathlib.PurePath(path).name,
                # Stored as hundredths of a BPM.
                "bpm": round(bpm / 100.0, 2) if bpm else None,
                "key": attr(row, "KeyName"),
                "genre": attr(row, "GenreName"),
                "artist": attr(row, "ArtistName"),
                "title": attr(row, "Title"),
                "year": attr(row, "ReleaseYear"),
                "rating": attr(row, "Rating"),
            }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"tracks": len(tracks), "byPath": tracks}, ensure_ascii=False, indent=1),
        encoding="utf-8")

    have = lambda field: sum(1 for t in tracks.values() if t[field])
    print("tracks     %d" % len(tracks))
    print("with key   %d" % have("key"))
    print("with bpm   %d" % have("bpm"))
    print("with genre %d  (tag text, not a judgement -- do not use as ground truth)"
          % have("genre"))
    print("written to %s" % args.out)


if __name__ == "__main__":
    main()

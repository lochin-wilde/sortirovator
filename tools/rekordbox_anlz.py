#!/usr/bin/env python3
"""
Reads Rekordbox's analysis files and writes out the BPM it decided on per track.

Why this exists
---------------
Tempo and key were already tuned against Rekordbox labels -- dsp.js records 1334
tracks for tempo and 428 for the key work -- but those labels arrived by hand and
cannot be regenerated. This reads them straight off the disk instead, so the set
grows with the library and any measurement can be repeated without asking the
owner for anything: `~/Library/Pioneer/rekordbox/share/PIONEER/USBANLZ/**/ANLZ0000.DAT`.

The obvious route -- reading `master.db` -- is a dead end: Rekordbox 6+ encrypts
it, and the header confirms it (no `SQLite format 3` magic). The ANLZ files need
no such thing. Each one names its own track in a `PPTH` section, so the tree is
self-describing and the encrypted database is never touched.

What is here and what is not
----------------------------
ANLZ carries the beat grid, the waveform and the cue points. It does NOT carry
genre or musical key -- those live only in the database and in the XML export.
So this gives us an answer for tempo and nothing else, which is still half of
what the app computes.

Format
------
A file is a `PMAI` container whose header length tells you where the sections
start; each section is a four-character tag, a header length and a total length,
so the tree is walked by hopping section to section. All integers big-endian.

  PPTH  u32 length, then a UTF-16BE path (NUL-terminated)
  PQTZ  u32 unknown, u32 unknown, u32 beat count,
        then per beat: u16 beat-in-bar (1..4), u16 BPM*100, u32 milliseconds

Tempo can change across a track, so the per-beat values are collapsed to the one
that holds for the longest -- for a DJ library that is the tempo of the track.

Usage
-----
    python3 tools/rekordbox_anlz.py [--anlz DIR] [--out FILE]

Defaults write to `ground-truth/rekordbox_bpm.json`, which .gitignore keeps out
of the repository: it describes a private library and is not ours to publish.
"""

import argparse
import collections
import json
import os
import pathlib
import struct
import sys

DEFAULT_ANLZ = pathlib.Path.home() / "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent.parent / "ground-truth/rekordbox_bpm.json"

# A section header is at minimum tag + len_header + len_tag.
MIN_SECTION = 12


def sections(data):
    """Yield (tag, payload_offset, payload_end) for each section of an ANLZ file."""
    if len(data) < 8 or data[:4] != b"PMAI":
        return
    offset = struct.unpack_from(">I", data, 4)[0]
    # A malformed header could point past the end, or at itself; both would spin
    # forever without these guards.
    if offset < 8:
        return
    while offset + MIN_SECTION <= len(data):
        tag = data[offset:offset + 4]
        len_header, len_tag = struct.unpack_from(">II", data, offset + 4)
        if len_tag < MIN_SECTION or len_header < MIN_SECTION or len_header > len_tag:
            return
        end = offset + len_tag
        if end > len(data):
            return
        yield tag, offset, offset + len_header, end
        offset = end


def read_path(data, body, end):
    length = struct.unpack_from(">I", data, body - 4)[0]
    raw = data[body:body + length]
    if len(raw) < length:
        raw = data[body:end]
    try:
        text = raw.decode("utf-16-be")
    except UnicodeDecodeError:
        return None
    return text.rstrip("\x00")


def read_tempo(data, body, end):
    """The BPM that covers the most beats, or None when there is no grid."""
    count = struct.unpack_from(">I", data, body - 4)[0]
    available = (end - body) // 8
    count = min(count, available)
    if count <= 0:
        return None
    weight = collections.Counter()
    for i in range(count):
        _, tempo = struct.unpack_from(">HH", data, body + i * 8)
        if tempo > 0:
            weight[tempo] += 1
    if not weight:
        return None
    return weight.most_common(1)[0][0] / 100.0


def parse(path):
    try:
        data = path.read_bytes()
    except OSError:
        return None
    track_path = None
    bpm = None
    beats = 0
    for tag, start, body, end in sections(data):
        if tag == b"PPTH":
            track_path = read_path(data, body, end)
        elif tag == b"PQTZ":
            bpm = read_tempo(data, body, end)
            beats = max(0, (end - body) // 8)
    if not track_path:
        return None
    return {"path": track_path, "name": os.path.basename(track_path), "bpm": bpm, "beats": beats}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--anlz", type=pathlib.Path, default=DEFAULT_ANLZ)
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    if not args.anlz.is_dir():
        sys.exit("no ANLZ directory at %s" % args.anlz)

    files = sorted(args.anlz.rglob("ANLZ0000.DAT"))
    tracks = []
    unreadable = 0
    no_grid = 0
    for f in files:
        entry = parse(f)
        if entry is None:
            unreadable += 1
            continue
        if entry["bpm"] is None:
            no_grid += 1
        tracks.append(entry)

    # Rekordbox keeps analysis for tracks that have since been removed or moved,
    # and re-analysis can leave two directories describing the same file. Later
    # wins, since the list is sorted and a rewrite lands in a fresh directory.
    by_name = {}
    for t in tracks:
        by_name[t["name"]] = t

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": str(args.anlz),
        "files": len(files),
        "tracks": len(by_name),
        "byName": by_name,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    graded = [t for t in by_name.values() if t["bpm"]]
    print("ANLZ files      %d" % len(files))
    print("unreadable      %d" % unreadable)
    print("without a grid  %d" % no_grid)
    print("unique tracks   %d" % len(by_name))
    print("with a tempo    %d" % len(graded))
    print("written to      %s" % args.out)
    if graded:
        tempos = sorted(t["bpm"] for t in graded)
        print("tempo range     %.1f .. %.1f, median %.1f"
              % (tempos[0], tempos[-1], tempos[len(tempos) // 2]))


if __name__ == "__main__":
    main()

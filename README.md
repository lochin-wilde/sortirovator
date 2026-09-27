# Музыкальный сортир

*[Русская версия](README.ru.md) is a translation of this one.*

Sorts a DJ's library in the browser. It cleans up file names, detects tempo and
key, files each track under a genre, evens out loudness, and hands back a ZIP
with the tracks tagged, sorted into folders and listed in playlists that
Rekordbox imports directly.

**The audio never leaves the browser.** Decoding, analysis and building the
archive all happen on the machine the page is open on. The only thing sent out
is text — artist and title — to ask Discogs, MusicBrainz and Last.fm what genre
a track is. The original files on disk are never modified.

Live at [sortirovator.pages.dev](https://sortirovator.pages.dev): a public page
describing the tool, with the app itself behind an invite code while it is in
closed testing.

## What it does

| | |
|---|---|
| **Genre** | 6712 tags from three services, mapped onto 53 categories a DJ actually keeps apart — Afro House and Tech House never share a folder. A guess drawn from the artist rather than the track is marked `?` |
| **Tempo** | against Rekordbox, 93.4% within ±1 BPM on 4459 tracks. A tempo that drifts is shown as `121~` rather than as one number that is not true |
| **Key** | Camelot notation, 65.0% exact and 80.8% within a mix on 4523 tracks. An unsure answer is shown as `8A?` |
| **Loudness** | ITU-R BS.1770, integrated or short-term, true-peak aware, optional limiter, WAV or MP3 out. Without the limiter, gain stops before peaks pass −1 dBTP instead of clipping |
| **Names** | strips what download sites add, turns transliterated Latin back into Cyrillic, reads artist and title from the file's tags before guessing from its name |
| **Tags** | genre, tempo and key are written back into MP3 and WAV output as ID3v2.4, carrying across the frames the file already had — cover art, Serato beat grids and the rest |
| **Playlists** | `.m3u8` by genre, by tempo, around the Camelot wheel, and by loudness, with relative paths |

Every figure above was measured against a hand-labelled library, not estimated.
How, and where the results are weak, is in [web/README.md](web/README.md). The
short version: genre is the hard part — 20.5% exact, with the rest split between
related genres, wrong answers and an honest blank.

## How it is built

No build step and no framework. The app is static files that run as written, so
deploying is copying files. The version number is bumped by hand in
`web/js/app.js` and every `?v=` in the HTML; what breaks when it is not is in
[web/README.md](web/README.md).

```
web/                  the app, served as static files
  index.html          the app
  landing.html        public front page — self-contained, since the gate
                      answers every other path with the login page
  admin.html          reviewing genre corrections (admin role only)
  css/styles.css      design tokens and styles; every page follows them
  js/app.js           batch pipeline, results table, ZIP, playlists, tag writing
  js/identify.js      name parsing, transliteration, lookups, genre decision
  js/dsp.js           FFT, tempogram BPM, CQT chroma key
  js/loudness.js      BS.1770, true peak, limiter, resampler, WAV and MP3
  js/tags.js          reading and writing ID3v2, Vorbis and MP4 tags
  js/worker.js        runs the audio work off the main thread
  js/feedback.js      queues genre corrections
  js/admin.js         the admin panel
  js/i18n.js          Russian and English strings
  data/genres_map.json   generated — see below
  og.png              link preview card — generated
  _headers            CSP and caching
functions/            Cloudflare Pages Functions
  _middleware.js      invite gate, landing page, robots.txt
  api/feedback.js     receives genre corrections into D1
  api/whoami.js       who the session belongs to
  api/admin/feedback.js  corrections for review
db/schema.sql         the one table the functions write to
tools/
  test_all.sh         runs every test
  test/               the tests
  measure/            accuracy harnesses, scored against Rekordbox
  groundtruth/        builds the reference data out of Rekordbox
  build/              genre map, link card, invite codes
```

## Running it locally

```bash
cd web && python3 -m http.server 8777
```

Then open `http://127.0.0.1:8777/`. Opening `index.html` as a `file://` URL
does not work: Web Workers and `fetch` need a real origin. There is no gate
locally — it is `functions/_middleware.js`, which only runs on Cloudflare Pages.

## Tests

```bash
sh tools/test_all.sh
```

Runs everything in `tools/test/`. None of it needs the network, a database or a
browser, and the whole suite takes a few seconds. It covers the gate and its
public paths, genre corrections, playlists, tag writing, name cleanup,
transliteration, archive paths, that every page stays on the same design tokens,
and that the shipped genre map is exactly what its generator produces.

## Measuring accuracy

The reference is the owner's own Rekordbox library: tempo and key from its
database, genre from the folders the tracks were filed into by hand. The drive
holding the library has to be mounted.

```bash
python3 tools/groundtruth/rekordbox_anlz.py         # beat grids from the analysis files
.venv/bin/python tools/groundtruth/rekordbox_db.py  # key and displayed tempo; needs pyrekordbox
python3 tools/groundtruth/match_tracks.py           # pairs them with files on disk

node tools/measure/measure_bpm.mjs                  # ~10 min
node tools/measure/measure_key.mjs                  # ~10 min
LASTFM_KEY=… node tools/measure/measure_genre.mjs --per-folder 25   # ~40 min, network-bound
```

The database is read from a copy, never opened in place. The results land in
`ground-truth/`, which is not committed: it describes a private library.

Read the numbers per folder, not only in total. The average moves with what
the library contains — about two thousand added tracks, mostly house and liquid drum & bass, lifted key accuracy
from 59.4% to 65.0% without the detector changing at all.

## Deploying

Cloudflare Pages, output directory `web`, no build command. It needs two
encrypted environment variables, `SESSION_SECRET` and `INVITE_CODES`, and a D1
binding named `DB`. Without the secrets the gate answers 503 instead of serving
the app unprotected. Details, including revoking one tester's access, are at the
top of [functions/\_middleware.js](functions/_middleware.js).

## Rebuilding the genre map

`web/data/genres_map.json` is generated, never edited by hand — a test fails if
it differs from a fresh build:

```bash
python3 tools/build/build_genres.py tools/build/genres_map.source.json web/data/genres_map.json
```

The source is a general-purpose tag list in which most tags point at Pop and
almost none at the house subgenres a DJ sorts by. The script rewrites the values
by rule so that the categories follow a DJ's shelves instead.

## Licence

MIT.

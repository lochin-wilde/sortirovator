# Музыкальный сортир

*[Русская версия](README.ru.md)*

A DJ library sorter that runs entirely in the browser. It files tracks by genre,
measures BPM and Camelot key, and evens out loudness — then hands back a ZIP with
everything in genre-named folders.

**Nothing is installed and no audio is uploaded.** Decoding, analysis and
encoding all happen on the machine the page is open on. Only artist and title
strings leave it, and only to ask MusicBrainz, Discogs or Last.fm what a track
is.

Currently in closed testing: [sortirovator.pages.dev](https://sortirovator.pages.dev)
answers with a code prompt.

## What it does

| | |
|---|---|
| **Sort by genre** | ~6700 tags from three services, collapsed onto the categories a DJ actually keeps as crates — Afro House and Tech House do not share a folder |
| **BPM** | 96% within ±2 BPM across 878 labelled tracks; constant and dynamic tempo are reported differently, because one number for a live band is a fiction |
| **Key** | Camelot notation, 82% landing on a harmonically compatible key |
| **Loudness** | ITU-R BS.1770 integrated or short-term, true-peak limiting, WAV or MP3 out |
| **Filenames** | Optional rewrite to a canonical `Artist — Title` using MusicBrainz |

Every number above was measured rather than estimated, and the measurements —
including where the results are weak — are in [web/README.md](web/README.md).

## How it is built

No build step and no framework. The app is static files that run as written,
which is why deployment is a file copy and why the version string is bumped by
hand — [web/README.md](web/README.md) explains what breaks otherwise.

```
web/              the app — served by any static host
  js/dsp.js       FFT, onset/tempogram BPM, CQT chroma key, genre centroids
  js/loudness.js  BS.1770 loudness, true peak, limiter, resampler, encoders
  js/identify.js  filename parsing, transliteration, fuzzy matching, lookups
  js/worker.js    runs all of the above off the main thread
  _headers        CSP and caching rules
functions/        Cloudflare Pages Functions: the access gate and feedback API
db/schema.sql     the one table those functions write to
tools/            genre-map build script and the test suites
```

## Running it locally

```bash
cd web && python3 -m http.server 8777
```

Then open `http://127.0.0.1:8777/`. Opening `index.html` as a `file://` URL does
not work — Web Workers and `fetch` need a real origin.

There is no gate locally. The gate is `functions/_middleware.js`, which only runs
when deployed to Cloudflare Pages.

## Tests

```bash
node tools/test_gate.mjs functions/_middleware.js   # access control
node tools/test_feedback.mjs                        # corrections API
node tools/test_paths.mjs                           # ZIP folder names
node tools/test_translit.mjs                        # Latin -> Cyrillic
```

All four run without a network, a database or a browser.

## Deploying

Cloudflare Pages, build output directory `web`, no build command. Two encrypted
environment variables and one D1 binding are required; without them the gate
returns 503 rather than serving the app unprotected. The details, including how
to revoke a single tester, are in the header comment of
[functions/\_middleware.js](functions/_middleware.js).

## Rebuilding the genre map

`web/data/genres_map.json` is generated, not edited:

```bash
python3 tools/build_genres.py tools/genres_map.source.json web/data/genres_map.json
```

The source is a general-purpose vocabulary in which 2932 of 6700 tags point at
Pop and 128 at House. For a DJ that is backwards, so the script rewrites the
values by rule.

## Licence

MIT.

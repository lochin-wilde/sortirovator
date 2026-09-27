# Музыкальный сортир — implementation notes

The app itself. No Python, no server-side audio processing, no install — static
files only, which any static host can serve.

This file is the engineering record: what was measured, what the numbers came
out as, and why each non-obvious choice was made. For what the project is and
how to run it, see the [README at the root](../README.md).

**On "the Python version".** This started as `music_genre_sorter.py`, a
command-line script, and the sections below compare against it because that is
what the browser code was verified against — loudness within 0.05 dB, true peak
within 0.02 dB, on 34 synthetic files. The script is no longer in the
repository; it is in the history if a comparison ever needs repeating.

## Running it

```bash
python3 -m http.server 8777
```

Then open `http://127.0.0.1:8777/`. Opening `index.html` via `file://` will not
work: Web Workers and `fetch` need a real origin.

Deployment is a plain static upload. **No COOP/COEP headers are required** —
nothing here uses `SharedArrayBuffer`, so there is no multi-threaded WASM to
silently degrade. The app logs the `SharedArrayBuffer` state at startup anyway,
so this is visible rather than assumed.

## Deploying an update

**Bump the version string before deploying.** It appears twice: `APP_VERSION` in
`js/app.js`, and the `?v=` on the stylesheet and every script tag in
`index.html`. They must match.

Skipping this does not break the page in an obvious way — it breaks it in a
confusing one. Browsers cache each file independently of the page, so users get
a mixture: new HTML with the previous stylesheet, or a new interface driving an
old worker. That happened here: the invite screen shipped with new markup and a
cached stylesheet, so it rendered as an unstyled block scrolled off the top of
the page and looked like broken authorization.

Workers are worse than the rest, because a worker's `importScripts()` is cached
separately again — hence the version being forwarded into it from the worker's
own URL.

A content hash would remove the manual step, but that needs a build, and this
project deliberately has none.

## Invite gate

There is exactly one gate, `functions/_middleware.js`, and it runs on Cloudflare
Pages before any file is served. An unauthenticated request is answered with a
login page instead of the app, so a visitor without a code never receives
`js/*`, the genre map, or anything else. Codes live in the project's environment
variables and are never in the repository. Deployment, revocation and code
length are documented in the file's own header.

**Nothing in `web/` checks a code, and nothing should.** A second gate written
in client-side JavaScript used to sit here and was removed, because it broke the
thing it looked like it was protecting: a tester who had cleared the middleware
with their individual code then met a second prompt whose list of codes — being
served to every visitor — could not contain that code. They were stopped by the
decorative gate after passing the real one.

The general rule, which is worth keeping in mind before adding any check to this
directory: code shipped to the browser cannot keep a secret, so a check that
runs there can only ever be a suggestion. It also could not be reconciled with
individual codes without publishing them.

### Rate limiting

The form answers every guess instantly and for free, so without a limit a
guesser gets unlimited tries at no cost. Ten failures from one address inside
fifteen minutes and further attempts are answered 429 with a `Retry-After`,
including attempts carrying a correct code -- otherwise the limit could be
lifted by the very guessing it exists to stop. Only failures are counted and a
success clears that address, so mistyping your own code a few times costs
nothing.

This is done in `_middleware.js` against a D1 table rather than with
Cloudflare's own rate limiting rules, which are configured per zone -- per
domain you own. This deployment answers on a pages.dev address, which belongs to
Cloudflare, so there is no zone to attach a rule to. Doing it in code also means
the protection travels with the app to any host.

**It fails open.** If the database is unreachable the limit is skipped rather
than the login refused: refusing would lock out testers who did nothing wrong in
order to defend a 20-character random code. That is the opposite of how the gate
itself behaves, and deliberately so -- the gate failing closed protects the app,
this failing closed would only deny it.

Serving `web/` from a static host with no middleware — GitHub Pages, Netlify
without functions, `python3 -m http.server` — therefore means no gate at all.
That is the correct behaviour for local development and the wrong deployment for
a closed test.

## Interface language

Russian and English, switched in the masthead and remembered in `localStorage`.
Without a saved choice the interface opens in Russian regardless of the
browser's locale — several machines here report `en-GB` while their owner does
not read English comfortably, so the browser's answer is not a good proxy.

Static markup carries `data-i18n` attributes; strings built in code go through
`t()`. Placeholders are named (`{count}`, `{file}`) rather than positional,
because the two languages order the same values differently within a sentence.

Log lines already written keep the language they were written in. Rewriting the
scrollback on every switch would be more confusing than a mixed log, and the log
is a record of what happened rather than live interface text.

## Layout

| File | Role |
|---|---|
| `index.html` | Three-step UI: select, configure, run |
| `landing.html` | Public front page. Self-contained on purpose: the gate answers every other path with the login page, so it can link nothing |
| `admin.html` | Review of genre corrections, admin role only |
| `css/styles.css` | Design tokens and styling, dark and light. The landing and login page copy the same tokens inline; `tools/test/test_style.mjs` fails if they drift |
| `js/dsp.js` | FFT, onset/tempogram BPM, CQT chroma key |
| `js/loudness.js` | ITU-R BS.1770 loudness, true peak, limiter, silence trim, resampler, WAV/MP3 encoders |
| `js/tags.js` | Reads ID3v2, Vorbis comments and MP4 ilst; writes ID3v2.4 into MP3 and WAV |
| `js/rekordbox.js` | Reads a Rekordbox collection export and writes an XML to import back, holding only the tracks whose genre changed |
| `js/identify.js` | Filename parsing, transliteration, fuzzy matching, Discogs, MusicBrainz and Last.fm lookups, and the genre decision itself (`resolveGenreFrom`) |
| `js/worker.js` | Runs all of the above off the main thread |
| `js/app.js` | Batch orchestration, progress, results table, ZIP, `.m3u8` playlists, tag writing |
| `data/genres_map.json` | 6712 tags onto 53 categories, generated by `tools/build/build_genres.py` |
| `og.png` | Link preview card, generated by `tools/build/make_og_image.py` from the same measured figures |

Dependencies: **JSZip** (required, for the output archive) and **lamejs**
(optional — only for MP3 output; the app falls back to WAV without it).

Both are **served from this origin**, from `js/lib/`, and neither is fetched
from a CDN. That is not a preference: `_headers` sets `script-src 'self'`, so a
CDN script would be blocked outright. Serving them ourselves also means the code
that touches every file a user loaded cannot be swapped out by a third party.

## Relationship to the Python version

The Python version classified genre with a hand-tuned nearest-centroid rule
over four spectral features, and this port carried it across exactly. **It has
since been removed.** Measured against 300 tracks the owner had filed by hand,
it answered 143 of them and was right about none: it only knew Rock,
Electronic, Jazz, Pop and Classical, against a library filed as Afro House and
Jersey Club. A track no online source knows now gets an honest blank instead.

Loudness still follows the Python implementation: verified identical on 34
synthetic files, within 0.05 dB for loudness and 0.02 dB for true peak.

**Tempo and key no longer follow it.** Both were re-derived after the ported
versions measured poorly on real music: the librosa-style tempo prior was
producing triplet errors outside the 120–130 BPM range, and the ported chroma
reported a 110 Hz A as a C. What replaced them, and why, is recorded below and
in the comments at each function.

## Accuracy on real music

Measured against the owner's Rekordbox library: tempo and key against its
database, genre against the folders the tracks were filed into by hand. The
tooling that builds the reference and scores against it is in `tools/`; the
top-level README has the commands.

| | Tracks | Result |
|---|---|---|
| **Tempo** | 4459 | **93.4%** within ±1 BPM; a further 3.5% are a clean multiple — double, half, 4/3 — that a DJ reads through |
| **Key** | 4523 | **65.0%** exact, **80.8%** exact or one step round the Camelot wheel |
| **Genre** | 375, 25 per folder | **20.5%** exact, 11.2% a related genre, 31.2% an honest blank |

**Read these per folder, not only in total.** The averages move with what the
library contains. Between two runs a month apart, key accuracy rose from 59.4%
to 65.0% while the detector did not change at all: every folder measured both
times returned the same figure to the decimal, and the new tracks were mostly
house and liquid drum & bass, which it reads well. Tempo's rise from 90.1% to
92.3% in the same period was the reference being corrected, not the detector
improving — on 154 tracks Rekordbox's beat grid sits at exactly double the tempo
its database shows. The move to 93.4% after that was a real change, the cap
described at `BPM_MAX` in `js/dsp.js`: 53 fixed, 3 broken, McNemar z = 6.68.

Key accuracy varies far more by material than by tuning — 38% on 90s hip hop,
where old records are sampled and pitched, against 86% on afro house, same
code. Tempo holds up everywhere except swung, live drumming.

Every number was arrived at by measurement, and several rounds of "obvious"
improvements were thrown away because they only looked good on synthetic audio —
one configuration scored 50/50 on generated tones and then 33% on real tracks.
**Synthetic audio is useful for catching outright bugs and useless for tuning.**

### Where key detection is weak

Major/minor discrimination barely works. Across all four Rekordbox sets only 33
of 428 tracks are in a major key, and the detector identifies few of them. The minor bias
improves the overall score largely by exploiting that base rate rather than by
telling the modes apart — see `KEY_MINOR_BIAS` in `dsp.js`, which documents the
trade-off and the operating point chosen. On a library that is not
overwhelmingly minor, set it to 1.0.

### BPM

Candidate tempos come from the mean tempogram, but which candidate wins is
decided by an **octave rule**, not by weighting every peak.

Two peaks are seeded from the strongest raw candidates, and only their powers of
two — ×4, ×2, ×1, ÷2, ÷4 — are considered. Tempo ambiguity is fundamentally 2:1:
the same pulse counted twice as fast or twice as slow. A 3:2 relative is a
different pulse, and no listener would call it the tempo.

That restriction was forced by measurement across 18 genres. Weighting all peaks
by a 120 BPM prior — the approach inherited from `librosa.beat.tempo` — works on
the 120–130 shelf and fails badly outside it. Of 64 errors, only 10 were
halvings; **24 were exactly two thirds of the true tempo and 21 four thirds**,
the detector locking onto a triplet subdivision. The prior caused them: for a
172 BPM drum & bass track it scores the 115 BPM triplet peak at 0.999 and the
truth at 0.874, so the triplet wins outright. Drum & bass scored 10/25 and
moombahton 11/25 that way.

The prior survives but only chooses *within* an octave family, so its spread is
narrow (centre 125, σ 0.4). Measured across all 793 labelled tracks: **759/793
against 720/793** for the previous approach, with drum & bass and moombahton the
bulk of the gain and no genre regressing by more than one track.

**Sub-bin refinement of the peak.** Lag bins are integers, so raw candidates are
`60*sr/hop/k`; around 130 BPM that grid steps in jumps of 3.5 BPM, offering
126.0, 129.2, 132.5 and nothing between — a track at 128 or 134 could not be
represented at all, which is why a Rekordbox-verified 134 came back as 133.
Fitting a parabola through the peak and its neighbours recovers the fraction:
mean error 0.61 BPM down to 0.01.

### Constant vs dynamic tempo

Tempo is measured in overlapping 30-second windows as well as across the whole
track, and the result is described according to what the windows say — the
"auto" behaviour of a high-precision beatgrid analysis.

A record produced to a grid gives the same answer in every window and gets a
single precise number, taken from the whole-track tempogram, which has every bar
to work with. A track whose windows disagree by more than 2 BPM is reported as
dynamic, with its range, because one number would be a fiction. Windows that
land on a different tempo octave are folded back first: a single window hearing
62 instead of 124 is a halving artefact, not a tempo change.

On the 165-track set, 160 came out constant and 5 dynamic. The five are exactly
the material that should be: a 1979 Sister Sledge disco record played by a live
band, two live-feel Crazy P and jazz-mix tracks, and a track ripped from a
continuous DJ mix.

### Key

Constant-Q chroma spanning C1–B6, high-passed at C3 before the transform, with
only the semitones from C3 up folded into the chroma.

The high-pass and the discard do different jobs and both are needed. Discarding
bins stops sub-bass being *counted*; the high-pass stops it being *heard* by the
lowest surviving filter, whose skirt responds well below its centre. Without the
filter, a 110 Hz A came out as a C — caught by feeding the detector single sine
waves — and on the real set it is worth nine tracks (103 versus 94).

The profile weights root, fifth, third and seventh; the general-purpose profiles
from the literature (Krumhansl-Schmuckler, Temperley, Shaath) all measured worse
on this material, which is loop-based and thinner than the notated music they
were derived from.

A minor-mode bias of 1.15 is applied. Dance music is overwhelmingly minor — 144
of the 165 labelled tracks — and without the bias the detector over-predicted
major. It is a prior about this material, not about music in general.

**A textbook HPCP implementation was tried and rejected.** Harmonic Pitch Class
Profile — spectral peak picking with harmonic summation and tuning correction,
the published basis of KeyFinder and Essentia's key extractor — is more correct
in isolation: it reads every pure sine right, including the ones the constant-Q
version got wrong, and scores 24/24 on synthetic house loops against 9/24. On
the real library it reached only 83/165 even with its own profile tuned on the
same data. It was kept out. The implementation may simply be under-tuned; what
is certain is that on this material it lost.

### Confidence

The gate is 0.50. Correct answers average 0.687 and wrong ones 0.492, so the
score carries real information, but the distributions overlap and no threshold
separates them cleanly. At 0.50, 90 of 103 correct answers are marked confident
and 19 of 27 wrong ones are demoted. Nothing is discarded either way — a weak
result is shown as `8A?` with its score, because a labelled guess beats a blank
field when you are checking a set.

**Analysis window is capped at 120 seconds.** The Python version analyses the
whole file for BPM and key. Both are stable well inside that window and the cap
keeps a batch usable in a browser. Loudness still measures the entire file,
since that is a measurement rather than an estimate.

**The limiter is not ffmpeg's `alimiter`.** Both clamp to the same −1 dBTP
ceiling, but the attack/release differ. On normal material this is invisible; on
extreme-crest-factor input with very large gain the two diverge (measured: 0.46
dB on a click track needing +16 dB). Ordinary music does not reach that regime.

**Output is WAV or MP3, never the original codec.** When loudness normalization
is on, audio is re-encoded — WAV by default, MP3 320 kbps if lamejs loads. When
it is off, the original file is copied into the ZIP byte-for-byte, so nothing is
re-encoded needlessly.

**Tags are written into MP3 and WAV, not FLAC or M4A.** Title, artist, genre,
tempo and key go in as ID3v2.4 — in front of the audio for MP3, as an `id3 `
chunk for WAV. Frames the file already carried are copied across, because
replacing the whole block would silently drop cover art and the GEOB frames
Serato keeps its beat grids in; v2.2 and unsynchronised tags are skipped, and a
frame with any flag set is dropped rather than copied under rules the writer
does not implement. FLAC and M4A pass through untouched, since rewriting Vorbis
blocks or shifting MP4 atom offsets badly is worse than not rewriting them.

**AcoustID fingerprinting is not ported.** It needs the `fpcalc` binary. The
text-based MusicBrainz path, including the Cyrillic-transliteration retry, is
fully present and verified (`Korol_i_SHut_-_Kukla_kolduna_62570545` correctly
resolves to `Король и Шут — Кукла колдуна`).

## Speed

Measured on a 2-minute track and on an 8-file batch, on an 8-core machine.

| | before | after |
|---|---|---|
| single track, per-stage sum | 6.9 s | 4.0 s |
| 8-file batch, one worker | — | 28 s (3.5 s/track) |
| 8-file batch, four workers | — | **9 s (1.13 s/track)** |

Four things account for it, all of them removals of wasted work rather than
cheaper maths — every result stayed bit-identical, verified on 54 tracks:

**The tempogram was computed twice.** The whole-track pass and the seven sliding
windows the constant/dynamic check needs are slices of the same envelope, so the
per-frame autocorrelations now happen once and accumulate into every window that
contains them. 2386 ms → 1328 ms.

**Loudness gating rescanned every block per window.** Blocks are sorted, so a
3-second window is a contiguous run; two moving indices replaced filtering ~1200
blocks for each of ~118 windows and allocating an array each time.

**True peak interpolated every sample.** 524 million multiply-accumulates to
find one maximum. Hoisting the bounds check out of the inner loop halved it,
2518 ms → 1298 ms. It is still the single most expensive step and resisted
further work: the rigorous skip condition depends on the kernel's L1 norm, which
is 2.39 here, so it only prunes material below 42% of peak — and music is rarely
that quiet. Going further needs approximation, which is not acceptable in a
measurement.

**True peak is now optional.** Sorting by level does not need it, so the table's
loudness figure skips it: 91 ms instead of 1619 ms. The figures that drive gain
still compute it.

**Files are analysed four at a time** in a worker pool. The cap of four is about
memory rather than cores — each worker holds a decoded track, roughly 42 MB for
two minutes of 44.1 kHz stereo — and one core is left free so the interface stays
responsive. Log blocks are buffered and emitted in file order; interleaving
three tracks' lines would make the log unreadable.

Decoding stays on the main thread because `decodeAudioData` is unavailable
inside a worker on Safari, so it is the one stage that cannot overlap with
itself. It is also among the cheapest, so that costs little.

### A note on measuring this

The first parallel measurements were nonsense — 2 workers appeared to give no
speedup at all — because the browser pane was in the background and throttled.
Timing anything in a hidden tab produces numbers that look plausible and are
not. The figures above were taken with the window in front.

## Browsing a finished batch

The results table sorts by any column and filters across name, artist, genre and
key at once. It is redrawn from the stored results rather than from the DOM, so
BPM and loudness sort numerically instead of as text, where `-9.5` would come
after `-13.7`.

Loudness is measured for **every** track, not only when normalization is on.
That became affordable by splitting the measurement in two: the table's figure
comes from the mono downmix already being transferred for tempo analysis and
skips the true-peak scan, which costs 91 ms instead of 1619 ms. The figures that
decide gain still come from the full channel set over the whole file.

### There is no "energy" column, and that is deliberate

Sorting by intensity was the request, and four candidate measures were tried
against six labelled genres. The onset-based ones measure the wrong thing:
afro house scored *highest* on onset density and drum & bass lowest, because
density tracks percussive busy-ness — congas and shakers — rather than how hard
a track hits.

Loudness did order the genres the way a DJ would expect:

| genre | integrated LUFS |
|---|---|
| 90s hip-hop | −14.9 |
| funky/disco house | −13.7 |
| afro house | −13.4 |
| jersey club | −11.2 |
| dubstep | −9.9 |
| drum & bass | −9.2 |

So the column is labelled **Loudness** and not **Energy**. That ordering is
largely mastering practice, not musical intensity: a 1994 hip-hop record is
quieter because of when it was cut, and modern bass music is loud because of the
loudness war. It is genuinely useful for building a set — a louder master does
hit harder in a mix — but calling it energy would claim a measurement that was
not made.

## Genre corrections

Clicking a genre in the results table turns it into a dropdown. The correction
is stored in `localStorage` and applied from then on, ranking above every
lookup — the user is looking at their own library and the app is guessing at it.

A correction has to teach something beyond the track it was made on, or it is
just hand-relabelling. Two levels are kept:

- **track** — this exact recording is X, always applied.
- **artist** — once the same artist has been corrected to the same genre
  **twice**, that becomes the answer for their other tracks.

Two agreeing corrections rather than one is deliberate. One says something about
a track; two say something about the artist. Plenty of artists genuinely span
genres, so a single data point should not start overriding lookups for their
whole catalogue.

### Sending them to the author

Corrections are POSTed to `/api/feedback`, which stores them in D1. They are
also kept locally and applied locally, so the send is not what makes a
correction work for the person who made it — it is what lets it reach the genre
map and everybody else.

    { v: 1, at: ISO-8601, file, artist, title,
      detected, detectedSource, corrected, bpm, key }

`detectedSource` is the field that makes the rest worth collecting: it records
*which* tag from *which* service produced the wrong answer, so aggregated
corrections can fix the genre map itself rather than only patching individual
tracks. The same records still download as JSON from **Export corrections**.

**Sending is best-effort, and deliberately so.** Every entry carries a `sent`
flag that only an acknowledgement from the server clears; an interrupted request
leaves it queued for the next correction or the next visit. A failure never
raises a dialog, never throws, and never blocks a batch — a correction is made
in the middle of reviewing a hundred results, and losing that review to a
network error would cost far more than the correction is worth. The queue is
therefore allowed to grow and drain later, and never retried in a loop.

Entries stored before this endpoint existed have no `sent` flag and are treated
as unsent, so corrections made during the closed test are not stranded.

The tester is identified by the label on their invite code, which the middleware
recovers from the verified session and passes down as `context.data.invite`. The
endpoint never reads the cookie itself — a route that parses a session without
checking its signature is how a label becomes forgeable.

What is sent is stated plainly in the interface next to the corrections, because
it leaves the machine: the track name, artist and title, the detected and
corrected genre, and the measured BPM and key. Never the audio.

### What it needs in Cloudflare

Without a D1 binding the endpoint answers 503 and the app keeps corrections
locally — the behaviour it had before the endpoint existed. Setting it up:

1. **Storage & Databases → D1** → create a database.
2. **Pages project → Settings → Bindings** → add a D1 binding named `DB`, for
   Production *and* Preview.
3. Run `db/schema.sql` in the D1 console.

`tools/test/test_feedback.mjs` covers the endpoint and the queue without a network or
a database.

## Filename cleanup

Three operations, each reported in the log rather than done silently:
underscores become spaces, repeated spaces collapse, and a trailing run of five
or more digits — the id download services append — is dropped.

The list is short because it was derived from 2100 real filenames in the
library rather than from intuition. Stripping a leading number as a track index
looked obvious and turned out to be destructive: both filenames matching that
pattern were real titles, `4 x 4 - JUJO` and `2 OU - 3 Robots`. Years, `Vol. 44`,
`Pt.1` and `202 bpm` also occur in genuine titles and are left alone.

### Russian written in Latin script

Restoring Cyrillic is done **only** from a MusicBrainz match, which is evidence
that a Cyrillic title actually exists. `Khaski_-_Pulya_dura_81423717` becomes
`Хаски - Пуля-дура` that way.

Converting automatically from the text alone was built and rejected. A
character-bigram model trained on 1780 Cyrillic filenames against 13478 Latin
ones reached 52% recall at a 1.7% false-positive rate — which across the library
would have turned roughly 230 correct English names into Cyrillic nonsense.
`Noisia - Stigma` scored as Russian. No threshold gave both useful recall and a
safe error rate.

What remains is a note in the log when a name reads like transliteration and the
lookup found nothing: 30% of transliterated names are flagged, with 2.3% of
Latin names flagged spuriously. That ratio is acceptable for a line of text and
would not have been acceptable for renaming a file.

#### Quality of the back-conversion

The Latin form is converted to Cyrillic to make a **second search query**, never
a name. So the standard is not exactness but whether MusicBrainz's fuzzy search
can work with the result.

Measured over 318 Cyrillic artist and title strings from 19 artists, each
written out with this project's own `toAscii()` and read back:

| | exact | badly wrong (<0.95) |
|---|---|---|
| letter table alone | 66.4% | 27.4% |
| + "й" recovered from a bare "i" | 72.3% | 19.8% |
| + Latin version markers left alone | **74.8%** | **16.4%** |

Two systematic faults were behind most of it.

**"й" arrives as "i".** The table already read "ay/oy/ey/uy" as "ай/ой/ей/уй",
added from filenames where someone wrote "й" as "y" — but `toAscii` writes "й"
as "i", so this project's own round trip never produced those forms. "Voina",
"Maika" and "Dai" came back as Воина, Маика, Даи. The replacement is positional
rather than absolute, because "i" is genuinely ambiguous: Война and Наизнанку
are indistinguishable to a letter map. Converting a vowel+"i" that ends a word
or precedes a consonant is wrong sometimes — Наизнанку becomes Найзнанку — and
wrong less often than leaving it.

**Version markers are Latin even on Russian releases.** "(Izzamuzzic remix)"
came back as "(Иззамуззиц ремиx)". A bracket containing a known marker is now
left as it is. Only marked brackets, not all of them: "Южная ночь (Звери vs.
Nikotin)" has a Cyrillic artist inside the brackets too, and skipping every
bracket lost it — 74.8% against 73.6%.

What a letter table still cannot do: "э" and "е" both come back as "е" (Поэт →
Поет), "ё" loses its diaeresis in `toAscii` before the conversion ever starts,
and a soft sign vanishes entirely (ночь → ноч). These need the word, not the
letter. They matter less than they look: every one of the 38 titles in
`tools/test/test_translit.mjs` still lands within 0.8 similarity of the original,
which is what a fuzzy search needs.

**A missing record is the more common failure.** A track this was first
investigated on — "Она танцует под Шадэ" by By Индия, Xcho and МОТ — is not in
MusicBrainz at all, under any spelling; Xcho and Мот are, the recording is not.
No amount of transliteration reaches a record that does not exist, and it is
worth checking which of the two problems is in play before treating a lookup
failure as a conversion failure.

## Matching titles

Candidate titles are compared twice: once with version markers stripped, and
once in full. The stripped comparison is the gate, the full one only breaks
ties.

**The file's own version marker survives renaming.** Because the lookup matches
on the song rather than the version, the recording it finds is frequently a
different mix. Taking that recording's title wholesale rewrites history:
measured on a real batch, `Milkshake (nikko Remix)` was renamed to `Milkshake
(Kiko remix)`, `Monophobia (Teez & Stevie G Remix)` to `Monophobia (ATTLAS
remix)`, and two tracks lost their remix marker entirely and came out looking
like the originals. For a DJ library that is worse than not renaming at all. The
canonical spelling of the artist and song is still adopted — that is what fixes
transliterated and mangled filenames — but the version comes from the file.

Comparing full titles alone is actively misleading, because boilerplate like
"(Extended Mix)" is shared between unrelated tracks and swamps the part that
names the song. The failure that forced this: `Everyday VIP (Extended Mix)`
scored **0.70** against `ANITA (extended mix)` — a different track by the same
artist — but only **0.65** against its own correct match. The shared suffix
outvoted the title and the file was renamed to the wrong song. Stripped, the
comparison is `Everyday VIP` vs `ANITA`, which fails at 0.24.

Brackets are only removed when they contain a version marker, so `(Reprise)` or
`(Part 2)` still distinguish tracks.

**Genre lookups need network and are rate limited.** MusicBrainz permits one
request per second, so a large batch with lookups enabled is slow. Turn them off
to run fully offline against audio analysis alone. Rate-limit responses (HTTP
503) are retried and, if they still fail, reported in the log — they are not
silently reported as "no match".

## Genre resolution

`resolveGenreFrom` in `js/identify.js`, in order. Each stage is skipped if it has
nothing to say:

1. **The user's own correction** — nothing overrules what they fixed by hand.
2. **A remix goes to the remixer**: Discogs for the remix release itself, then
   the remixer's Last.fm and MusicBrainz tags. The original artist is not
   consulted at all.
3. **Discogs** — per-release styles, the finest-grained source there is. A
   Hip-Hop answer is split into old and new by the earliest release year.
4. **MusicBrainz recording tags.**
5. **Last.fm track tags.**
6. **The file's own tag.**
7. **Last.fm, then MusicBrainz, artist tags.** These describe a career rather
   than the track, and measured at 22.5% against 37.2% for the stages above, so
   the table marks them `?`.
8. **Unknown.** There is no audio fallback — see "Relationship to the Python
   version".

With online lookups switched off, the file tag leads instead, since nothing
better is available.

Three rules shape this, all from measurement rather than guesswork:

**The file tag is not evidence when anything better exists.** An earlier version
trusted a specific-looking tag immediately, on the theory that `deep house` in a
file means something. It does not survive a real library: Pharoahe Monch's
"Simon Says", a 1999 hip-hop record, ships tagged `Dubstep` and was filed under
Dubstep; a Calvin Harris house track ships tagged `Pop`. A careless tag is
indistinguishable from a curated one by inspection, so the tag now waits its
turn.

**Tags that are not genres never reach the map.** A map of more than 6700 entries inevitably
collides with non-genre vocabulary. Last.fm's top tags for the artist "СДП" are
`["russian", "AI", "#russian", "european"]`, and `ai` — a marker for
AI-generated music — happened to map to Pop, so a Russian track was filed as Pop
on the strength of a tag saying nothing about genre. Nationalities, decades,
`seen live`, `favorites` and similar are blocked outright.

**A remix belongs to the remixer, not the original artist.** When the title
names a remixer, their tags are consulted before the original artist's. Artist
tags are accurate about the artist and useless about the file: an Aerosmith
track flipped into dubstep was filed as blues rock, Billie Eilish remixed by
Skrillex as pop, and a TLC track remixed by nikko as soul. With the remixer
consulted first those become Dubstep, Dubstep and Hip-Hop. An obscure remixer
that neither service knows still falls through to the original artist, which is
the best available answer rather than a wrong one.

**Artist-level tags prefer a specific category over an umbrella one.** The
most-voted artist tag describes a whole career, so it skews broad — Calvin
Harris's top tag is `dance-pop`, but the same list holds `electro house`. For
sorting a DJ library, House is a far more useful shelf than Pop, and this stage
is already a coarse fallback.

Both MusicBrainz and Last.fm artist lookups are cached per artist, since a
library usually holds several tracks each and every lookup costs a rate-limited
second.

**A Last.fm API key matters more than it looks.** It is free and instant from
last.fm/api. Without it, tracks whose MusicBrainz recording carries no genres —
which is most recent dance music — fall through to artist-level tags or to audio
analysis. The key is remembered in `localStorage`, so it is entered once.

Note that a key placed in client-side code is visible to anyone who loads the
page. That is fine for a local or personal deployment; for a public one, use a
key you are willing to have read.

## Genre map

`data/genres_map.json` maps 6712 tags onto 53 categories — the distinctions a DJ
keeps as separate shelves rather than the ones a general music library uses:

    Afro House  Afrobeats  Amapiano  Baile Funk  Bass House  Blues  Boom Bap
    Breakbeat  Classical  Deep House  Disco  Drill  Drum & Bass  Dubstep
    Electro / Big Room  Electronic  Funk / Soul  Funky / Disco House
    Future / Slap House  Future Bass  Ghetto House / Juke  Grime  Hard Techno
    Hardcore  Hardstyle  Hip-Hop  House  Indie Dance  Jazz  Jersey Club  Jungle
    Latin House  Liquid DnB  Melodic House  Melodic Techno  Minimal / Deep Tech
    Moombahton  Neurofunk  Nu Disco  Phonk  Pop  Progressive House  Psytrance
    Reggae / Dancehall  Reggaeton  Riddim  Rock  Soulful House  Tech House
    Techno  Trance  Trap  UK Garage

`Old School Hip-Hop` is a 54th, produced by the era split rather than the map.

The source is a general-purpose tag list in which most tags point at Pop and
almost none at house subgenres. `tools/build/build_genres.py` rewrites the
values by ordered rules — the first match wins, so `deep tech house` is read as
tech house before the bare `house` rule sees it. Nu Disco, Soulful House and
Grime were split out after measuring against the owner's folders, where each has
a shelf of its own and had been filed into Funky / Disco House or Hip-Hop.

## Browser support

- **Folder selection** uses `webkitdirectory`, which iOS Safari does not
  support. The app detects this, hides the folder button, and tells the user to
  select files directly.
- **Ogg/Opus** cannot be decoded by Safari at all, and **FLAC** support is
  inconsistent on older Safari. Both produce a clear per-file message naming the
  format and suggesting a conversion; the rest of the batch continues.
- **Decoding stays on the main thread** because `decodeAudioData` is not
  available inside a Worker on Safari. It is native code and fast; everything
  actually expensive runs in the Worker.
- **The `AudioContext` is created inside the Start click handler**, so Safari's
  autoplay policy does not suspend it.
- Up to four files are processed at once, sized from `hardwareConcurrency` and
  capped for memory: decoded audio is 32-bit floats per channel, so an hour of
  stereo takes about 1.4 GB whatever it weighed on disk. Buffers are released
  after each file. Very large batches are still bounded by the ZIP being
  assembled in memory.

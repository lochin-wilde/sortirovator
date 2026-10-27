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

### Name at sign-in

The form asks for a name or nickname before the code, so that accounts can
later be built on it without asking every tester again. The middleware
normalises it (`cleanName`: 2–40 characters, single spaces), carries it in the
signed session next to the invite label, and records one row per invite and
name in the D1 table `members` — first and last sign-in and a count. The app
shows it beside "Sign out" (`/api/whoami`). A missing name answers 400 and is
not counted as a guess. The table comes from `db/migrations/0003_members.sql`;
until that is applied, sign-in works and nothing is recorded. Sessions issued
before this carry no name and keep working. The landing says the name is kept.

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
| `js/dsp.js` | FFT, onset/tempogram BPM, CQT chroma key (the fallback) |
| `js/beatgrid.js` | Beat grid: kick-band onset envelope, comb fit to 0.01 BPM, half-beat choice (kick, then bars) and confidence models |
| `js/downbeat.js` | Which beat starts the bar: beat-synchronous band energy and chroma change, softmax over the four phases; bar contrast between half-beat grids for beatgrid.js |
| `js/keycnn.js` | Key network: madmom's spectrogram and Korzeniowski & Widmer's CNN, ported for inference; weights in `data/key_cnn.bin` (CC BY-NC-SA 4.0) |
| `js/loudness.js` | ITU-R BS.1770 loudness, true peak, limiter, silence trim, resampler, WAV/MP3 encoders |
| `js/tags.js` | Reads ID3v2, Vorbis comments and MP4 ilst; writes ID3v2.4 into MP3 and WAV |
| `js/rekordbox.js` | Reads a Rekordbox collection export and writes an XML to import back, holding only the tracks whose genre changed |
| `js/identify.js` | Filename parsing, transliteration, fuzzy matching, iTunes, Discogs, MusicBrainz and Last.fm lookups, and the genre decision itself (`resolveGenreFrom`) |
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
| **Key** | 4523 | **66.3%** exact, **85.3%** exact, relative or one step round the Camelot wheel — the network in `js/keycnn.js`. On GiantSteps-key, 604 tracks keyed by listeners: **67.5%** exact |
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

Major keys. The chroma detector found 15% of them — its minor bias scores by
the base rate, since dance music is about nine-tenths minor. The network finds
about 40% (40.7% of 442 library majors, 39.8% of 93 on GiantSteps), at the
cost of calling some minor tracks major: library minor exact fell from 70.4%
to 69.1%. Major keys are still where most of the remaining gap is.

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

### Beat grid

`js/beatgrid.js`, measured by `tools/measure/measure_grid.mjs` against every
beat in Rekordbox's own analysis files (`rekordbox_anlz.py --grids`), and
against the Serato grids already inside the library's MP3s.

**Method.** Onset envelope of the kick band (30–150 Hz, 6 ms hops), a comb
fitted over the analysed two minutes: every candidate period within ±1.5 BPM
of the detected tempo and every phase, the grid landing on the most kick
energy winning, then refined to 0.002 BPM and rounded to 0.01. A full-band
envelope was tried first and locked onto off-beat hats and bass about a
quarter of the time.

**Tempo over the whole track.** Two minutes are a short lever: 127.96 and
128.00 BPM put the beats there at most 40 ms apart, but 110 ms apart by the end
of a six-minute track. So the comb is run once more over the whole track
(`wholeTrackTempo`), sent to the worker at 11 kHz — the kick band ends at
150 Hz, and the same bin width and 6 ms hops cost a quarter of the work there
— for tempos within ±0.1 BPM of the fit. Only the tempo is taken; the phase and
every decision about it stay with the first two minutes. Taking the whole
track's phase as well fixed 44 held-out grids and broke 46, and snapping to a
whole BPM — Rekordbox's tempo is whole on 83% of one-tempo tracks, ours was on
40% — did nothing useful at any gate (`tools/measure/grid_tempo.mjs`, rules
chosen on the train half). With the tempo alone, held-out grids that are good
go from 77.5% to 78.8% (McNemar 29 fixed, 4 broken, χ² = 17.5); of the grids
it writes, 8 fixed and none broken; on tracks whose Rekordbox tempo moves,
2 fixed, 1 broken.

**Half a beat out** remains the main failure — 15% of grids on the train half,
in every genre: below 150 Hz an off-beat bass has as much onset energy as the
kick. One logistic model picks between the two half-beat grids from three kinds
of evidence. The kick: eight frequency bands' on/off evidence and the kick
averaged over every beat, itself a small model that on its own gains little
over never flipping. The bars: a bar starts on a beat, so the grid on the beat
should show sharper bar boundaries (`barContrast` in `js/downbeat.js`, the
same per-phase features the downbeat uses). And the shape of the beat: per
band, the onset envelope and the level averaged by where in the beat each
frame falls, compared with the same half a beat on (`beatShapeContrast`) — the
kick's click and the sidechain dip after it, the hat or bass between beats, a
clap on every other one. On held-out tracks where one phase is good and the
other not, it is right on 90.8% against 88.8% for kick and bars alone; over
every grid, good ones go from 78.5% to 80.3% (McNemar 58 fixed, 18 broken,
χ² = 20). Kick and bars refitted without the shape stay at 89.0%; the shape
over the whole track does no better than over two minutes, nor 16 bins per
beat better than 8 (`tools/measure/grid_halfbeat.mjs`, chosen on the train
half). The shape features are clamped near the library's extremes: a band
silent between hits gives ratios no music shows. A synthetic track whose kick
is a bare sine and whose off-beat is noise across the mids is read as a clap
on the beat — a real track built that way would be too. The step before, bars
on top of the kick: 74.3% to 77.3% good (McNemar 97 fixed, 28 broken).

A second model scores confidence from the fit, the phase choice's certainty
and the tempo detector's range; below 0.82 the grid is withheld as "the beat
is ambiguous". Refitted on grids with the whole-track tempo and the new phase
choice, it ranks them better: at the same threshold, held-out grids are
written for 60.8% of tracks against 49.8%, 90.5% of them good against 90.7%.
The rule used before — the lowest threshold that keeps the train half's
accuracy — would have given 0.76: 73.8% written, 88.6% good. The threshold
stayed: a wrong grid costs a DJ more than a missing one. Both models are
fitted by `grid_halfbeat.mjs --fit` from its dump, which also scores the
shipped `gridDecision` on the same rows; the kick model by
`tools/measure/grid_models.mjs` from `tools/measure/grid_features.mjs`.
Averaging the kick across all beats to locate its onset more precisely did not
narrow the spread and was dropped.

**Timelines.** The browser and ffmpeg decode MP3s sample-identically (checked
on all three header types, 44.1 and 48 kHz). Rekordbox and Serato do not trim
LAME's encoder delay, so on LAME MP3s their beats sit later than ours: Serato
by about 47 ms (from 699 Serato grids in the files), Rekordbox by 17–45 ms
depending on the file. Without a LAME header all three agree within ~5 ms.
`gridOffsetFor` in `tags.js` holds the numbers.

**Held-out half** (2057 one-tempo tracks; nothing was chosen on them):

| | Before: whole BPM, best phase | Every grid | Grids it writes (60%) |
|---|---|---|---|
| F-measure ≥ 0.8 vs Rekordbox | 54.6% | 80.7% | **90.9%** |
| BPM within 0.01 of Rekordbox | 68.6% | 80.7% | 81.6% |
| BPM within 0.05 of Rekordbox | 75.9% | 91.4% | 92.9% |
| Off by > 70 ms at the end | 37.2% | 14.2% | 7.5% |

McNemar on F ≥ 0.8, before against every grid: 609 fixed, 74 broken, χ² = 418.
Before the beat's shape these were 78.8% and 91.1% of 49% written (the shape:
57 fixed, 18 broken, χ² = 19; of the grids both versions write, 2 fixed, none
broken); with the tempo from two minutes only as well, 77.5% and 90.4%
(BPM within 0.01: 69.5% and 71.9%; off at the end: 18.4% and 9.6%); without
the bar evidence either, 74.3% and 89.8% of 47% written. Tempo and grid take a
median 4.7 s per track in Node: 0.5 s for the whole-track tempo, 0.7 s for the
bar features, which run on every track, not only those given a grid.
Against the Serato grids in held-out files, the grids it wrote before the bar
evidence were within 20 ms in 77.9% and within 70 ms in 91.5%, median 8.9 ms.

**Moving tempo.** The tempo detector's "dynamic" verdict used to withhold a
grid outright. It withheld good grids about as often as bad ones, so it is now
one input of the confidence model, and the "tempo moves" reason is given only
when that model withholds the grid as well. Of the 188 held-out tracks whose
Rekordbox grid changes tempo, 127 get a grid (103 before the beat's shape, 97
before the bars), 110 of them good.

**Not solved.** Confidence separates good grids from bad ones only so far:
writing more costs accuracy — at a threshold of 0.80, 65.7% of held-out tracks
and 89.8% good; at 0.76, 73.8% and 88.6%. And most half-beat errors remain:
where one phase is good, the wrong one is still picked on 9.2% of held-out
tracks, against 11.2% before the shape.

**Bars.** `js/downbeat.js` picks which of the first four beats starts a bar:
per beat, eight band energies and a chroma; per candidate phase, how much they
change across the beat and the bar it would start, on average and at the
largest changes, and how hard the kick and the top end hit — relative to the
other three phases, scored by a softmax fitted on the train half against
Rekordbox's bar numbers (`tools/measure/measure_downbeat.mjs`). On held-out
grids it writes, the bar starts where Rekordbox's does for 88.3% of tracks,
against 68.2% for "the first beat starts a bar" (McNemar 188 fixed, 14 broken).
It goes into `rekordbox.xml` as `Battito`; the Serato tag has no place for it.

**Rekordbox.** CDJs read grids from Rekordbox, not from the file, so the archive
can carry a `rekordbox.xml` (`buildGridImport` in `js/rekordbox.js`): a TRACK
per gridded MP3 or WAV with one `TEMPO` (Inizio, Bpm, Metro 4/4, Battito 1), in
a playlist to drag into the collection. Rekordbox finds files by absolute path,
which a browser cannot know, so the user types the folder the archive will be
unpacked into and the page shows where the first track will be looked for. It
is for new tracks only: Rekordbox matches an imported track by Location and
replaces it, so the archive goes into a new folder, and any Location a loaded
collection export already holds is left out. On held-out tracks the first beat
it writes is within 20 ms of Rekordbox's own grid for 71%, within 50 ms for
91%, median 12 ms — LAME MP3s are the spread, where Rekordbox's delay varies
between about 17 and 45 ms from file to file.

### Key

**The key comes from a convolutional network** — Korzeniowski & Widmer,
"Genre-Agnostic Key Classification with Convolutional Neural Networks" (ISMIR
2018), trained by its authors and shipped in madmom. `js/keycnn.js` ports the
inference: madmom's log-filtered spectrogram (8192-sample frames, 5 per
second, 24 triangular bands per octave from 65 to 2100 Hz, log10(1 + x)), then
nine convolutions with batch norm and ELU, a mean over time and frequency, and
softmax over 24 keys. On madmom's own test files the port matches its stored
outputs to 3e-7. The weights, `data/key_cnn.bin`, are CC BY-NC-SA 4.0
(`data/KEY_CNN_LICENSE.txt`); `tools/build/convert_key_cnn.py` makes them from
the authors' pickle without executing it.

Measured against the chroma detector below, McNemar on exact matches:

| | Chroma | Network | Fixed / broken |
|---|---|---|---|
| GiantSteps-key, 604 (not in the network's training data) | 57.8% | **67.5%** | 99 / 40, p = 9e-7 |
| Library held-out half, 2327 (Rekordbox's labels) | 64.1% | 64.8% | 309 / 291, p = 0.49 |
| Library held-out half, compatible | 79.8% | **84.5%** | 252 / 143, p = 6e-8 |

The library half was the guard, not the target: its labels are Rekordbox's
own detector, so a better detector need not agree with it more often. It had to
not get worse, and it did not.

It costs time: about 3.5 s a track in a browser against 0.3 s for the chroma,
which is why it runs in the worker beside everything else. Its top probability
gates the `?` at 0.5, chosen on the library's train half: there 78% of
confident answers were exact against 41% of the rest. A guess is shown with
the runner-up key, which on GiantSteps is the right one for 37% of the
network's mistakes.

If the weights cannot be loaded, the worker falls back to the chroma detector,
so a missing file costs accuracy, never the batch.

**What did not help the chroma detector**, each measured on the held-out half
and GiantSteps before the network was tried, and kept under
`tools/measure/key_variants/` and `tools/measure/try_key_*.mjs`: Essentia's EDM
profiles (edma, bgate, braw) and the classic ones (all significantly worse),
tuning correction, segment voting, other analysis windows, HPSS, folding in the
bass octave, dropping the top octave. None was significantly better on both.

#### The chroma detector (fallback)

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

#### The chroma detector's confidence

The gate is 0.50. Correct answers average 0.687 and wrong ones 0.492, so the
score carries real information, but the distributions overlap and no threshold
separates them cleanly. At 0.50, 90 of 103 correct answers are marked confident
and 19 of 27 wrong ones are demoted. Nothing is discarded either way — a weak
result is shown as `8A?` with its score, because a labelled guess beats a blank
field when you are checking a set.

**Analysis window is capped at 120 seconds.** The Python version analyses the
whole file for BPM and key. Both are stable well inside that window and the cap
keeps a batch usable in a browser. Loudness still measures the entire file,
since that is a measurement rather than an estimate. The beat grid's tempo is
the one exception: a grid has to hold to the last beat, so it is refined over
the whole track, sent to the worker at 11 kHz (see Beat grid).

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
two minutes of 44.1 kHz stereo, plus about 16 MB for a six-minute track at
11 kHz for the grid's tempo — and one core is left free so the interface stays
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
3. Run `db/schema.sql` in the D1 console. An existing database is brought up to
   date with the files in `db/migrations/` instead, each applied once:
   `npx wrangler d1 execute <database-name> --remote --file=db/migrations/0002_usage.sql`.

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
8. **iTunes' store genre** for the song identification matched — only a
   specific one (House, Garage, Dubstep, Breakbeat), never Dance, Electronic or
   Pop, which is where most of a dance library sits. Also marked `?`. It gave a
   genre to 23 of the 141 tracks out of 309 that ended at Unknown before.
9. **Unknown.** There is no audio fallback — see "Relationship to the Python
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

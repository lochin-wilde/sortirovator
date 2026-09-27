# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

«Музыкальный сортир» sorts a DJ library in the browser: cleans file names, detects
tempo and key, resolves genre via online lookups, normalises loudness, writes tags,
and returns a ZIP with folders and `.m3u8` playlists. It can also fill genres into a
Rekordbox collection via XML. Live at https://sortirovator.pages.dev (public landing,
app behind invite codes). The owner is a DJ and writes in Russian; code, comments and
commit messages are in English, UI strings in both.

## Commands

```bash
sh tools/test_all.sh                      # every test in tools/test/, no network/DB/browser, seconds
node tools/test/test_gate.mjs             # one test; run from the repo root (tests read files by relative path)
cd web && python3 -m http.server 8777     # run locally; no gate locally, file:// does not work
python3 tools/build/build_genres.py tools/build/genres_map.source.json web/data/genres_map.json
.venv/bin/python tools/build/make_og_image.py   # regenerate web/og.png
python3 -m venv .venv && .venv/bin/pip install pyrekordbox Pillow   # .venv is gitignored; needed only for make_og_image.py and rekordbox_db.py
node tools/build/make_invite_codes.mjs "Name" …  # prints codes + INVITE_CODES JSON + a SESSION_SECRET
```

No build step, bundler, linter or package.json. Deploy = `git push origin main`;
Cloudflare Pages builds from `main` (output dir `web`, plus `functions/`).

**Bump the version on every client-side change**: the literal (e.g. `2026.09.28.4`)
lives in `APP_VERSION` in `web/js/app.js` and in every `?v=` in `web/index.html` and
`web/admin.html` — `sed -i '' 's/OLD/NEW/g'` over those three. The worker takes its
version from its own URL and passes it to `importScripts`, so it follows automatically.
Skipping the bump ships new HTML with stale cached JS. `landing.html` has no `?v=`.

Everything except `/` is behind the gate, so a deploy cannot be checked from outside
beyond HTTP codes; the version shows in the app footer after signing in. Cloudflare
edges lag: two requests right after a push can return different builds.

## Architecture

**Browser-only processing.** Audio never leaves the browser. The only outbound data is
artist + title text to Discogs, MusicBrainz and Last.fm (for genre). Never write copy
claiming "nothing is sent" — the owner had that removed. Because the ZIP is built
client-side, there is no server call behind the download: a public "trial" cannot be
gated, which is why the app stays behind invite codes and only the landing is public.

**Pipeline** (`web/js/app.js`, `processFile`): decode on the main thread
(`decodeAudioData` is unavailable in Safari workers) → up to 4 workers
(`worker.js` running `dsp.js` + `loudness.js`) for tempo/key/loudness/render →
genre via `resolveGenreFrom` → `tagOutput` writes ID3 → file into the ZIP →
after the batch `writePlaylists` adds `Playlists/*.m3u8`. `identify.js`,
`rekordbox.js` and `jszip` load lazily via `loadScriptOnce` when first needed.

**Plain scripts, not modules.** Every `web/js/*.js` file is a classic script sharing
globals. Tests reach inside them by evaluating the file with `new Function(src +
"return {…}")` or by lifting a single function out of `app.js` by name (see the `cut`
helpers in `tools/test/`) — `app.js` itself touches the DOM at load and cannot be
evaluated whole. Pure logic therefore belongs in `identify.js`, `tags.js`,
`rekordbox.js`, `dsp.js`, where it can be tested.

**Genre decision** is `resolveGenreFrom(context, deps)` in `identify.js` (moved out of
`app.js` so it can be measured without a browser). Order: user correction → remix goes
to the remixer (Discogs remix release, then remixer's Last.fm/MusicBrainz tags, never
the original artist) → Discogs (Hip-Hop split into Old School by earliest release
year) → MusicBrainz recording → Last.fm track → file's own tag → Last.fm then
MusicBrainz *artist* tags (returned with `weak: true`, shown as `?`) → `Unknown`.
There is deliberately no audio-based fallback: the old centroid classifier was 0/143
right and was deleted. Artist/title come from the file's ID3 tags first, filename
second (`usableTag`, `parseFilename` — which detects "Title - Artist" order).
`web/data/genres_map.json` maps 6712 tags → 53 categories and is generated — a test
fails if it differs from a fresh build.

**Tag writing** (`tags.js` `writeTags`): ID3v2.4 into MP3 (prepended) and WAV (`id3 `
chunk); FLAC/M4A pass through untouched. Existing frames are carried across
(`framesToCarryOver`) — cover art, Serato GEOB beat grids — and only frames actually
being written are replaced. v2.2, unsynchronised tags and flagged frames are skipped,
not copied. `TKEY` holds Camelot (`8A`), not spec notation, on purpose.

**Rekordbox exchange** (`rekordbox.js`, UI in step 4): reads a collection export with a
quote-aware scanner (not DOMParser — needs exact byte offsets and must run in Node
tests), resolves genres from `Artist`/`Name` (no audio), and `buildGenreImport` emits
an XML containing **only the changed tracks, each copied byte-for-byte from the export
with only `Genre` altered**, plus a playlist. This is a safety property: Rekordbox
import replaces an existing track wholesale (grid, cues, rating), so extra tracks or
any other altered attribute would silently roll the user's data back. Every change is
shown with a checkbox before download; `weak` answers arrive unticked. In Rekordbox the
user must select the *tracks* (not the playlist) → Import To Collection.

**Gate and public surface** (`functions/_middleware.js`, deliberately ASCII-only with
`\u` escapes): HMAC-signed HttpOnly session cookie, D1-backed login rate limit, POST
`/logout`. Missing `SESSION_SECRET`/`INVITE_CODES` → 503, never open. `INVITE_CODES` is
JSON `{"CODE": "label"}` or `{"CODE": {"label": "…", "role": "admin"}}`. Unauthenticated
GET `/` and `/index.html` get `landing.html` via a rewrite that is only served if the body
contains the landing's marker meta tag; `/og.png` is only served if the response is
`image/*`; `/robots.txt` is generated inline. Anything else → 401 login page. The failure
direction must stay closed: if a rewrite returns something unexpected, show the login page,
not what came back. `/api/admin/feedback` re-checks `role === "admin"` itself.

**Design system**: `web/css/styles.css` tokens (dark default, light via
`prefers-color-scheme`). `landing.html` and `loginPage()` cannot link it (the gate would
serve the login page instead), so they copy the tokens verbatim; `test_style.mjs` fails
on any drift or off-palette colour, and checks `make_og_image.py` too. Change a colour in
`styles.css` first, then the copies.

## Measuring accuracy

Ground truth is the owner's Rekordbox library on an external drive
(`/Volumes/HomeSSD/Lochin`, must be mounted): tempo and key from Rekordbox's database,
genre from the folders tracks were filed into by hand. The database is encrypted
(SQLCipher); `tools/groundtruth/rekordbox_db.py` reads it through pyrekordbox in `.venv`,
**always from a temporary copy** — never open the live `master.db`.

```bash
python3 tools/groundtruth/rekordbox_anlz.py && .venv/bin/python tools/groundtruth/rekordbox_db.py \
  && python3 tools/groundtruth/match_tracks.py
node tools/measure/measure_bpm.mjs     # ~10 min; --limit N --jobs N --seed N; --rescore relabels saved results
node tools/measure/measure_key.mjs     # ~10 min
LASTFM_KEY=… node tools/measure/measure_genre.mjs --per-folder 25   # ~40 min, network-bound, paired A/B when a key is set
```

Results go to `ground-truth/` (gitignored — it describes a private library; never commit
it). Current baseline: tempo 93.4% within ±1 BPM (4459 tracks), key 65.0% exact /
80.8% mixable (4523), genre 20.5% exact on 375 tracks (25 per folder).

Rules that came out of getting this wrong:
- **Change an algorithm only on held-out evidence.** Choose parameters on half the tracks,
  test on the other half, and use a paired McNemar test (`sweep_key.mjs` shows the
  pattern). A best-of-many sweep always "improves" on the data it was tuned on.
- **Watch for degenerate wins.** Only ~9% of the library is in a major key; raising the
  minor bias scored higher by refusing to call major keys at all.
- **Averages move with library composition.** Key went 59.4%→65.0% with no code change
  because the new tracks were easier. Compare per folder, with the same ground truth.
- **Rekordbox is itself inconsistent**: it labels most 90s hip hop at double time (median
  176) — `BPM_PRIOR_CENTER = 140` matches that on purpose — and some at normal time. The
  analysis-file beat grid and the database disagree on ~150 tracks, almost all by exactly
  2×; the database (what the DJ sees) is the reference.
- The Rekordbox library has no energy field and set order barely tracks tempo
  (ρ +0.17), so "sort by energy" cannot be validated; the app sorts by loudness instead
  and says so.
- Node's `fetch` sends no User-Agent and MusicBrainz answers 403 without one — the
  genre harness adds one; don't mistake that for the service failing.

## Conventions

- Comments explain *why*, usually with the measurement that justified the choice; match
  that when changing behaviour, and update the number when it changes.
- Commit messages: English, an imperative summary line, a body explaining the reasoning
  and evidence, ending with the `Co-Authored-By` line.
- Tests: `tools/test/test_*.mjs`, labels in Russian, print `пройдено N/M`, exit non-zero
  on failure. A test that cannot fail is worthless — break the code once to see it catch.
- UI strings go in `web/js/i18n.js` in both `en` and `ru`; `applyTranslations` handles
  `data-i18n`, `data-i18n-placeholder`, `data-i18n-html`, `data-i18n-title`.
- Don't hand-edit generated files: `web/data/genres_map.json`, `web/og.png`. If the
  published figures change, update `landing.html` and regenerate `og.png`.
- Secrets live only in Cloudflare env vars and never in the repo, which is **public on
  GitHub**. The Last.fm key is passed via `LASTFM_KEY`, never written to a file.
- Another Claude session also edits this repo (it built the admin panel). `git fetch`
  before pushing; on merges check that `?v=` versions stayed consistent across all pages.
- `music-sorter-tauri/` is an abandoned earlier attempt and is gitignored.

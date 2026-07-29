"use strict";
/*
 * identify.js -- filename parsing, fuzzy matching and the MusicBrainz /
 * Last.fm lookups. This is a port of parse_filename(), _text_similarity(),
 * _try_identify(), identify_track(), search_musicbrainz() and search_lastfm().
 *
 * Runs on the main thread so a single rate limiter can cover the whole batch.
 */

/* ------------------------------------------------------------------ */
/* Filename parsing                                                    */
/* ------------------------------------------------------------------ */

const FILENAME_UNSAFE_CHARS = /[\\/:*?"<>|]/g;

function stripExtension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function fileExtension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot).toLowerCase() : "";
}

/*
 * Tidies a filename and reports every change, so nothing is altered silently.
 *
 * Only three operations are safe, and that was settled by looking at 2100 real
 * filenames from the library rather than by intuition:
 *
 *   underscores -> spaces          (27 files affected)
 *   collapse repeated spaces       (17 files)
 *   drop a trailing run of 5+ digits, which download services append (2 files)
 *
 * Deliberately *not* done: stripping leading numbers as track indices. Both
 * filenames that matched that pattern in the library -- "4 x 4 - JUJO" and
 * "2 OU - 3 Robots" -- were real titles, so the rule would have damaged them
 * and nothing else. Years, "Vol. 44", "Pt.1" and "202 bpm" all appear in
 * genuine titles too and are left alone.
 */
const CLEANUP_RULES = [
  { key: "clean.underscores", test: /_/, apply: (s) => s.replace(/_/g, " ") },
  { key: "clean.spaces", test: /\s{2,}/, apply: (s) => s.replace(/\s{2,}/g, " ") },
  { key: "clean.downloadId", test: /\s\d{5,}$/, apply: (s) => s.replace(/\s+\d{5,}$/, "") },
];

function cleanFilename(stem) {
  let text = String(stem || "");
  const changes = [];
  for (const rule of CLEANUP_RULES) {
    if (!rule.test.test(text)) continue;
    const next = rule.apply(text).trim();
    if (next && next !== text) {
      changes.push(rule.key);
      text = next;
    }
  }
  return { cleaned: text.trim(), changes };
}

/*
 * Flags a Latin-script name that reads like transliterated Russian.
 *
 * This only ever produces a note in the log. Rewriting the name automatically
 * was built and measured, and rejected: a character-bigram model trained on
 * 1780 Cyrillic filenames against 13478 Latin ones found 52% of transliterated
 * titles at a 1.7% false-positive rate, which over the whole library would have
 * turned roughly 230 correct English names into Cyrillic nonsense. "Noisia -
 * Stigma" scored as Russian. Restoring Cyrillic is left to the MusicBrainz
 * lookup, which converts only when a real Cyrillic title actually exists.
 *
 * The digraphs below barely occur in English but are the standard output of
 * Russian transliteration.
 */
const TRANSLIT_MARKERS = /(shch|zh|kh|jj|yj|ykh|ogo|ego|nye|sya|tsya|iya|yye)/gi;

function looksTransliterated(text) {
  if (/[а-яА-ЯёЁ]/.test(text)) return false;
  const words = String(text || "").split(/[\s\-_]+/).filter((w) => w.length > 2);
  if (words.length < 2) return false;
  /*
   * One marker is enough. Measured over the same 600 Russian and 1500 Latin
   * filenames: one marker flags 30% of transliterated names at a 2.3% false
   * positive rate, two markers only 5% at 0.1%. Since this produces a note and
   * never changes anything, catching six times as many is worth the occasional
   * spurious line, which costs the reader a glance.
   */
  const hits = (String(text).match(TRANSLIT_MARKERS) || []).length;
  return hits >= 1;
}

/*
 * Port of parse_filename(). Underscores are normalized to spaces first, since
 * several download sources replace every space in the name, and a trailing
 * 5-or-more digit run is stripped because those are internal download ids
 * rather than part of the title.
 */
function parseFilename(filename) {
  const name = stripExtension(filename);
  const normalized = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();

  let artist = null;
  let track = normalized;
  const separators = [" - ", " – ", " — ", " | ", " / "];
  for (const sep of separators) {
    const index = normalized.indexOf(sep);
    if (index >= 0) {
      artist = normalized.slice(0, index).trim();
      track = normalized.slice(index + sep.length).trim();
      break;
    }
  }

  track = track.replace(/\s+\d{5,}$/, "").trim();
  return { artist, track };
}

/* ------------------------------------------------------------------ */
/* Transliteration                                                     */
/* ------------------------------------------------------------------ */

// Cyrillic -> Latin, matching what unidecode produces. Used to bridge a
// Cyrillic MusicBrainz title against a Latin-transliterated filename.
const CYRILLIC_TO_LATIN = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e",
  "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k",
  "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
  "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
  "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
  "э": "e", "ю": "iu", "я": "ia",
};

// Latin -> Cyrillic, matching the "ru" pack of the Python transliterate
// package that the desktop version retries with. Longest keys must be tried
// first so "sch" wins over "s" + "ch".
const LATIN_TO_CYRILLIC = [
  ["shch", "щ"], ["sch", "щ"], ["zh", "ж"], ["ch", "ч"], ["sh", "ш"],
  ["ju", "ю"], ["ja", "я"], ["yu", "ю"], ["ya", "я"], ["kh", "х"],
  ["ts", "ц"], ["yo", "ё"], ["jj", "й"],
  ["a", "а"], ["b", "б"], ["v", "в"], ["g", "г"], ["d", "д"],
  ["e", "е"], ["z", "з"], ["i", "и"], ["j", "й"], ["k", "к"],
  ["l", "л"], ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"],
  ["r", "р"], ["s", "с"], ["t", "т"], ["u", "у"], ["f", "ф"],
  ["h", "х"], ["c", "ц"], ["y", "ы"],
];

// Rough equivalent of unidecode(): strip Latin diacritics, map Cyrillic.
function toAscii(text) {
  const decomposed = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  let out = "";
  for (const ch of decomposed) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC_TO_LATIN[lower];
    if (mapped !== undefined) {
      out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    } else {
      out += ch;
    }
  }
  return out;
}

function toCyrillic(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const [latin, cyrillic] of LATIN_TO_CYRILLIC) {
      const slice = text.substr(i, latin.length);
      if (slice.toLowerCase() === latin) {
        const isUpper = slice.charAt(0) !== slice.charAt(0).toLowerCase();
        out += isUpper ? cyrillic.toUpperCase() : cyrillic;
        i += latin.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text.charAt(i);
      i++;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fuzzy similarity (difflib.SequenceMatcher.sequenceRatio equivalent)         */
/* ------------------------------------------------------------------ */

function longestCommonSubstring(a, b) {
  let bestA = 0;
  let bestB = 0;
  let bestLength = 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current.fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > bestLength) {
          bestLength = current[j];
          bestA = i - current[j];
          bestB = j - current[j];
        }
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return { a: bestA, b: bestB, length: bestLength };
}

// Ratcliff-Obershelp matched-character count, which is what difflib's sequenceRatio()
// is built on: take the longest common substring, then recurse either side.
function matchedCharacters(a, b) {
  if (!a.length || !b.length) return 0;
  const match = longestCommonSubstring(a, b);
  if (match.length === 0) return 0;
  return (
    match.length +
    matchedCharacters(a.slice(0, match.a), b.slice(0, match.b)) +
    matchedCharacters(a.slice(match.a + match.length), b.slice(match.b + match.length))
  );
}

function sequenceRatio(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchedCharacters(a, b)) / total;
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^\w\s]|_/g, "").trim();
}

// Port of _text_similarity(): compare directly and via transliteration, keep
// whichever agrees more.
function textSimilarity(a, b) {
  const direct = sequenceRatio(normalizeForCompare(a), normalizeForCompare(b));
  const translit = sequenceRatio(normalizeForCompare(toAscii(a)), normalizeForCompare(toAscii(b)));
  return Math.max(direct, translit);
}

/* ------------------------------------------------------------------ */
/* Network lookups                                                     */
/* ------------------------------------------------------------------ */

/*
 * Umbrella tags that describe a whole shelf rather than a genre. Files ship
 * with these constantly -- a UK Garage track tagged "Pop" by whatever ripped
 * it is the case that prompted this list. They are still used, but only after
 * the online sources have had a chance to say something more specific.
 */
const GENERIC_FILE_TAGS = new Set([
  "pop", "rock", "dance", "electronic", "electronica", "electro", "edm",
  "other", "unknown", "misc", "miscellaneous", "music", "general", "club",
  "alternative", "indie", "world", "various", "soundtrack", "audio",
]);

/*
 * Tags that describe something other than genre and must never reach the genre
 * map, no matter what the map happens to contain.
 *
 * The map is a 6700-entry merge and inevitably holds a few entries that collide
 * with non-genre vocabulary. The one that surfaced: Last.fm's top tags for the
 * artist "СДП" are ["russian", "AI", "#russian", "european"], and "ai" -- a
 * marker for AI-generated music -- happens to map to Pop, so a Russian track
 * was filed as Pop on the strength of a tag that says nothing about genre.
 */
const NON_GENRE_TAGS = new Set([
  "ai", "ai generated", "ai music", "seen live", "favorites", "favourites",
  "favorite songs", "beautiful", "awesome", "cool", "love", "loved",
  "my music", "best", "good", "chill", "chillout music", "vocal",
  "male vocalists", "female vocalists", "male vocalist", "female vocalist",
  "instrumental music", "singer-songwriter music", "under 2000 listeners",
  "spotify", "youtube", "radio", "seen in concert", "home collection",
  // Language / nationality / era markers.
  "russian", "english", "american", "british", "german", "french", "spanish",
  "italian", "dutch", "swedish", "japanese", "korean", "chinese", "european",
  "scottish", "irish", "australian", "canadian", "brazilian", "usa", "uk", "us",
  "50s", "60s", "70s", "80s", "90s", "00s", "10s", "20s",
  "1980s", "1990s", "2000s", "2010s", "2020s",
]);

function isNonGenreTag(tag) {
  const text = String(tag || "").toLowerCase().trim().replace(/^#/, "");
  return text.length === 0 || NON_GENRE_TAGS.has(text);
}

// Single place every tag list is resolved through, so the blocklist cannot be
// bypassed by one call site forgetting it.
function firstMappedGenre(tags, genresMap, preferSpecific) {
  let fallback = null;
  for (const raw of tags) {
    const tag = String(raw || "").toLowerCase().trim().replace(/^#/, "");
    if (isNonGenreTag(tag)) continue;
    const genre = genresMap[tag];
    if (!genre) continue;
    if (!preferSpecific) return { genre, tag };
    if (!UMBRELLA_CATEGORIES.has(genre)) return { genre, tag };
    if (!fallback) fallback = { genre, tag };
  }
  return fallback;
}

const MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2";
const IDENTIFY_MIN_TITLE_SIMILARITY = 0.55;
const IDENTIFY_MIN_ARTIST_SIMILARITY = 0.5;
// Applied to the title with version markers stripped, where a near-exact match
// is a reasonable demand.
const IDENTIFY_MIN_CORE_TITLE_SIMILARITY = 0.72;

/*
 * Strips version markers -- "(Extended Mix)", "- Radio Edit", "feat. X" -- to
 * leave the title itself.
 *
 * Comparing full titles is actively misleading, because the boilerplate is
 * shared between unrelated tracks and swamps the part that identifies the song.
 * Measured on a real miss: "Everyday VIP (Extended Mix)" scored 0.70 against
 * "ANITA (extended mix)" -- a completely different track -- but only 0.65
 * against its own correct match "Everyday VIP". The shared suffix outvoted the
 * title, and the file was renamed to the wrong song. With the markers removed
 * the same comparison is "Everyday VIP" vs "ANITA", which fails immediately.
 */
const VERSION_MARKERS = /\b(extended|original|radio|club|instrumental|acoustic|live|remaster(ed)?|remix|rmx|edit|mix|version|dub|bootleg|rework|vip|mashup|flip|refix|redrum)\b/i;

/*
 * Splits a title into the song and the version it is.
 *
 * Both halves are needed and for opposite reasons. Matching has to ignore the
 * version, or shared boilerplate outvotes the actual title. Renaming has to
 * keep it, or a remix silently becomes some other remix.
 */
function splitTitle(title) {
  const original = String(title || "");
  const removed = [];
  let text = original;

  // Drop bracketed groups, but only when they look like version markers --
  // "(Reprise)" or "(Part 2)" genuinely distinguish tracks.
  text = text.replace(/[([][^)\]]*[)\]]/g, (group) => {
    if (!VERSION_MARKERS.test(group)) return group;
    removed.push(group.trim());
    return " ";
  });
  // Trailing " - Something Mix" behaves the same way as a bracketed marker.
  text = text.replace(/\s[-–—]\s[^-–—]*$/, (tail) => {
    if (!VERSION_MARKERS.test(tail)) return tail;
    removed.push("(" + tail.replace(/^\s*[-–—]\s*/, "").trim() + ")");
    return " ";
  });
  text = text.replace(/\s*\b(feat\.?|ft\.?|featuring|with)\b.*$/i, (tail) => {
    // The tail may already carry its own brackets, as in "... (ft Someone)"
    // where only the opening bracket was consumed above.
    const trimmed = tail.trim().replace(/^[([]/, "").replace(/[)\]]$/, "").trim();
    if (trimmed) removed.push("(" + trimmed + ")");
    return " ";
  });
  // Cutting mid-bracket ("... (ft Leven Kali)") leaves the opening bracket
  // behind, which then counts as a character difference in the comparison.
  text = text.replace(/[([\-–—,;:\s]+$/, "").replace(/^[)\]\-–—\s]+/, "");
  text = text.replace(/\s+/g, " ").trim();

  return {
    // Never return nothing: a title that is only a marker has to fall back.
    core: text || original,
    version: removed.join(" ").replace(/\s+/g, " ").trim(),
  };
}

function coreTitle(title) {
  return splitTitle(title).core;
}

/*
 * Pulls the remixer's name out of a version marker, or "" if there isn't one.
 *
 * This exists because a remix belongs to the remixer's genre, not the original
 * artist's, and artist-level tags describe the original. The batch that forced
 * it: an Aerosmith track flipped into dubstep was filed as blues rock, a Dean
 * Turnley big-band track remixed by Lushreds was filed as jazz, and Billie
 * Eilish remixed by Skrillex was filed as pop. In every case the tag was
 * accurate about the artist and useless about the file.
 */
const REMIX_KINDS = /\b(remix|rmx|mix|edit|flip|bootleg|rework|vip|mashup|version|dub|refix|redrum)\b/i;
const NON_REMIXER_WORDS = /^(extended|original|radio|club|instrumental|acoustic|live|remaster(ed)?|the|a|an|feat\.?|ft\.?|featuring|with)$/i;

function remixerFromTitle(title) {
  const { version } = splitTitle(title);
  if (!version || !REMIX_KINDS.test(version)) return "";

  // Take the last bracketed group: "(Radio Edit) (Lushreds Remix)" names the
  // remixer in the second, not the first.
  const groups = version.match(/\(([^)]*)\)/g) || [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const inner = groups[i].slice(1, -1);
    if (!REMIX_KINDS.test(inner)) continue;
    // Drop the kind word itself, leaving the name in front of it.
    const words = inner.replace(REMIX_KINDS, " ").replace(/\s+/g, " ").trim().split(" ");
    while (words.length && NON_REMIXER_WORDS.test(words[0])) words.shift();
    const name = words.join(" ").trim();
    // A bare "(Extended Mix)" names nobody; anything left is a credit.
    if (name.length >= 2) return name;
  }
  return "";
}

/*
 * Builds the title to rename to: MusicBrainz's spelling of the song, carrying
 * the file's own version marker rather than the matched recording's.
 *
 * The lookup deliberately matches on the song alone, so the recording it finds
 * is frequently a different version of it. Taking that recording's title
 * wholesale rewrites history: measured on a real batch, "Milkshake (nikko
 * Remix)" was renamed to "Milkshake (Kiko remix)", "Monophobia (Teez & Stevie G
 * Remix)" to "Monophobia (ATTLAS remix)", and two tracks lost their remix
 * marker entirely and came out looking like the originals. For a DJ library
 * that is worse than not renaming at all.
 *
 * The canonical spelling is still worth having -- it is what fixes
 * transliterated and mangled filenames -- so only the version is preserved.
 */
function mergeTitleVersion(originalTitle, matchedTitle) {
  const original = splitTitle(originalTitle);
  const matched = splitTitle(matchedTitle);
  if (!original.version) return matchedTitle;
  // Same version either way: nothing to preserve, take the canonical spelling.
  if (matched.version && textSimilarity(original.version, matched.version) >= 0.9) {
    return matchedTitle;
  }
  return (matched.core + " " + original.version).trim();
}

// MusicBrainz asks for at most one request per second. Everything funnels
// through this queue so the whole batch respects it.
let _lastRequestAt = 0;
let _requestChain = Promise.resolve();

function rateLimited(task) {
  const run = async () => {
    const wait = Math.max(0, 1000 - (Date.now() - _lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    _lastRequestAt = Date.now();
    return task();
  };
  _requestChain = _requestChain.then(run, run);
  return _requestChain;
}

/*
 * MusicBrainz answers 503 whenever its rate limiter thinks a client is going
 * too fast, and that reply is indistinguishable from "no such recording" if it
 * is swallowed. Retrying with a widening delay turns a transient throttle back
 * into a real answer instead of a silent miss.
 */
async function fetchJson(url, attempts) {
  const maxAttempts = attempts || 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.status === 503 || response.status === 429) {
        lastError = new Error("HTTP " + response.status + " (rate limited)");
        await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError || new Error("request failed");
}

// Set whenever a lookup fails so the caller can report it in the log rather
// than reporting a network problem as "no match found".
let lastLookupError = null;

// Same character set musicbrainzngs._escape_lucene_query() escapes.
function luceneEscape(text) {
  return text.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

async function searchMusicbrainzRecordings(artist, track, limit) {
  // musicbrainzngs builds "field:(value)", not "field:\"value\"". The
  // difference matters: a quoted phrase is matched exactly, so a slightly
  // imperfect transliteration such as "Корол" instead of "Король" finds
  // nothing, while the parenthesised form still matches. The Cyrillic retry
  // depends entirely on that tolerance.
  const query = "artist:(" + luceneEscape(artist) + ") AND recording:(" + luceneEscape(track) + ")";
  const url = MUSICBRAINZ_BASE + "/recording/?query=" + encodeURIComponent(query) +
    "&limit=" + (limit || 8) + "&fmt=json";
  try {
    const data = await rateLimited(() => fetchJson(url));
    return data.recordings || [];
  } catch (e) {
    lastLookupError = "MusicBrainz search failed: " + e.message;
    return [];
  }
}

/*
 * Collects both the curated `genres` list and the free-form `tags` list, most
 * voted first. MusicBrainz exposes these separately: `genres` is the moderated
 * vocabulary and is far more trustworthy, so it is returned ahead of the tags.
 * Ordering by vote count matters too -- taking whatever happened to come first
 * was picking noise over the community's actual answer.
 */
function extractGenreNames(entity) {
  const byCount = (list) =>
    (list || [])
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .map((item) => String(item.name || "").toLowerCase())
      .filter(Boolean);
  return byCount(entity.genres).concat(byCount(entity.tags));
}

async function musicbrainzRecordingTags(recordingId) {
  const url = MUSICBRAINZ_BASE + "/recording/" + recordingId + "?inc=tags+genres&fmt=json";
  try {
    const data = await rateLimited(() => fetchJson(url));
    return extractGenreNames(data);
  } catch (e) {
    lastLookupError = "MusicBrainz recording lookup failed: " + e.message;
    return [];
  }
}

/*
 * Artist-level genres, cached because a library usually holds several tracks
 * per artist and each lookup costs a rate-limited second.
 *
 * This exists because recording-level genres are usually empty in practice.
 * Checked directly against the track that prompted this: "Calvin Harris -
 * Blessings" has no genres at recording or release-group level, while the
 * artist carries electro house, edm, dance-pop and electropop. Artist genres
 * are broader than the track deserves, but they beat falling through to a
 * generic file tag.
 */
const _artistGenreCache = new Map();

async function musicbrainzArtistTags(artist) {
  const cacheKey = artist.toLowerCase();
  if (_artistGenreCache.has(cacheKey)) return _artistGenreCache.get(cacheKey);

  let names = [];
  try {
    const searchUrl = MUSICBRAINZ_BASE + "/artist/?query=" +
      encodeURIComponent("artist:(" + luceneEscape(artist) + ")") + "&limit=1&fmt=json";
    const found = await rateLimited(() => fetchJson(searchUrl));
    const candidate = (found.artists || [])[0];
    if (candidate && candidate.id && textSimilarity(artist, candidate.name || "") >= IDENTIFY_MIN_ARTIST_SIMILARITY) {
      const url = MUSICBRAINZ_BASE + "/artist/" + candidate.id + "?inc=tags+genres&fmt=json";
      const data = await rateLimited(() => fetchJson(url));
      names = extractGenreNames(data);
    }
  } catch (e) {
    lastLookupError = "MusicBrainz artist lookup failed: " + e.message;
  }
  _artistGenreCache.set(cacheKey, names);
  return names;
}

function recordingArtistName(recording) {
  const credit = recording["artist-credit"];
  if (Array.isArray(credit) && credit.length > 0) {
    const first = credit[0];
    if (first.artist && first.artist.name) return first.artist.name;
    if (first.name) return first.name;
  }
  return "";
}

/*
 * Port of _try_identify(). MusicBrainz's own relevance score is not a reliable
 * ranking signal here -- testing on the desktop version found correct matches
 * scoring below wrong same-artist compilation tracks -- so a batch of
 * candidates is fetched and ranked by our own title/artist similarity instead.
 */
async function tryIdentify(artist, track) {
  const recordings = await searchMusicbrainzRecordings(artist, track, 8);
  let best = null;
  let bestCombined = -1;

  for (const recording of recordings) {
    const canonicalTitle = recording.title || "";
    const canonicalArtist = recordingArtistName(recording);
    if (!canonicalTitle || !canonicalArtist) continue;

    const titleSimilarity = textSimilarity(track, canonicalTitle);
    const artistSimilarity = textSimilarity(artist, canonicalArtist);
    const coreSimilarity = textSimilarity(coreTitle(track), coreTitle(canonicalTitle));

    // The core title is the gate; the full title only breaks ties afterwards,
    // so that among genuine matches the one whose version marker also agrees
    // wins, without a shared marker ever creating a match on its own.
    if (coreSimilarity < IDENTIFY_MIN_CORE_TITLE_SIMILARITY) continue;
    if (titleSimilarity < IDENTIFY_MIN_TITLE_SIMILARITY) continue;
    if (artistSimilarity < IDENTIFY_MIN_ARTIST_SIMILARITY) continue;

    const combined = coreSimilarity * 2 + titleSimilarity + artistSimilarity;
    if (combined > bestCombined) {
      bestCombined = combined;
      best = {
        artist: canonicalArtist,
        title: canonicalTitle,
        id: recording.id,
        score: recording.score || 0,
        titleSimilarity: Math.round(titleSimilarity * 100) / 100,
        coreSimilarity: Math.round(coreSimilarity * 100) / 100,
        artistSimilarity: Math.round(artistSimilarity * 100) / 100,
      };
    }
  }
  return best;
}

/*
 * Port of identify_track(). A plain-ASCII filename is often a Latin
 * transliteration of a Cyrillic original, and MusicBrainz's own fuzzy search
 * does not bridge that gap, so the query is retried in Cyrillic before giving
 * up. The similarity gates still guard against a confident wrong match.
 */
async function identifyTrack(artist, track) {
  let match = await tryIdentify(artist, track);
  if (match) return match;

  const isAscii = (text) => /^[\x00-\x7F]*$/.test(text);
  if (isAscii(artist) && isAscii(track)) {
    match = await tryIdentify(toCyrillic(artist), toCyrillic(track));
    if (match) {
      match.viaTransliteration = true;
      return match;
    }
  }
  return null;
}

/*
 * Recording-level genre. When the track has already been identified, its
 * recording id is reused instead of searching again -- that saves a
 * rate-limited request and, more importantly, avoids re-running a search whose
 * top hit is often a remix rather than the recording we actually matched.
 */
async function musicbrainzGenre(artist, track, genresMap, recordingId) {
  let id = recordingId;
  if (!id) {
    const match = await tryIdentify(artist, track);
    if (!match) return null;
    id = match.id;
  }
  if (!id) return null;
  const tags = await musicbrainzRecordingTags(id);
  return firstMappedGenre(tags, genresMap, false);
}

// Categories broad enough that landing in one tells a DJ almost nothing.
const UMBRELLA_CATEGORIES = new Set(["Pop", "Rock", "Electronic", "Unknown"]);

/*
 * Artist-level genre, preferring a specific category over an umbrella one.
 *
 * Artist tags describe a whole career, so the most-voted tag is often the
 * broadest. Calvin Harris is the worked example: his top tag is "dance-pop"
 * (7 votes) but the list also holds "electro house" (4). For sorting a DJ
 * library, House is a far more useful shelf than Pop, and since this stage is
 * already a coarse fallback, taking the more specific reading costs nothing.
 * Vote order still decides within each group.
 */
async function musicbrainzArtistGenre(artist, genresMap) {
  return firstMappedGenre(await musicbrainzArtistTags(artist), genresMap, true);
}

/*
 * Last.fm artist tags. Measured to be far better populated than track tags:
 * track.getInfo returned nothing at all for ANOTR, Clarcq, Kaskade and even
 * Womack & Womack's "Teardrops", while artist.getTopTags answered House,
 * House/UK Garage and soul/funk/disco respectively. Same "prefer specific over
 * umbrella" rule as the MusicBrainz artist stage.
 */
const _lastfmArtistCache = new Map();

async function lastfmArtistGenre(artist, apiKey, genresMap) {
  if (!apiKey) return null;
  const cacheKey = artist.toLowerCase();
  let names = _lastfmArtistCache.get(cacheKey);
  if (!names) {
    const url = "https://ws.audioscrobbler.com/2.0/?method=artist.getTopTags" +
      "&artist=" + encodeURIComponent(artist) +
      "&autocorrect=1&api_key=" + encodeURIComponent(apiKey) + "&format=json";
    try {
      const data = await fetchJson(url);
      names = (((data.toptags || {}).tag) || []).map((t) => String(t.name || "").toLowerCase());
    } catch (e) {
      lastLookupError = "Last.fm artist lookup failed: " + e.message;
      names = [];
    }
    _lastfmArtistCache.set(cacheKey, names);
  }

  return firstMappedGenre(names, genresMap, true);
}

async function lastfmGenre(artist, track, apiKey, genresMap) {
  if (!apiKey) return null;
  const url = "https://ws.audioscrobbler.com/2.0/?method=track.getInfo" +
    "&artist=" + encodeURIComponent(artist) +
    "&track=" + encodeURIComponent(track) +
    "&autocorrect=1&api_key=" + encodeURIComponent(apiKey) + "&format=json";
  try {
    const data = await fetchJson(url);
    const tags = (((data.track || {}).toptags || {}).tag || []).map((t) => String(t.name || ""));
    const found = firstMappedGenre(tags, genresMap, false);
    if (found) return found;
  } catch (e) {
    return null;
  }
  return null;
}

// Reads and clears the pending lookup error, so each file reports only its own.
function takeLookupError() {
  const error = lastLookupError;
  lastLookupError = null;
  return error;
}

function sanitizeFilename(text) {
  return text.replace(FILENAME_UNSAFE_CHARS, "").trim();
}

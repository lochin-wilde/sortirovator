"use strict";
/*
 * app.js -- UI, batch orchestration and ZIP assembly.
 *
 * The per-file pipeline mirrors process_track() from the Python version:
 * fix names, decode once, detect BPM and key, resolve the genre through the
 * same priority chain, normalize loudness, and place the result in a
 * genre-named folder. The difference is that the "folder" is an entry in a ZIP
 * built in memory instead of a directory on disk.
 */

/*
 * Bumped on every release.
 *
 * The same string must be updated in index.html, where it versions the
 * stylesheet and every script tag. Browsers cache each of those files
 * independently of the page, so a deployed update otherwise reaches users in
 * pieces -- new HTML with old CSS, or new interface code with an old worker.
 * That is not hypothetical: it shipped exactly once here, and the invite screen
 * rendered as an unstyled block scrolled off the top of the page.
 *
 * Browsers cache workers hard, and importScripts() inside one is cached
 * separately again. Without a version in the URL a deployed update leaves users
 * running the previous analysis code against the new interface, silently and
 * indefinitely -- which is exactly what happened here during development, with
 * a stale worker quietly dropping a newly added field.
 */
const APP_VERSION = "2026.07.30.1";

const SUPPORTED_EXTENSIONS = [".mp3", ".wav", ".flac", ".m4a"];
// Mirrors KEY_MIN_CONFIDENCE in dsp.js, which runs in the worker.
const KEY_CONFIDENCE_THRESHOLD = 0.50;
const ANALYSIS_MAX_SECONDS = 120;
const GENRE_ANALYSIS_RATE = 22050;

/*
 * Largest file accepted, per file.
 *
 * The limit exists because decoding expands audio rather than compressing it:
 * decodeAudioData hands back 32-bit floats per channel, so an hour of stereo at
 * 44.1 kHz occupies about 1.4 GB in memory whatever it weighed on disk. With
 * several workers decoding at once, a tab can be killed outright, and a killed
 * tab loses the whole batch with nothing written out.
 *
 * 500 MB clears any real track by a wide margin -- a ten-minute 24-bit WAV is
 * about 160 MB -- while stopping the case this is really aimed at, someone
 * dropping in a two-hour recorded set. Note the check is on the file as stored,
 * which for a heavily compressed format understates what decoding will cost, so
 * a very long MP3 can still be uncomfortable. Only reading the duration first
 * would fix that properly, and it costs a second load per file.
 */
const MAX_FILE_BYTES = 500 * 1024 * 1024;

const state = {
  files: [],
  genresMap: null,
  workers: [],
  audioContext: null,
  zip: null,
  running: false,
  cancelRequested: false,
  usedPaths: new Set(),
  producedCount: 0,
};

const el = (id) => document.getElementById(id);

const ui = {
  pickFiles: el("pick-files"),
  pickFolder: el("pick-folder"),
  fileInput: el("file-input"),
  folderInput: el("folder-input"),
  pickerHint: el("picker-hint"),
  fileSummary: el("file-summary"),
  stepFixNames: el("step-fix-names"),
  stepSort: el("step-sort"),
  stepBpmKey: el("step-bpm-key"),
  stepLoudness: el("step-loudness"),
  loudnessPanel: el("loudness-panel"),
  loudnessMode: el("loudness-mode"),
  targetLufs: el("target-lufs"),
  outputFormat: el("output-format"),
  sampleRate: el("sample-rate"),
  safeLimiter: el("safe-limiter"),
  removeSilence: el("remove-silence"),
  addPrefix: el("add-prefix"),
  useMusicbrainz: el("use-musicbrainz"),
  useDiscogs: el("use-discogs"),
  lastfmKey: el("lastfm-key"),
  start: el("start"),
  cancel: el("cancel"),
  download: el("download"),
  reset: el("reset"),
  appMain: el("app-main"),
  tableTools: el("table-tools"),
  tableFilter: el("table-filter"),
  tableCount: el("table-count"),
  feedbackExport: el("feedback-export"),
  feedbackClear: el("feedback-clear"),
  resetHint: el("reset-hint"),
  progressBlock: el("progress-block"),
  batchBar: el("batch-bar"),
  batchCounter: el("batch-counter"),
  fileBar: el("file-bar"),
  fileLabel: el("file-label"),
  fileStage: el("file-stage"),
  results: el("results"),
  resultsBody: el("results-body"),
  logBox: el("log-box"),
  log: el("log"),
};

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  ui.log.textContent += "[" + stamp + "] " + line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}

function logRaw(line) {
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Environment probing                                                 */
/* ------------------------------------------------------------------ */

/*
 * Safari on iOS has no directory picker, and Safari in general cannot decode
 * Ogg/Opus. Both are detected up front so the user gets a clear explanation
 * rather than an empty file list or a silent per-file failure.
 */
function probeEnvironment() {
  const probe = document.createElement("input");
  probe.type = "file";
  const supportsDirectory = "webkitdirectory" in probe;
  if (!supportsDirectory) {
    ui.pickFolder.hidden = true;
    ui.pickerHint.setAttribute("data-i18n", "step1.hintNoFolder");
    ui.pickerHint.textContent = t("step1.hintNoFolder");
  }

  const audio = document.createElement("audio");
  const canFlac = audio.canPlayType("audio/flac") || audio.canPlayType("audio/x-flac");
  if (!canFlac) {
    log(t("msg.noFlac"));
  }
  log(t("msg.environment", { agent: navigator.userAgent }));
  log(t("msg.dirPicker", { state: t(supportsDirectory ? "msg.available" : "msg.notAvailable") }));
  if (typeof SharedArrayBuffer === "undefined") {
    log(t("msg.noSab"));
  }
}

/* ------------------------------------------------------------------ */
/* File selection                                                      */
/* ------------------------------------------------------------------ */

function isSupported(file) {
  const name = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(0);
}

/*
 * jszip is 28 KB gzipped and is not needed until a batch actually starts, which
 * is after the user has picked files and pressed the button -- long enough that
 * the download never delays anything they are waiting on. Loading it up front
 * made it a quarter of the first-paint payload for a page that may never build
 * an archive at all.
 */
let _zipLibraryPromise = null;

function ensureZipLibrary() {
  if (typeof JSZip !== "undefined") return Promise.resolve();
  if (_zipLibraryPromise) return _zipLibraryPromise;
  _zipLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "js/lib/jszip.min.js?v=" + APP_VERSION;
    script.onload = () => resolve();
    script.onerror = () => {
      _zipLibraryPromise = null;
      reject(new Error("jszip failed to load"));
    };
    document.head.appendChild(script);
  });
  return _zipLibraryPromise;
}

function handleSelection(fileList) {
  const all = Array.from(fileList);
  const supported = all.filter(isSupported);
  const wrongType = all.filter((f) => !isSupported(f));
  const tooBig = supported.filter((f) => f.size > MAX_FILE_BYTES);
  const accepted = supported.filter((f) => f.size <= MAX_FILE_BYTES);

  state.files = accepted;
  ui.fileSummary.hidden = all.length === 0;

  let html = "<strong>" +
    escapeHtml(t("summary.selected", { count: accepted.length })) + "</strong>";
  if (wrongType.length > 0) {
    html += " &middot; " + escapeHtml(t("summary.skippedType", { count: wrongType.length }));
  }
  if (tooBig.length > 0) {
    html += " &middot; " + escapeHtml(t("summary.skippedSize", {
      count: tooBig.length, limit: formatMegabytes(MAX_FILE_BYTES),
    }));
  }
  if (accepted.length > 0) {
    const preview = accepted.slice(0, 12).map((f) => "<li>" + escapeHtml(f.name) + "</li>").join("");
    const more = accepted.length > 12
      ? "<li>" + escapeHtml(t("summary.more", { count: accepted.length - 12 })) + "</li>"
      : "";
    html += "<ul>" + preview + more + "</ul>";
  }
  ui.fileSummary.innerHTML = html;

  // Named individually: "3 files were too big" leaves the user hunting for which.
  for (const file of tooBig) {
    log(t("msg.tooBig", {
      name: file.name,
      size: formatMegabytes(file.size),
      limit: formatMegabytes(MAX_FILE_BYTES),
    }));
  }

  ui.start.disabled = accepted.length === 0 || state.running;
  log(t("msg.selected", {
    count: accepted.length,
    skipped: wrongType.length + tooBig.length,
  }));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ */
/* Audio decoding helpers (main thread)                                */
/* ------------------------------------------------------------------ */

function decodeAudioData(context, arrayBuffer) {
  // Safari only gained the promise-returning form recently; keep the callback
  // form as a fallback so older versions still work.
  return new Promise((resolve, reject) => {
    const maybePromise = context.decodeAudioData(arrayBuffer, resolve, reject);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then(resolve, reject);
    }
  });
}

function downmixToMono(audioBuffer, maxSeconds) {
  const length = Math.min(audioBuffer.length, Math.ceil(maxSeconds * audioBuffer.sampleRate));
  const channelCount = audioBuffer.numberOfChannels;
  const mono = new Float32Array(length);
  for (let c = 0; c < channelCount; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  if (channelCount > 1) {
    for (let i = 0; i < length; i++) mono[i] /= channelCount;
  }
  return mono;
}

/*
 * Resample with OfflineAudioContext rather than in JS: the browser's own
 * resampler is high quality and native speed, and the target rate here (22050)
 * is the one librosa.load defaults to on the Python side.
 */
async function resampleMono(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  const outLength = Math.max(1, Math.round((mono.length * toRate) / fromRate));
  const context = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, outLength, toRate);
  const buffer = context.createBuffer(1, mono.length, fromRate);
  buffer.getChannelData(0).set(mono);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

function describeDecodeFailure(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".flac")) {
    return "this browser could not decode the FLAC file. Convert it to MP3 or WAV and try again.";
  }
  if (name.endsWith(".m4a")) {
    return "this browser could not decode the M4A/AAC file. Convert it to MP3 or WAV and try again.";
  }
  if (name.endsWith(".ogg") || name.endsWith(".opus")) {
    return "Safari cannot decode Ogg/Opus. Convert it to MP3 or WAV and try again.";
  }
  return "the browser could not decode this file. It may be corrupt or use an unsupported codec.";
}

/* ------------------------------------------------------------------ */
/* Worker plumbing                                                     */
/* ------------------------------------------------------------------ */

function createWorker() {
  const worker = new Worker("js/worker.js?v=" + APP_VERSION);
  worker.onerror = (event) => log(t("msg.workerError", { message: event.message }));
  return worker;
}

/*
 * A small pool of workers, so several tracks are analysed at once.
 *
 * Sized from hardwareConcurrency but capped at 4. The cap is about memory, not
 * cores: each worker holds a decoded track, and two minutes of 44.1 kHz stereo
 * float32 is roughly 42 MB, so eight workers would pin a third of a gigabyte
 * before any of the analysis buffers. Leaving one core free keeps the interface
 * responsive while a batch runs.
 *
 * Decoding stays on the main thread -- decodeAudioData is unavailable inside a
 * worker on Safari -- so it is the one part that cannot overlap with itself.
 * It is also the cheapest part, so that costs little.
 */
function poolSize() {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function acquireWorker() {
  const idle = state.workers.find((w) => !w.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  const created = { worker: createWorker(), busy: true };
  state.workers.push(created);
  return created;
}

function releaseWorker(slot) {
  slot.busy = false;
}

// Each request resolves on the first matching reply; progress messages update
// the per-file bar without disturbing the request/response pairing.
function workerRequest(worker, message, transfers, expectedType) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data;
      if (data.type === "progress") {
        setFileProgress(data.stage, data.value);
        return;
      }
      worker.removeEventListener("message", onMessage);
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage(message, transfers || []);
    void expectedType;
  });
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

// Worker stage ids mapped to translation keys.
const STAGE_KEYS = {
  bpm: "stage.bpm", key: "stage.key", loudness: "stage.loudness",
  genre: "stage.genre", render: "stage.rendering",
};

function setBatchProgress(done, total) {
  ui.batchBar.style.width = total > 0 ? (done / total) * 100 + "%" : "0%";
  ui.batchCounter.textContent = done + " / " + total;
}

function setFileProgress(stage, value) {
  ui.fileBar.style.width = Math.max(0, Math.min(1, value)) * 100 + "%";
  ui.fileStage.textContent = STAGE_KEYS[stage] ? t(STAGE_KEYS[stage]) : (stage || "");
}

function setFileLabel(text) {
  ui.fileLabel.textContent = text;
}

/* ------------------------------------------------------------------ */
/* Genre resolution                                                    */
/* ------------------------------------------------------------------ */

function normalizeGenre(genre, genresMap) {
  if (!genre) return "Unknown";
  return genreForTag(genresMap, genre.toLowerCase()) || "Unknown";
}

/*
 * A category name, made safe to use as one folder inside the ZIP.
 *
 * Seven of the 51 categories read as a pair -- "Funky / Disco House",
 * "Funk / Soul", "Reggae / Dancehall" -- and a slash is the path separator in a
 * ZIP entry. Used as written, those produced two nested folders whose names
 * carried a trailing and a leading space, so a funky-house library unpacked
 * into "Funky " containing " Disco House". Not a traversal risk, since no
 * category contains "..", but wrong in a way nobody would notice until they
 * opened the archive.
 *
 * The slash is replaced rather than dropped, because the pairing is the meaning
 * of the name. The map itself keeps the slash: it is only a problem in a path,
 * and it reads correctly in the results table.
 */
function genreFolderName(genre) {
  const name = String(genre)
    .replace(/\s*\/\s*/g, " & ")
    .replace(FILENAME_UNSAFE_CHARS, "")
    // Windows silently drops a trailing dot or space from a directory name,
    // which would make the folder in the archive and the folder on disk differ.
    .replace(/[\s.]+$/, "")
    .trim();

  // A name made only of punctuation is not a name. No real category looks like
  // that, but this function stands between a lookup result and a filesystem
  // path, so it answers for any input rather than for the expected ones.
  return /[\p{L}\p{N}]/u.test(name) ? name : "Unknown";
}

/*
 * Genre resolution, reworked from the straight port of process_file().
 *
 * The original chain trusted the file tag unconditionally, which is wrong in
 * practice: a UK Garage track tagged "Pop" by whatever ripped it was being
 * filed under Pop even though better answers were one lookup away. A specific
 * tag is still trusted immediately -- if a file says "deep house", it means it.
 * An umbrella tag is held back and only used if nothing better turns up.
 *
 * Returns { genre, source } so the log can name where the answer came from.
 */
async function resolveGenre(context) {
  const { tags, artist, track, genresMap, options, worker, recordingId } = context;

  /*
   * What the user has already told us wins outright. They are looking at their
   * own library and we are guessing at it; no lookup should be able to overrule
   * a correction they made by hand.
   */
  const correction = correctionFor(artist, track);
  if (correction) {
    return {
      genre: correction.genre,
      source: t(correction.scope === "track" ? "genre.fromYouTrack" : "genre.fromYouArtist"),
    };
  }

  const tagGenre = tags.genre ? normalizeGenre(tags.genre, genresMap) : "Unknown";
  const lookupsEnabled = options.useMusicbrainz || options.useDiscogs || Boolean(options.lastfmKey);

  /*
   * With lookups enabled the file tag is consulted only after the online
   * sources, never before.
   *
   * Trusting a specific-looking file tag outright was tried and does not
   * survive contact with a real library: Pharoahe Monch's "Simon Says", a 1999
   * hip-hop record, ships tagged "Dubstep" and was filed under Dubstep, while a
   * Calvin Harris house track ships tagged "Pop". Whatever wrote those tags is
   * not a better authority than MusicBrainz or Last.fm, and a careless tag is
   * indistinguishable from a curated one by inspection.
   *
   * With lookups off there is nothing better available, so the tag leads.
   */
  if (!lookupsEnabled && tagGenre !== "Unknown") {
    return { genre: tagGenre, source: 'file tag "' + tags.genre + '"' };
  }

  /*
   * Track-specific sources first, artist-level only after they are exhausted.
   * That ordering is what the worked example demands: MusicBrainz has no
   * genres on the "Blessings" recording, Last.fm's community tagged the track
   * itself "Chill House", and the Calvin Harris *artist* entry says
   * "dance-pop". The artist answer describes a career, not this track, so it
   * must not outrank a source that actually looked at the track.
   */
  if (artist && track) {
    const remixer = remixerFromTitle(track);

    /*
     * A remix belongs to whoever made it, and every lookup keyed on the
     * original artist will say otherwise. This is not a small effect and not a
     * hypothetical one -- measured against Discogs:
     *
     *   Aerosmith - Dream On (Yultron Remix)        -> Blues Rock, Hard Rock
     *   Fleetwood Mac - Dreams (Dave Winnel Remix)  -> Vocal
     *
     * Those are the right answers about the original recordings and useless
     * answers about the files in hand, which are a dubstep flip and a house
     * record. So when the title carries a remix marker the original artist is
     * not consulted at all -- not skipped in favour of a better answer, but
     * excluded, because its answer is confidently wrong.
     *
     * The remix's own release is tried first: Discogs often has it, catalogued
     * under the remixer with its own style. Only if that fails do we fall back
     * to what the remixer is generally known for.
     */
    if (remixer) {
      const core = splitTitle(track).core;
      const fromRemixRelease = options.useDiscogs
        ? await discogsGenre(remixer, core, genresMap)
        : null;
      if (fromRemixRelease) {
        return {
          genre: fromRemixRelease.genre,
          source: 'Discogs style "' + fromRemixRelease.tag + '" for the ' + remixer + ' remix',
        };
      }
      if (options.lastfmKey) {
        const fromRemixer = await lastfmArtistGenre(remixer, options.lastfmKey, genresMap);
        if (fromRemixer) {
          return { genre: fromRemixer.genre, source: 'Last.fm tag "' + fromRemixer.tag + '" for remixer ' + remixer };
        }
      }
      if (options.useMusicbrainz) {
        const fromRemixerMb = await musicbrainzArtistGenre(remixer, genresMap);
        if (fromRemixerMb) {
          return { genre: fromRemixerMb.genre, source: 'MusicBrainz tag "' + fromRemixerMb.tag + '" for remixer ' + remixer };
        }
      }
      /*
       * Nothing known about the remixer. Falling through to the original artist
       * from here would reintroduce exactly the Aerosmith answer, so the audio
       * fallback at the bottom of this function is the better outcome.
       */
    } else {
      /*
       * Track-level sources first, Discogs ahead of the rest. Its styles are
       * written per release by collectors, which is finer than anything the
       * others carry, and it answers where they do not: Last.fm's track.getInfo
       * now returns an empty tag list for most tracks.
       */
      const fromDiscogs = options.useDiscogs
        ? await discogsGenre(artist, track, genresMap)
        : null;
      if (fromDiscogs) {
        /*
         * The one place a release year changes the answer, and the only genre
         * family where it does. Asking two sources costs a rate-limited second,
         * so it is asked only when the answer is the undivided Hip-Hop bucket --
         * never for Trap, Boom Bap or anything outside hip-hop.
         *
         * A track neither source can date stays in Hip-Hop rather than being
         * guessed into an era.
         */
        let genre = fromDiscogs.genre;
        let source = 'Discogs style "' + fromDiscogs.tag + '"';
        if (ERA_SPLIT_GENRES.has(genre)) {
          const fromMb = await musicbrainzEarliestYear(artist, track);
          const year = [fromDiscogs.year, fromMb]
            .filter((y) => typeof y === "number" && y > 0)
            .reduce((a, b) => Math.min(a, b), Infinity);
          const known = isFinite(year) ? year : null;
          const withEra = applyEra(genre, known);
          if (withEra !== genre) {
            genre = withEra;
            source = 'Discogs style "' + fromDiscogs.tag + '", first released ' + known;
          }
        }
        return { genre, source };
      }
      if (options.useMusicbrainz) {
        const fromRecording = await musicbrainzGenre(artist, track, genresMap, recordingId);
        if (fromRecording) {
          return { genre: fromRecording.genre, source: 'MusicBrainz recording tag "' + fromRecording.tag + '"' };
        }
      }
      if (options.lastfmKey) {
        const fromLastfm = await lastfmGenre(artist, track, options.lastfmKey, genresMap);
        if (fromLastfm) {
          return { genre: fromLastfm.genre, source: 'Last.fm track tag "' + fromLastfm.tag + '"' };
        }
      }

      // Artist-level sources, in measured order of usefulness: Last.fm's artist
      // tags are much better populated than MusicBrainz's for dance music.
      if (options.lastfmKey) {
        const fromLastfmArtist = await lastfmArtistGenre(artist, options.lastfmKey, genresMap);
        if (fromLastfmArtist) {
          return { genre: fromLastfmArtist.genre, source: 'Last.fm artist tag "' + fromLastfmArtist.tag + '" (artist-level)' };
        }
      }
      if (options.useMusicbrainz) {
        const fromArtist = await musicbrainzArtistGenre(artist, genresMap);
        if (fromArtist) {
          return { genre: fromArtist.genre, source: 'MusicBrainz artist tag "' + fromArtist.tag + '" (artist-level)' };
        }
      }
    }
  }

  // Nothing more specific surfaced, so the umbrella tag is better than a guess.
  if (tagGenre !== "Unknown") {
    return { genre: tagGenre, source: 'file tag "' + tags.genre + '" (no online source had anything)' };
  }

  const reply = await workerRequest(worker, { type: "genreFallback" }, [], "genre");
  if (reply.result && reply.result.genre !== "Unknown") {
    const f = reply.result.features;
    return {
      genre: reply.result.genre,
      source: "audio analysis (tempo " + f.tempo + ", centroid " + f.centroid +
        " Hz, bandwidth " + f.bandwidth + " Hz, ZCR " + f.zcr + ")",
    };
  }
  return { genre: "Unknown", source: "no match" };
}

/* ------------------------------------------------------------------ */
/* Per-file pipeline                                                   */
/* ------------------------------------------------------------------ */

function formatLufsForPrefix(value) {
  // Mirrors _format_lufs(): trim a trailing ".0" the way Python's %g does.
  return String(Number(value));
}

function uniquePath(path) {
  if (!state.usedPaths.has(path)) {
    state.usedPaths.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let counter = 2;
  let candidate = stem + " (" + counter + ")" + ext;
  while (state.usedPaths.has(candidate)) {
    counter++;
    candidate = stem + " (" + counter + ")" + ext;
  }
  state.usedPaths.add(candidate);
  return candidate;
}

async function processFile(file, options, slot) {
  const worker = slot.worker;
  const result = {
    name: file.name,
    identifiedAs: null,
    genre: null,
    genreSource: null,
    bpm: null,
    bpmMode: null,
    bpmMin: null,
    bpmMax: null,
    key: null,
    keyConfidence: null,
    keyConfident: false,
    loudnessMode: null,
    measuredLufs: null,
    browseLufs: null,
    targetLufs: null,
    gainDb: null,
    truePeakBeforeDb: null,
    outputPath: null,
    feedbackArtist: null,
    feedbackTitle: null,
    titleSimilarity: null,
    artistSimilarity: null,
    viaTransliteration: false,
    lookupError: null,
    nameChanges: null,
    cleanedName: null,
    maybeTransliterated: false,
    error: null,
  };

  const extension = fileExtension(file.name);

  // Tags come from a small header slice; no need to hold the whole file twice.
  const headerBytes = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  const tags = readTags(headerBytes, extension);

  /*
   * Tidy the name before anything else looks at it, and say what was changed.
   * The cleanup is applied whether or not the online lookup runs, since it only
   * removes things that are unambiguously noise.
   */
  const tidied = cleanFilename(stripExtension(file.name));
  if (tidied.changes.length > 0) {
    result.nameChanges = tidied.changes;
    result.cleanedName = tidied.cleaned;
  }
  if (looksTransliterated(tidied.cleaned)) {
    result.maybeTransliterated = true;
  }

  let parsed = parseFilename(tidied.cleaned + fileExtension(file.name));
  let artist = parsed.artist || tags.artist;
  let track = parsed.track || tags.title;
  let stem = tidied.cleaned;
  let recordingId = null;
  // Recorded up front: the results table shows the artist regardless of which
  // steps are enabled, and corrections are filed against these names.
  result.feedbackArtist = artist || null;
  result.feedbackTitle = track || null;

  if (options.steps.fixNames && options.useMusicbrainz && parsed.artist && parsed.track) {
    setFileProgress("lookup", 0.1);
    ui.fileStage.textContent = t("stage.identifying");
    const match = await identifyTrack(parsed.artist, parsed.track);
    if (match) {
      // Keep the file's own version marker: the lookup matched on the song, so
      // the recording it found is often a different mix of it.
      const finalTitle = mergeTitleVersion(track, match.title);
      result.identifiedAs = match.artist + " - " + finalTitle;
      stem = sanitizeFilename(match.artist + " - " + finalTitle) || stem;
      artist = match.artist;
      track = finalTitle;
      recordingId = match.id || null;
      // Rendered later by describeResult so the whole block comes out in one
      // language; logging it here as well produced each line twice.
      result.titleSimilarity = match.titleSimilarity;
      result.artistSimilarity = match.artistSimilarity;
      result.viaTransliteration = Boolean(match.viaTransliteration);
      // The canonical names replace the parsed ones, so the table and any
      // correction filed from it refer to the identified track.
      result.feedbackArtist = artist;
      result.feedbackTitle = track;
    } else {
      result.lookupError = takeLookupError();
    }
  }

  const needsAudio = options.steps.bpmKey || options.steps.loudness || options.steps.sort;
  let audioBuffer = null;
  if (needsAudio) {
    ui.fileStage.textContent = t("stage.decoding");
    try {
      const bytes = await file.arrayBuffer();
      audioBuffer = await decodeAudioData(state.audioContext, bytes);
    } catch (e) {
      result.error = describeDecodeFailure(file);
      return result;
    }
  }

  let analysisReply = { result: {} };
  if (audioBuffer) {
    const nativeRate = audioBuffer.sampleRate;
    const monoNative = downmixToMono(audioBuffer, ANALYSIS_MAX_SECONDS);
    const mono22k = await resampleMono(monoNative, nativeRate, GENRE_ANALYSIS_RATE);

    let channels = null;
    if (options.steps.loudness) {
      channels = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        channels.push(new Float32Array(audioBuffer.getChannelData(c)));
      }
    }
    audioBuffer = null; // release the decoded buffer before transferring copies

    const transfers = [monoNative.buffer, mono22k.buffer];
    const message = {
      type: "analyze",
      steps: options.steps,
      sampleRate: nativeRate,
      monoNative: monoNative.buffer,
      mono22k: mono22k.buffer,
      channels: null,
    };
    if (channels) {
      message.channels = channels.map((c) => c.buffer);
      for (const c of channels) transfers.push(c.buffer);
    }
    analysisReply = await workerRequest(worker, message, transfers, "analyzed");
  }

  const analysis = analysisReply.result || {};
  result.bpm = analysis.bpm !== undefined ? analysis.bpm : null;
  result.key = analysis.key !== undefined ? analysis.key : null;
  result.bpmMode = analysis.bpmMode || null;
  result.bpmMin = analysis.bpmMin !== undefined ? analysis.bpmMin : null;
  result.bpmMax = analysis.bpmMax !== undefined ? analysis.bpmMax : null;
  result.keyConfidence = analysis.keyConfidence !== undefined ? analysis.keyConfidence : null;
  result.keyConfident = analysis.keyConfident === true;

  if (options.steps.sort) {
    ui.fileStage.textContent = t("stage.genre");
    const resolved = await resolveGenre({
      tags, artist, track, genresMap: state.genresMap, options, worker, recordingId,
    });
    result.genre = resolved.genre;
    result.genreSource = resolved.source;
  }

  /*
   * Loudness is measured for every track now, so the table can sort by it even
   * when normalization is off. measuredLufs is the plain measurement; the
   * normalize block below may overwrite it with the short-term figure when that
   * is the mode being used to compute gain.
   */
  if (analysis.browseLufs !== undefined && analysis.browseLufs !== null) {
    result.browseLufs = round2(analysis.browseLufs);
  }

  // Build the output entry: gain and re-encode when normalizing, otherwise the
  // original bytes are copied through untouched.
  let outputBlob = null;
  let outputExtension = extension;
  let prefix = "";

  if (options.steps.loudness && analysis.integratedLufs !== undefined) {
    const mode = options.loudness.mode;
    result.loudnessMode = mode;
    result.targetLufs = mode === "convert_only" ? null : options.loudness.targetLufs;
    result.truePeakBeforeDb = analysis.truePeakDb !== null ? round2(analysis.truePeakDb) : null;

    let gainDb = 0;
    if (mode === "short_term" || mode === "integrated") {
      const current = mode === "short_term" ? analysis.shortTermMaxLufs : analysis.integratedLufs;
      result.measuredLufs = current !== null ? round2(current) : null;
      if (current !== null) gainDb = options.loudness.targetLufs - current;
    }
    result.gainDb = round2(gainDb);

    if (options.loudness.addPrefix && mode === "short_term") {
      prefix = "[" + formatLufsForPrefix(options.loudness.targetLufs) + " LUFS-S-max] ";
    } else if (options.loudness.addPrefix && mode === "integrated") {
      prefix = "[" + formatLufsForPrefix(options.loudness.targetLufs) + " LUFS Integrated] ";
    }

    ui.fileStage.textContent = t("stage.rendering");
    const rendered = await workerRequest(
      worker,
      { type: "render", gainDb, options: options.loudness },
      [],
      "rendered"
    );
    if (rendered.mp3Requested && rendered.format !== "mp3") {
      log(t("msg.mp3Unavailable"));
    }
    outputExtension = "." + rendered.format;
    outputBlob = new Blob([rendered.buffer], {
      type: rendered.format === "mp3" ? "audio/mpeg" : "audio/wav",
    });
  } else {
    outputBlob = file;
  }

  await workerRequest(worker, { type: "release" }, [], "released");

  const folder = options.steps.sort && result.genre
    ? genreFolderName(result.genre) + "/" : "";
  result.outputPath = uniquePath(folder + prefix + stem + outputExtension);
  state.zip.file(result.outputPath, outputBlob);
  state.producedCount++;

  return result;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Result rendering                                                    */
/* ------------------------------------------------------------------ */

function describeResult(result) {
  if (result.error) return [t("res.error", { message: result.error })];
  const lines = [];

  if (result.nameChanges && result.nameChanges.length > 0) {
    lines.push(t("res.cleaned", {
      changes: result.nameChanges.map((key) => t(key)).join(", "),
      name: result.cleanedName || "",
    }));
  }

  if (result.identifiedAs) {
    lines.push(t("res.identifiedAs", {
      name: result.identifiedAs,
      title: result.titleSimilarity,
      artist: result.artistSimilarity,
    }) + (result.viaTransliteration ? t("res.viaCyrillic") : ""));
  } else if (result.identifyAttempted) {
    lines.push(result.lookupError
      ? t("res.lookupFailed", { message: result.lookupError })
      : t("res.notIdentified"));
    // Only worth saying when the lookup came back empty: if a match was found,
    // the Cyrillic form has already been restored from it.
    if (result.maybeTransliterated) lines.push(t("res.maybeRussian"));
  }

  // The source is the whole reason the log is useful: it says *why* a genre was
  // chosen, which is what makes a wrong one worth correcting.
  if (!result.genre) {
    lines.push(t("res.genreOff"));
  } else if (result.genreSource) {
    lines.push(t("res.genreWithSource", { genre: result.genre, source: result.genreSource }));
  } else {
    lines.push(t("res.genre", { genre: result.genre }));
  }

  // A weak key is still shown, clearly marked, rather than discarded.
  let keyText;
  if (result.key && result.keyConfident) {
    keyText = t("res.keyConfident", { key: result.key, score: result.keyConfidence.toFixed(2) });
  } else if (result.key) {
    keyText = t("res.keyGuess", {
      key: result.key,
      score: result.keyConfidence.toFixed(2),
      threshold: KEY_CONFIDENCE_THRESHOLD.toFixed(2),
    });
  } else {
    keyText = t("res.keyNotDetected");
  }

  // The tempo mode is only worth a word when it is the unusual one.
  let bpmText;
  if (result.bpm === null) {
    bpmText = t("res.bpmNotDetected");
  } else if (result.bpmMode === "dynamic" && result.bpmMin !== null) {
    bpmText = t("res.bpmDynamic", { bpm: result.bpm, min: result.bpmMin, max: result.bpmMax });
  } else {
    bpmText = String(result.bpm);
  }
  lines.push(t("res.bpmKey", { bpm: bpmText, key: keyText }));

  if (result.loudnessMode) {
    const label = t("loudness." + (result.loudnessMode === "short_term" ? "shortTerm"
      : result.loudnessMode === "integrated" ? "integrated" : "convertOnly"));
    if (result.loudnessMode === "convert_only") {
      lines.push(t("res.loudnessConvert"));
    } else if (result.measuredLufs !== null && result.targetLufs !== null && result.gainDb !== null) {
      const peak = result.truePeakBeforeDb !== null
        ? t("res.loudnessPeak", { peak: formatSigned(result.truePeakBeforeDb) })
        : "";
      lines.push(t("res.loudnessFull", {
        mode: label,
        measured: formatSigned(result.measuredLufs),
        target: formatSigned(result.targetLufs),
        gain: formatSigned(result.gainDb),
        peak: peak,
      }));
    } else if (result.gainDb !== null) {
      lines.push(t("res.loudnessGain", { gain: formatSigned(result.gainDb) }));
    }
  }

  lines.push(t("res.output", { path: result.outputPath }));
  return lines;
}

function formatSigned(value) {
  return (value >= 0 ? "+" : "") + value.toFixed(2);
}

/*
 * Rows are kept as data and the table is redrawn from them, rather than the DOM
 * being the source of truth. Sorting and filtering then work on the values that
 * were measured -- numeric BPM, numeric LUFS -- instead of on rendered text,
 * where "-9.5" and "-13.7" would sort as strings.
 */
const resultRows = [];
let tableSort = { column: null, ascending: true };
let tableFilter = "";

function addResultRow(result) {
  resultRows.push(result);
  renderResults();
}

function resultCells(result, index) {
  const keyText = result.key
    ? (result.keyConfident ? result.key : result.key + "?") +
      (result.keyConfidence !== null ? " (" + result.keyConfidence.toFixed(2) + ")" : "")
    : "—";
  const bpmText = result.bpm === null ? "—"
    : result.bpmMode === "dynamic" ? result.bpm + "~" : String(result.bpm);
  const loudnessText = result.browseLufs !== null && result.browseLufs !== undefined
    ? result.browseLufs.toFixed(1) + " LUFS"
    : "—";
  const genreCell = result.genre
    ? '<button type="button" class="genre-edit" data-row="' + index + '">' +
      escapeHtml(result.genre) + '<span class="genre-edit-mark">✎</span></button>'
    : "—";

  return '<td class="name">' + escapeHtml(result.name) + (result.error ? " ⚠" : "") + "</td>" +
    "<td>" + escapeHtml(result.feedbackArtist || "—") + "</td>" +
    '<td class="genre-cell">' + genreCell + "</td>" +
    "<td>" + escapeHtml(bpmText) + "</td>" +
    "<td>" + escapeHtml(keyText) + "</td>" +
    "<td>" + escapeHtml(loudnessText) + "</td>" +
    '<td class="name muted">' + escapeHtml(result.outputPath || "—") + "</td>";
}

function sortValue(result, column) {
  switch (column) {
    case "artist": return (result.feedbackArtist || "").toLowerCase();
    case "genre": return (result.genre || "").toLowerCase();
    case "bpm": return result.bpm === null ? -1 : result.bpm;
    case "key": return result.key || "";
    // Quietest first, and tracks without a measurement sink to the bottom.
    case "loudness": return result.browseLufs === null || result.browseLufs === undefined
      ? -Infinity : result.browseLufs;
    default: return (result.name || "").toLowerCase();
  }
}

function matchesFilter(result) {
  if (!tableFilter) return true;
  const haystack = [result.name, result.feedbackArtist, result.genre, result.key]
    .filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(tableFilter);
}

function renderResults() {
  const visible = resultRows
    .map((result, index) => ({ result, index }))
    .filter((row) => matchesFilter(row.result));

  if (tableSort.column) {
    visible.sort((a, b) => {
      const va = sortValue(a.result, tableSort.column);
      const vb = sortValue(b.result, tableSort.column);
      if (va < vb) return tableSort.ascending ? -1 : 1;
      if (va > vb) return tableSort.ascending ? 1 : -1;
      return 0;
    });
  }

  ui.resultsBody.innerHTML = visible
    .map((row) => "<tr>" + resultCells(row.result, row.index) + "</tr>")
    .join("");
  ui.results.hidden = resultRows.length === 0;
  ui.tableTools.hidden = resultRows.length === 0;
  ui.tableCount.textContent = t("table.showing", { shown: visible.length, total: resultRows.length });

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === tableSort.column);
    th.classList.toggle("descending", th.dataset.sort === tableSort.column && !tableSort.ascending);
  });
}

function openGenreEditor(button) {
  const result = resultRows[Number(button.dataset.row)];
  if (!result || button.querySelector("select")) return;

  const select = document.createElement("select");
  select.className = "genre-picker";
  for (const genre of knownGenres(state.genresMap)) {
    const option = document.createElement("option");
    option.value = genre;
    option.textContent = genre;
    if (genre === result.genre) option.selected = true;
    select.appendChild(option);
  }

  button.innerHTML = "";
  button.appendChild(select);
  select.focus();

  const finish = (commit) => {
    const chosen = select.value;
    if (commit && chosen !== result.genre) {
      result.genre = chosen;
      recordGenreCorrection(result, chosen);
      log(t("feedback.saved", { genre: chosen, count: feedbackCount() }));
    }
    renderResults();
  };
  select.addEventListener("change", () => finish(true));
  select.addEventListener("blur", () => finish(false));
  select.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); });
}

ui.resultsBody.addEventListener("click", (event) => {
  const button = event.target.closest(".genre-edit");
  if (button) openGenreEditor(button);
});

document.querySelector("thead").addEventListener("click", (event) => {
  const th = event.target.closest("th.sortable");
  if (!th) return;
  const column = th.dataset.sort;
  tableSort = column === tableSort.column
    ? { column, ascending: !tableSort.ascending }
    : { column, ascending: true };
  renderResults();
});


/* ------------------------------------------------------------------ */
/* Batch runner                                                        */
/* ------------------------------------------------------------------ */

function readOptions() {
  const mode = ui.loudnessMode.value;
  let targetLufs = parseFloat(ui.targetLufs.value);
  if (!Number.isFinite(targetLufs)) targetLufs = mode === "short_term" ? -14 : -16;

  return {
    steps: {
      fixNames: ui.stepFixNames.checked,
      sort: ui.stepSort.checked,
      bpmKey: ui.stepBpmKey.checked,
      loudness: ui.stepLoudness.checked,
    },
    loudness: {
      mode,
      targetLufs: mode === "convert_only" ? 0 : targetLufs,
      safeLimiter: ui.safeLimiter.checked,
      removeSilence: ui.removeSilence.checked,
      addPrefix: ui.addPrefix.checked,
      outputFormat: ui.outputFormat.value,
      sampleRate: ui.sampleRate.value,
    },
    useMusicbrainz: ui.useMusicbrainz.checked,
    useDiscogs: ui.useDiscogs.checked,
    lastfmKey: ui.lastfmKey.value.trim(),
  };
}

async function loadGenresMap() {
  if (state.genresMap) return state.genresMap;
  try {
    const response = await fetch("data/genres_map.json?v=" + APP_VERSION);
    if (!response.ok) throw new Error("HTTP " + response.status);
    state.genresMap = await response.json();
    log(t("msg.mapLoaded", { count: Object.keys(state.genresMap).length }));
  } catch (e) {
    state.genresMap = {};
    log(t("msg.mapFailed", { message: e.message }));
  }
  return state.genresMap;
}

async function runBatch() {
  const options = readOptions();
  if (!options.steps.fixNames && !options.steps.sort && !options.steps.bpmKey && !options.steps.loudness) {
    log(t("msg.nothingToDo"));
    return;
  }

  try {
    await ensureZipLibrary();
  } catch (e) {
    log(t("msg.zipUnavailable"));
    return;
  }

  state.running = true;
  state.cancelRequested = false;
  state.usedPaths = new Set();
  state.producedCount = 0;
  state.zip = new JSZip();

  ui.start.disabled = true;
  ui.download.disabled = true;
  ui.cancel.hidden = false;
  ui.progressBlock.hidden = false;
  ui.results.hidden = false;
  ui.resultsBody.innerHTML = "";
  resultRows.length = 0;
  tableSort = { column: null, ascending: true };
  tableFilter = "";
  ui.tableFilter.value = "";
  ui.tableTools.hidden = true;
  ui.logBox.open = true;

  // The AudioContext must be created from a user gesture or Safari suspends it.
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }


  await loadGenresMap();

  const total = state.files.length;
  setBatchProgress(0, total);
  log(t("msg.batchStart", { total: total }));
  log(t("msg.steps", { steps: Object.keys(options.steps).filter((k) => options.steps[k]).join(", ") }));

  let done = 0;
  let failed = 0;
  let started = 0;

  /*
   * Files run several at a time, but their log blocks are emitted in file
   * order. Interleaving them would make the log unreadable -- lines from three
   * tracks alternating -- so each file's output is collected and flushed when
   * every earlier file has already been flushed.
   */
  const pending = new Map();
  let nextToFlush = 0;

  const flushReady = () => {
    while (pending.has(nextToFlush)) {
      const entry = pending.get(nextToFlush);
      pending.delete(nextToFlush);
      logRaw("");
      log(t("msg.processing", { index: entry.index + 1, total: total, file: entry.file.name }));
      for (const line of describeResult(entry.result)) logRaw(line);
      addResultRow(entry.result);
      nextToFlush++;
    }
  };

  const runOne = async (file, index) => {
    const slot = acquireWorker();
    let result;
    try {
      result = await processFile(file, options, slot);
    } catch (e) {
      result = { name: file.name, error: String((e && e.message) || e), outputPath: null };
      try {
        await workerRequest(slot.worker, { type: "release" }, [], "released");
      } catch (ignored) { /* worker already clean */ }
    } finally {
      releaseWorker(slot);
    }

    if (result.error) failed++;
    pending.set(index, { file, result, index });
    flushReady();

    done++;
    setBatchProgress(done, total);
    setFileLabel(file.name.length > 34 ? file.name.slice(0, 31) + "..." : file.name);
  };

  const concurrency = Math.min(poolSize(), total);
  const workersRunning = [];
  for (let i = 0; i < concurrency; i++) {
    workersRunning.push((async () => {
      while (started < total) {
        if (state.cancelRequested) return;
        const index = started++;
        await runOne(state.files[index], index);
      }
    })());
  }
  await Promise.all(workersRunning);
  if (state.cancelRequested) log(t("msg.cancelled", { done: done }));

  setFileProgress("", 0);
  ui.fileStage.textContent = "";
  setFileLabel(t("step3.currentFile"));
  ui.cancel.hidden = true;
  ui.start.disabled = state.files.length === 0;
  state.running = false;

  logRaw("");
  log(t("msg.finished", { done: done, failed: failed, produced: state.producedCount }));
  ui.download.disabled = state.producedCount === 0;
  ui.reset.disabled = false;
  ui.resetHint.hidden = state.producedCount === 0;
  if (state.producedCount > 0) log(t("msg.zipReady"));
}

/*
 * Clears everything a finished batch leaves behind so the next one starts
 * clean, without a page reload. The ZIP, the used-path registry and the
 * results table all have to go together: keeping any one of them would either
 * leak the previous batch's files into the next archive or make the dedupe
 * counter number files as if the old ones were still there.
 *
 * The genre map, the worker and the AudioContext are deliberately kept -- they
 * are expensive to rebuild and hold nothing batch-specific.
 */
function resetBatch() {
  if (state.running) return;

  state.zip = null;
  state.files = [];
  state.usedPaths = new Set();
  state.producedCount = 0;
  state.cancelRequested = false;

  ui.resultsBody.innerHTML = "";
  resultRows.length = 0;
  tableSort = { column: null, ascending: true };
  tableFilter = "";
  ui.tableFilter.value = "";
  ui.tableTools.hidden = true;
  ui.results.hidden = true;
  ui.progressBlock.hidden = true;
  setBatchProgress(0, 0);
  setFileProgress("", 0);
  setFileLabel(t("step3.currentFile"));
  ui.fileStage.textContent = "";

  ui.fileSummary.hidden = true;
  ui.fileSummary.innerHTML = "";
  ui.fileInput.value = "";
  ui.folderInput.value = "";

  ui.download.disabled = true;
  ui.reset.disabled = true;
  ui.resetHint.hidden = true;
  ui.start.disabled = true;

  logRaw("");
  log(t("msg.cleared"));
}

async function downloadZip() {
  ui.download.disabled = true;
  const previousLabel = ui.download.textContent;
  ui.download.textContent = t("msg.packing");
  try {
    const blob = await state.zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) => {
      ui.download.textContent = t("msg.packingPercent", { percent: Math.round(meta.percent) });
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "SortedMusic.zip";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    log(t("msg.archiveWritten", { size: (blob.size / (1024 * 1024)).toFixed(1) }));
  } catch (e) {
    log(t("msg.archiveFailed", { message: e.message }));
  }
  ui.download.textContent = previousLabel;
  ui.download.disabled = false;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

ui.pickFiles.addEventListener("click", () => ui.fileInput.click());
ui.pickFolder.addEventListener("click", () => ui.folderInput.click());
ui.fileInput.addEventListener("change", (e) => handleSelection(e.target.files));
ui.folderInput.addEventListener("change", (e) => handleSelection(e.target.files));

ui.stepLoudness.addEventListener("change", () => {
  ui.loudnessPanel.disabled = !ui.stepLoudness.checked;
});

ui.loudnessMode.addEventListener("change", () => {
  const mode = ui.loudnessMode.value;
  ui.targetLufs.disabled = mode === "convert_only";
  if (mode === "short_term" && ui.targetLufs.value === "-16") ui.targetLufs.value = "-14";
  if (mode === "integrated" && ui.targetLufs.value === "-14") ui.targetLufs.value = "-16";
});

ui.start.addEventListener("click", () => {
  if (!state.running) runBatch();
});

ui.cancel.addEventListener("click", () => {
  state.cancelRequested = true;
  log(t("msg.cancelRequested"));
});

ui.download.addEventListener("click", downloadZip);
ui.reset.addEventListener("click", resetBatch);

// The Last.fm key is the single biggest genre-accuracy win, so remember it
// rather than making the user paste it on every visit. localStorage is
// per-origin and never leaves the machine.
const LASTFM_STORAGE_KEY = "sortirovator.lastfmKey";
try {
  const saved = localStorage.getItem(LASTFM_STORAGE_KEY);
  if (saved) ui.lastfmKey.value = saved;
} catch (e) { /* private browsing blocks storage; not worth reporting */ }

ui.lastfmKey.addEventListener("change", () => {
  try {
    const value = ui.lastfmKey.value.trim();
    if (value) localStorage.setItem(LASTFM_STORAGE_KEY, value);
    else localStorage.removeItem(LASTFM_STORAGE_KEY);
  } catch (e) { /* ignore */ }
});

/*
 * Language is applied before probeEnvironment() so the very first log lines are
 * already in the chosen language rather than switching mid-scroll.
 */
function initLanguage() {
  const buttons = Array.from(document.querySelectorAll(".lang-button"));
  const paint = () => {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === getLanguage())));
  };
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      setLanguage(button.dataset.lang);
      paint();
      // The results table is already rendered, so its headers are re-read from
      // the table but existing rows keep the wording they were written with.
      // Only the log carries that risk, and rewriting past log lines would be
      // worse than leaving them.
    });
  });
  setLanguage(detectInitialLanguage());
  paint();
}

ui.tableFilter.addEventListener("input", () => {
  tableFilter = ui.tableFilter.value.trim().toLowerCase();
  renderResults();
});

ui.feedbackExport.addEventListener("click", () => {
  const entries = exportFeedback();
  if (feedbackCount() === 0) {
    log(t("feedback.none"));
    return;
  }
  // Same shape a server would receive, so the file doubles as a check on the
  // payload before any backend exists.
  const blob = new Blob([entries], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "genre-corrections.json";
  link.click();
  URL.revokeObjectURL(url);
});

ui.feedbackClear.addEventListener("click", () => {
  clearFeedback();
  log(t("feedback.cleared"));
});

/*
 * Shows which build is running.
 *
 * Needed because a tester behind the gate has no other way to tell: the page
 * source is not reachable, and "did my change actually deploy?" was otherwise
 * unanswerable without the Cloudflare dashboard. Selectable so it can be pasted
 * into a bug report.
 */
const versionBadge = el("app-version");
if (versionBadge) versionBadge.textContent = "v" + APP_VERSION;

initLanguage();
probeEnvironment();

/*
 * Corrections that never reached the server -- made offline, or during the
 * period before /api/feedback existed -- go out now. Deliberately after the
 * interface is up: this is the least urgent thing the page does, and it must
 * never be the reason the app is slow to become usable.
 */
flushFeedback();

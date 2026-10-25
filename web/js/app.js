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
const APP_VERSION = "2026.10.25.3";

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
  dropzone: el("dropzone"),
  runStatus: el("run-status"),
  archivePreview: el("archive-preview"),
  archiveSummary: el("archive-summary"),
  archiveTree: el("archive-tree"),
  tableHint: el("table-hint"),
  feedbackBlock: el("feedback-block"),
  lookupsPanel: el("lookups-panel"),
  lookupsState: el("lookups-state"),
  presetCustom: el("preset-custom"),
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

/*
 * A message the user has to see, not just the author.
 *
 * Until the log was hidden, "nothing to do", "finished" and "the archive could
 * not be built" were said only there, under a heading telling people it was
 * for developers. The status line under the run buttons says them now; the log
 * keeps its copy with the timestamp.
 */
/*
 * Counts a finished run: numbers only, built by usagePayload() in views.js.
 *
 * Fire and forget. Nothing waits for the answer and nothing can throw out of
 * here -- not a missing fetch, not a refused request, not an offline network --
 * because a count is worth nothing next to the batch it describes. keepalive
 * lets it finish if the tab is closed straight after the run.
 */
function reportUsage(run) {
  try {
    const payload = usagePayload(Object.assign({}, run, { version: APP_VERSION }));
    if (!payload) return;
    const sent = fetch("/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify(payload),
    });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch (e) { /* see above: never the user's problem */ }
}

function notify(key, values, target) {
  const line = target || ui.runStatus;
  line.textContent = t(key, values);
  line.hidden = false;
  log(t(key, values));
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

/*
 * macOS bookkeeping, not music.
 *
 * On a drive that is not formatted for the Mac -- the exFAT external SSD a DJ
 * library usually lives on -- Finder writes a "._name.mp3" beside every file
 * it touches, holding the resource fork. It has the right extension and a few
 * kilobytes of nothing, so it was counted as a track, sent to the decoder and
 * reported as a failure, once per real track in the folder.
 */
function isMacMetadata(file) {
  return file.name.startsWith("._") || file.name === ".DS_Store";
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(0);
}

/*
 * Scripts that are only needed once a batch starts.
 *
 * Nothing here is wanted to draw the page: the user has to pick files and press
 * a button first, which is far longer than the download takes. Loading them up
 * front made them two thirds of first paint on a page that may never run a
 * batch at all.
 *
 *   jszip       28 KB gzipped, builds the output archive
 *   identify.js 21 KB gzipped, filename parsing and the online lookups
 *
 * identify.js is safe to detach because it defines everything it uses and
 * nothing outside processFile() and resolveGenre() calls into it -- both of
 * which run inside a batch, after this has resolved.
 */
const _scriptPromises = new Map();

function loadScriptOnce(src, isLoaded) {
  if (isLoaded()) return Promise.resolve();
  const pending = _scriptPromises.get(src);
  if (pending) return pending;
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src + "?v=" + APP_VERSION;
    script.onload = () => resolve();
    script.onerror = () => {
      // Cleared so a later attempt can retry rather than reuse the rejection.
      _scriptPromises.delete(src);
      reject(new Error(src + " failed to load"));
    };
    document.head.appendChild(script);
  });
  _scriptPromises.set(src, promise);
  return promise;
}

function ensureZipLibrary() {
  return loadScriptOnce("js/lib/jszip.min.js", () => typeof JSZip !== "undefined");
}

function ensureIdentifyLibrary() {
  return loadScriptOnce("js/identify.js", () => typeof parseFilename !== "undefined");
}

function handleSelection(fileList) {
  // The batch reads state.files by index as it goes, so swapping the list
  // underneath it -- easy now that a folder can be dropped at any moment --
  // would mix two selections in one archive.
  if (state.running) {
    notify("msg.busy");
    return;
  }
  // Silently: these were never the user's files, so "3 skipped" would only
  // send them looking for tracks that do not exist.
  const all = Array.from(fileList).filter((f) => !isMacMetadata(f));
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
  if (!state.running) ui.runStatus.hidden = true;
  log(t("msg.selected", {
    count: accepted.length,
    skipped: wrongType.length + tooBig.length,
  }));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/*
 * Every file in what was dropped, folders opened all the way down.
 *
 * dataTransfer.files lists a dropped folder as one useless entry, so folders
 * are walked through the entry API instead. readEntries hands a directory back
 * in pieces -- Chrome stops at 100 per call -- and has to be called until it
 * returns nothing, or a big genre folder arrives as its first hundred tracks.
 */
async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length === 0) return Array.from(dataTransfer.files || []);

  const files = [];
  const readAll = (reader) => new Promise((resolve, reject) => {
    const batch = [];
    const next = () => reader.readEntries((chunk) => {
      if (chunk.length === 0) resolve(batch);
      else { batch.push(...chunk); next(); }
    }, reject);
    next();
  });
  const walk = async (entry) => {
    if (entry.isFile) {
      files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child);
    }
  };
  // The entries have to be taken before the first await: the browser empties
  // the DataTransfer as soon as the drop handler yields.
  for (const entry of entries) await walk(entry);
  return files;
}

/*
 * Makes `zone` accept drops and hands what was dropped to `onFiles`.
 *
 * The highlight is counted rather than toggled because dragenter and dragleave
 * fire for every child the pointer crosses; a boolean flickers off over the
 * buttons inside the zone.
 */
function acceptDrops(zone, onFiles) {
  let depth = 0;
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    depth++;
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove("dragging");
  });
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    zone.classList.remove("dragging");
    const files = await filesFromDrop(event.dataTransfer);
    onFiles(files);
  });
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
  /*
   * The decision itself lives in identify.js, next to the lookups it drives, so
   * that it can be measured against a real library without a browser. What
   * stays here is the two things it needs that only the page can supply: the
   * user's own corrections and the translated labels.
   */
  return resolveGenreFrom(context, { correctionFor, t });
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
    duration: null,
    taggedFields: null,
    tagNote: null,
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

  /*
   * The file's own tags name the artist and the title; the filename only hints
   * at them. That ordering used to be reversed here -- the filename was parsed
   * first and the tags consulted only if the parse produced nothing, which
   * almost never happened, because 98% of names contain a separator. So the
   * tags were read and thrown away.
   *
   * It matters because the filename is genuinely ambiguous: measured on a real
   * library, 22% of names are "Title - Artist" rather than "Artist - Title",
   * and parseFilename can only tell the two apart a third of the time. The tags
   * are not ambiguous, and 88% of the same files carry both fields.
   *
   * The filename remains the fallback, and it is still what naming and sorting
   * work from -- this only decides what gets sent to a lookup.
   */
  let parsed = parseFilename(tidied.cleaned + fileExtension(file.name));
  let artist = usableTag(tags.artist) || parsed.artist;
  let track = withoutArtistPrefix(usableTag(tags.title) || parsed.track, artist);
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
    // Kept before the buffer is released: a playlist entry wants the length in
    // seconds, and this is the only place it is known.
    result.duration = audioBuffer.duration;
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
      tags, artist, track, genresMap: state.genresMap, options, recordingId,
    });
    result.genre = resolved.genre;
    result.genreSource = resolved.source;
    result.genreWeak = resolved.weak === true;
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
      const safe = safeGainDb(options.loudness.targetLufs, current,
        analysis.truePeakDb, options.loudness.safeLimiter);
      gainDb = safe.gainDb;
      result.gainLimited = safe.limited;
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

  outputBlob = await tagOutput(result, outputExtension, outputBlob);

  const folder = options.steps.sort && result.genre
    ? genreFolderName(result.genre) + "/" : "";
  result.outputPath = uniquePath(folder + prefix + stem + outputExtension);
  state.zip.file(result.outputPath, outputBlob);
  state.producedCount++;

  return result;
}

/*
 * The gain that reaches the loudness target without clipping.
 *
 * Normalising a track that is quieter than the target turns it up, and nothing
 * stopped that from pushing its peaks past full scale. The encoder clamps each
 * sample to [-1, 1] -- so there is no wrap-around crackle -- but a clamped
 * sample is a hard-clipped one, and hard clipping is audible distortion. With
 * the limiter off, which is the default, a quiet recording asked to reach -16
 * LUFS came back louder and broken, and nothing said so.
 *
 * So without the limiter the gain is capped where the measured true peak would
 * land on the ceiling, and the track is reported as not having reached its
 * target. Quieter and clean is the right trade: a DJ can raise a fader, but
 * cannot remove distortion. With the limiter on it handles the peaks itself, so
 * the full gain is applied.
 *
 * A track already louder than the target is turned down and is never affected.
 */
const TRUE_PEAK_CEILING_DB = -1.0;

function safeGainDb(targetLufs, measuredLufs, truePeakDb, limiterOn) {
  if (measuredLufs === null || measuredLufs === undefined || !Number.isFinite(measuredLufs)) {
    return { gainDb: 0, limited: false };
  }
  const wanted = targetLufs - measuredLufs;
  if (limiterOn || wanted <= 0 || truePeakDb === null || truePeakDb === undefined
      || !Number.isFinite(truePeakDb)) {
    return { gainDb: wanted, limited: false };
  }
  const headroom = TRUE_PEAK_CEILING_DB - truePeakDb;
  if (wanted <= headroom) return { gainDb: wanted, limited: false };
  // A peak already above the ceiling leaves no room to turn up at all.
  return { gainDb: Math.max(0, headroom), limited: true };
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

  if (result.taggedFields) {
    lines.push(t("res.tagged", { fields: result.taggedFields.join(", ") }));
  } else if (result.tagNote) {
    lines.push(t("res.tagSkipped." + result.tagNote));
  }
  if (result.gainLimited) {
    lines.push(t("res.gainLimited", { gain: result.gainDb }));
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
// The row whose details are open under it, by index into resultRows.
let openRow = null;

function addResultRow(result) {
  resultRows.push(result);
  renderResults();
}

function resultCells(result, index) {
  const keyText = result.key
    ? (result.keyConfident ? result.key : result.key + "?") +
      (result.keyConfidence !== null ? " (" + result.keyConfidence.toFixed(2) + ")" : "")
    : "—";
  // A file that failed never gets a bpm field at all, so it is undefined rather
  // than null -- and `undefined === null` is false, which printed "undefined".
  const bpmText = result.bpm === null || result.bpm === undefined ? "—"
    : result.bpmMode === "dynamic" ? result.bpm + "~" : String(result.bpm);
  const loudnessText = result.browseLufs !== null && result.browseLufs !== undefined
    ? result.browseLufs.toFixed(1) + " LUFS"
    : "—";
  const genreCell = result.genre
    ? '<button type="button" class="genre-edit" data-row="' + index + '">' +
      escapeHtml(result.genre) +
      // A guess from the artist's career, not the track: shown the way an unsure
      // key already is, so the one field worth checking is the one marked.
      (result.genreWeak ? '<span class="genre-weak" title="' +
        escapeHtml(t("table.genreWeak")) + '">?</span>' : "") +
      '<span class="genre-edit-mark">✎</span></button>'
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
    case "bpm": return typeof result.bpm === "number" ? result.bpm : -1;
    // Camelot order, not text order: as text, 10A files before 2A.
    case "key": return camelotOrder(result.key);
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
    .map((row) => {
      const open = row.index === openRow;
      return '<tr class="track-row' + (open ? " open" : "") + '" tabindex="0" aria-expanded="' + open +
        '" data-track="' + row.index + '">' +
        resultCells(row.result, row.index) + "</tr>" +
        (open ? '<tr class="detail-row"><td colspan="7">' + detailHtml(row.index) + "</td></tr>" : "");
    })
    .join("");
  ui.results.hidden = resultRows.length === 0;
  ui.tableTools.hidden = resultRows.length === 0;
  ui.tableHint.hidden = resultRows.length === 0;
  ui.feedbackBlock.hidden = resultRows.length === 0;
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
      notify("feedback.saved", { genre: chosen, count: feedbackCount() });
    }
    renderResults();
  };
  select.addEventListener("change", () => finish(true));
  select.addEventListener("blur", () => finish(false));
  select.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); });
}

/*
 * What opens under a track when its row is clicked: the tracks in this batch
 * it mixes with, then the reasoning the log used to be the only place for --
 * where the genre came from, how sure the key is, what was done to the audio.
 */
function trackLabel(result) {
  return result.feedbackArtist && result.feedbackTitle
    ? result.feedbackArtist + " — " + result.feedbackTitle
    : result.name;
}

function mixTempoText(neighbour) {
  if (neighbour.delta === null) return "";
  const percent = neighbour.delta * 100;
  const text = Math.abs(percent) < 0.05 ? "±0%"
    : (percent > 0 ? "+" : "−") + Math.abs(percent).toFixed(1) + "%";
  if (neighbour.factor === 1) return text;
  return text + " · " + t(neighbour.factor === 2 ? "mix.half" : "mix.double");
}

let whyOpen = false;

function detailHtml(index) {
  const result = resultRows[index];
  const parts = [];
  if (!result.error) {
    const neighbours = mixNeighbours(resultRows, index);
    parts.push('<div class="mix"><h4>' + escapeHtml(t("mix.title")) + "</h4>");
    if (neighbours.length === 0) {
      const measured = parseCamelot(result.key) !== null || result.bpm > 0;
      parts.push('<p class="hint">' + escapeHtml(t(measured ? "mix.none" : "mix.noData")) + "</p>");
    } else {
      if (neighbours.some((n) => n.delta !== null)) {
        parts.push('<p class="hint mix-hint">' + escapeHtml(t("mix.tempoHint")) + "</p>");
      }
      parts.push('<ul class="mix-list">' + neighbours.map((n) => {
        const other = resultRows[n.index];
        const meta = [
          other.key ? other.key + (other.keyConfident ? "" : "?") : null,
          n.relation ? t("mix." + n.relation) : null,
          typeof other.bpm === "number" ? other.bpm + " BPM" : null,
          mixTempoText(n),
        ].filter(Boolean).join(" · ");
        return '<li><button type="button" class="mix-track" data-open="' + n.index + '">' +
          escapeHtml(trackLabel(other)) + '</button> <span class="mix-meta">' +
          escapeHtml(meta) + "</span></li>";
      }).join("") + "</ul>");
    }
    parts.push("</div>");
  }
  parts.push('<details class="why"' + (whyOpen ? " open" : "") + "><summary>" +
    escapeHtml(t("mix.details")) + "</summary><pre>" +
    escapeHtml(describeResult(result).map((line) => line.trim()).join("\n")) +
    "</pre></details>");
  return parts.join("");
}

function toggleRow(index) {
  openRow = openRow === index ? null : index;
  renderResults();
}

ui.resultsBody.addEventListener("click", (event) => {
  const button = event.target.closest(".genre-edit");
  if (button) {
    openGenreEditor(button);
    return;
  }
  // A track in the mix list opens its own neighbours, so a set can be walked
  // through from one record to the next.
  const jump = event.target.closest(".mix-track");
  if (jump) {
    openRow = Number(jump.dataset.open);
    renderResults();
    const row = ui.resultsBody.querySelector('tr[data-track="' + openRow + '"]');
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  if (event.target.closest(".genre-picker, .detail-row")) return;
  const row = event.target.closest("tr.track-row");
  if (row) toggleRow(Number(row.dataset.track));
});

ui.resultsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest && event.target.closest("tr.track-row");
  if (!row || event.target !== row) return;
  event.preventDefault();
  toggleRow(Number(row.dataset.track));
});

// The table is redrawn as each track finishes, so the reasoning block would
// snap shut under the reader every few seconds without this.
ui.resultsBody.addEventListener("toggle", (event) => {
  if (event.target.classList && event.target.classList.contains("why")) whyOpen = event.target.open;
}, true);

// Scoped to its own table. It used to take the first <thead> in the document,
// which only worked while this was the only table on the page.
ui.results.querySelector("thead").addEventListener("click", (event) => {
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

/*
 * Getting the browser to let the page play audio.
 *
 * Decoding needs a running AudioContext, and browsers only start one in
 * response to a user's own click. The context used to be created inside the
 * batch, after the scripts it needs had been fetched -- so after a network
 * wait. Chrome counts any earlier click on the page; Safari only allows it
 * within a few seconds of the click, so on a slow connection the context
 * stayed suspended, resume() never settled, and the batch hung on "starting"
 * with nothing on screen to say why.
 *
 * So it is started in two places. unlockAudio() runs synchronously inside the
 * click handler, while the click still counts. audioReady() then checks inside
 * the batch, and gives up after AUDIO_RESUME_TIMEOUT_MS instead of waiting
 * forever: the batch stops before it begins and the user is asked to press
 * the button again, which is itself the click the browser wants.
 */
const AUDIO_RESUME_TIMEOUT_MS = 3000;

function unlockAudio() {
  try {
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioContext.state === "suspended") {
      const resumed = state.audioContext.resume();
      if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
    }
  } catch (e) { /* audioReady() reports it inside the batch */ }
}

async function audioReady(context, timeoutMs) {
  if (!context) return false;
  if (context.state === "running") return true;
  try {
    await Promise.race([
      Promise.resolve(context.resume()),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (e) {
    return false;
  }
  return context.state === "running";
}

async function runBatch() {
  const options = readOptions();
  if (!options.steps.fixNames && !options.steps.sort && !options.steps.bpmKey && !options.steps.loudness) {
    notify("msg.nothingToDo");
    return;
  }

  try {
    await Promise.all([ensureZipLibrary(), ensureIdentifyLibrary()]);
  } catch (e) {
    notify("msg.zipUnavailable");
    return;
  }

  // Only steps that decode audio need it; "fix names" alone reads tags.
  const needsAudio = options.steps.sort || options.steps.bpmKey || options.steps.loudness;
  if (needsAudio) {
    unlockAudio();
    if (!(await audioReady(state.audioContext, AUDIO_RESUME_TIMEOUT_MS))) {
      notify("msg.audioBlocked");
      return;
    }
  }
  ui.runStatus.hidden = true;
  ui.archivePreview.hidden = true;
  openRow = null;

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

  await loadGenresMap();

  const total = state.files.length;
  setBatchProgress(0, total);
  log(t("msg.batchStart", { total: total }));
  log(t("msg.steps", { steps: Object.keys(options.steps).filter((k) => options.steps[k]).join(", ") }));

  let done = 0;
  let failed = 0;
  let started = 0;
  const startedAt = Date.now();

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

  setFileProgress("", 0);
  ui.fileStage.textContent = "";
  setFileLabel(t("step3.currentFile"));
  ui.cancel.hidden = true;
  ui.start.disabled = state.files.length === 0;
  state.running = false;

  logRaw("");
  ui.download.disabled = state.producedCount === 0;
  ui.reset.disabled = false;
  ui.resetHint.hidden = state.producedCount === 0;
  if (state.producedCount > 0) {
    const playlists = writePlaylists(options);
    if (playlists > 0) {
      log(t("msg.playlistsWritten", { count: playlists, folder: PLAYLIST_FOLDER }));
    }
    renderArchivePreview();
  }
  notify(state.cancelRequested ? "msg.cancelled" : "msg.finished",
    { done: done, failed: failed, produced: state.producedCount });
  reportUsage({
    mode: "files", steps: options.steps, tracks: done, failed: failed,
    seconds: (Date.now() - startedAt) / 1000,
  });
}

/*
 * The archive's folders and playlists, shown before it is downloaded.
 *
 * Until now the only way to see where a batch had put things was to download
 * the ZIP and unpack it -- a few hundred megabytes to find out that a genre
 * came out wrong. Each folder opens to the files in it.
 */
const ARCHIVE_PREVIEW_FILES = 200;

function renderArchivePreview() {
  if (!state.zip) return;
  const paths = [];
  state.zip.forEach((path, entry) => { if (!entry.dir) paths.push(path); });
  const tree = archiveTree(paths, PLAYLIST_FOLDER);

  const fileList = (files) => {
    const shown = files.slice(0, ARCHIVE_PREVIEW_FILES)
      .map((name) => "<li>" + escapeHtml(name) + "</li>").join("");
    const more = files.length > ARCHIVE_PREVIEW_FILES
      ? "<li class=\"muted\">" + escapeHtml(t("archive.more", { count: files.length - ARCHIVE_PREVIEW_FILES })) + "</li>"
      : "";
    return "<ul>" + shown + more + "</ul>";
  };

  let html = tree.folders.map((folder) =>
    '<details class="archive-folder' + (folder.playlists ? " playlists" : "") + '"><summary>' +
    '<span class="folder-name">' + escapeHtml(folder.name) + "/</span>" +
    '<span class="folder-count">' + folder.files.length + "</span></summary>" +
    fileList(folder.files) + "</details>").join("");
  if (tree.rootFiles.length > 0) {
    html += '<details class="archive-folder"><summary><span class="folder-name">' +
      escapeHtml(t("archive.root")) + '</span><span class="folder-count">' +
      tree.rootFiles.length + "</span></summary>" + fileList(tree.rootFiles) + "</details>";
  }

  const playlists = tree.folders.find((folder) => folder.playlists);
  const tracks = paths.length - (playlists ? playlists.files.length : 0);
  const folders = tree.folders.length - (playlists ? 1 : 0);
  ui.archiveSummary.textContent = t("archive.summary", {
    tracks, folders, playlists: playlists ? playlists.files.length : 0,
  });
  ui.archiveTree.innerHTML = html;
  ui.archivePreview.hidden = false;
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
  openRow = null;
  tableSort = { column: null, ascending: true };
  tableFilter = "";
  ui.tableFilter.value = "";
  ui.tableTools.hidden = true;
  ui.tableHint.hidden = true;
  ui.feedbackBlock.hidden = true;
  ui.results.hidden = true;
  ui.progressBlock.hidden = true;
  ui.archivePreview.hidden = true;
  ui.archiveTree.innerHTML = "";
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
  notify("msg.cleared");
}

/* ------------------------------------------------------------------ */
/* Tag writing                                                         */
/* ------------------------------------------------------------------ */

/*
 * Largest output we will rewrite tags into.
 *
 * Tagging needs the whole file in memory at once -- an ID3 tag goes in front of
 * the audio and a RIFF chunk goes after it, so either way the bytes are copied
 * -- and that copy lands beside the decoded buffers several workers are already
 * holding. A track this big is a recorded set rather than a song, and a missing
 * genre tag on it costs far less than a killed tab costs the whole batch.
 */
const TAG_MAX_BYTES = 200 * 1024 * 1024;

/*
 * Writes the batch's findings into the output copy, in place of it going out
 * with the tags it arrived with.
 *
 * Never fatal. Everything here is an improvement on a file that is already
 * correct without it, so a container we cannot write, a file too large to copy,
 * or an unexpected failure all end the same way: the original blob is returned
 * untouched and the reason is recorded for the log.
 */
async function tagOutput(result, extension, blob) {
  const fields = {
    title: result.feedbackTitle || null,
    artist: result.feedbackArtist || null,
    genre: result.genre && result.genre !== "Unknown" ? result.genre : null,
    bpm: typeof result.bpm === "number" && result.bpm > 0 ? String(result.bpm) : null,
    key: result.key || null,
  };
  const present = Object.keys(fields).filter((k) => fields[k]);
  if (present.length === 0) return blob;

  const kind = String(extension || "").toLowerCase();
  if (kind !== ".mp3" && kind !== ".wav") {
    result.tagNote = "format";
    return blob;
  }
  if (blob.size > TAG_MAX_BYTES) {
    result.tagNote = "size";
    return blob;
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const tagged = writeTags(bytes, kind, fields);
    if (!tagged) {
      result.tagNote = "format";
      return blob;
    }
    result.taggedFields = present;
    return new Blob([tagged], { type: blob.type });
  } catch (e) {
    result.tagNote = "failed";
    return blob;
  }
}

/* ------------------------------------------------------------------ */
/* Playlists                                                           */
/* ------------------------------------------------------------------ */

/*
 * Writes .m3u8 playlists alongside the sorted folders.
 *
 * A folder of files is not a set. Rekordbox imports .m3u8 directly, so the
 * work the batch already did -- the genre it decided on, the tempo and the key
 * it measured -- can arrive as playlists instead of being re-derived by hand
 * after the archive is unpacked.
 *
 * The files sit in their own folder and point at the tracks with relative
 * paths, so the archive can be unpacked anywhere as long as it is unpacked
 * whole. UTF-8 with CRLF line endings, which is what .m3u8 means and what every
 * player agrees on.
 *
 * Two kinds are written. Per-genre playlists mirror the folders. The other two
 * are the whole batch in a useful order rather than a subset: by tempo, and
 * around the Camelot wheel, so that scrolling one puts tracks that mix next to
 * each other. Ordering rather than filtering keeps this to a handful of files
 * instead of the twenty-four a playlist-per-key would produce.
 */
const PLAYLIST_FOLDER = "Playlists";

// 1A, 1B, 2A ... 12B. Sorting the text would file 10A before 2A.
const CAMELOT_KEY = /^(\d{1,2})([AB])$/;

function camelotOrder(key) {
  const match = CAMELOT_KEY.exec(String(key || "").trim().toUpperCase());
  if (!match) return Infinity;
  const number = parseInt(match[1], 10);
  if (number < 1 || number > 12) return Infinity;
  return (number - 1) * 2 + (match[2] === "A" ? 0 : 1);
}

function playlistEntry(result) {
  const path = result.outputPath;
  /*
   * A line break inside a path would end the entry early and leave the rest of
   * the name standing as its own bogus playlist line. Nothing we write produces
   * one -- the filename sanitizer would have to let a control character through
   * -- so dropping the track is enough, and is better than emitting a file that
   * looks fine until a player reads it.
   */
  if (!path || /[\r\n]/.test(path)) return null;

  const seconds = Number.isFinite(result.duration) && result.duration > 0
    ? Math.round(result.duration) : -1;
  const artist = result.feedbackArtist;
  const title = result.feedbackTitle;
  const fallback = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const label = (artist && title) ? artist + " - " + title : (title || artist || fallback);

  return "#EXTINF:" + seconds + "," + label.replace(/[\r\n]+/g, " ") + "\r\n" + "../" + path;
}

function playlistBody(results) {
  const lines = [];
  for (const result of results) {
    const entry = playlistEntry(result);
    if (entry) lines.push(entry);
  }
  return lines.length === 0 ? null : "#EXTM3U\r\n" + lines.join("\r\n") + "\r\n";
}

function writePlaylists(options) {
  if (!state.zip) return 0;
  const produced = resultRows.filter((r) => r && !r.error && r.outputPath);
  if (produced.length === 0) return 0;

  let written = 0;
  const add = (name, rows) => {
    const body = playlistBody(rows);
    if (!body) return;
    state.zip.file(PLAYLIST_FOLDER + "/" + name + ".m3u8", body);
    written++;
  };

  add("All tracks", produced);

  const byTempo = produced.filter((r) => typeof r.bpm === "number" && r.bpm > 0);
  if (byTempo.length > 1) {
    add("By BPM", byTempo.slice().sort((a, b) => a.bpm - b.bpm));
  }

  /*
   * Loudness, and named as loudness rather than as energy.
   *
   * Sorting by "energy" is what the competition offers, and it is the one thing
   * here that cannot be checked. The library holds no energy field -- no colour
   * tags, no My Tags, nothing in the comments -- and the only proxy available,
   * the order tracks were played in across fourteen recorded sets, correlates
   * with tempo at rho +0.17, t = 2.06. That is a measuring stick made of noise,
   * and a number validated against it would mean nothing.
   *
   * So this sorts by what was actually measured. LUFS is a real quantity with a
   * definition, already computed for every track. It is not energy: modern
   * masters are compressed, so a quiet record and a loud one often differ by
   * the mastering rather than by the music. Quiet first, the direction a warm-up
   * runs.
   */
  const byLoudness = produced.filter((r) => typeof r.browseLufs === "number");
  if (byLoudness.length > 1) {
    add("By loudness", byLoudness.slice().sort((a, b) => a.browseLufs - b.browseLufs));
  }

  const byKey = produced.filter((r) => camelotOrder(r.key) !== Infinity);
  if (byKey.length > 1) {
    // Within one key, slowest first, so a run through the playlist is also a
    // run up the tempo rather than jumping around inside each key.
    add("By key", byKey.slice().sort((a, b) =>
      camelotOrder(a.key) - camelotOrder(b.key) || (a.bpm || 0) - (b.bpm || 0)));
  }

  /*
   * Per-genre lists only when sorting produced the folders they mirror, and
   * only when there is more than one: a single playlist naming every track in
   * the archive is what "All tracks" already is.
   */
  if (options.steps.sort) {
    const groups = new Map();
    for (const result of produced) {
      if (!result.genre || result.genre === "Unknown") continue;
      const folder = genreFolderName(result.genre);
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(result);
    }
    if (groups.size > 1) {
      for (const folder of [...groups.keys()].sort()) add(folder, groups.get(folder));
    }
  }

  return written;
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
    notify("msg.archiveFailed", { message: e.message });
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
acceptDrops(ui.dropzone, handleSelection);

/*
 * A file dropped anywhere but a drop zone is opened by the browser in place of
 * the page -- which, halfway through a batch, throws the batch away. Refusing
 * the drop everywhere else makes a near miss harmless.
 */
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

/* Presets: four switches set in one click, and the switches still win. */
const stepSwitches = {
  fixNames: ui.stepFixNames, sort: ui.stepSort, bpmKey: ui.stepBpmKey, loudness: ui.stepLoudness,
};

function syncStepsUi() {
  const steps = {};
  for (const name of Object.keys(stepSwitches)) steps[name] = stepSwitches[name].checked;
  const active = matchPreset(steps);
  document.querySelectorAll(".chip[data-preset]").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.preset === active));
  });
  ui.presetCustom.hidden = active !== null;
  ui.loudnessPanel.disabled = !ui.stepLoudness.checked;
  ui.loudnessPanel.hidden = !ui.stepLoudness.checked;
}

document.querySelectorAll(".chip[data-preset]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const preset = PRESETS.find((p) => p.id === chip.dataset.preset);
    if (!preset) return;
    for (const name of Object.keys(stepSwitches)) stepSwitches[name].checked = preset.steps[name];
    syncStepsUi();
  });
});
for (const box of Object.values(stepSwitches)) box.addEventListener("change", syncStepsUi);
syncStepsUi();

/*
 * The lookups block is closed by default, so its heading says what is on:
 * otherwise "Last.fm is not being asked" is only discoverable by opening it.
 */
function syncLookupsState() {
  const on = [];
  if (ui.useDiscogs.checked) on.push("Discogs");
  if (ui.useMusicbrainz.checked) on.push("iTunes", "MusicBrainz");
  if (ui.lastfmKey.value.trim()) on.push("Last.fm");
  ui.lookupsState.textContent = on.length === 0 ? t("lookups.stateNone")
    : "— " + on.join(" · ") + (ui.lastfmKey.value.trim() ? "" : " " + t("lookups.stateNoKey"));
}
[ui.useDiscogs, ui.useMusicbrainz].forEach((box) => box.addEventListener("change", syncLookupsState));
ui.lastfmKey.addEventListener("input", syncLookupsState);

/*
 * The two modes. Remembered per browser, and also reachable as #rekordbox so a
 * link can open the page on the collection tool directly.
 */
const MODE_STORAGE_KEY = "sortirovator.mode";
const MODES = ["files", "rekordbox"];

function showMode(mode) {
  if (!MODES.includes(mode)) mode = "files";
  for (const name of MODES) {
    const tab = el("mode-" + name);
    tab.setAttribute("aria-selected", String(name === mode));
    tab.tabIndex = name === mode ? 0 : -1;
    el("mode-" + name + "-panel").hidden = name !== mode;
  }
  // The lookup switches follow whichever mode is showing; see index.html.
  const slot = document.querySelector('.lookups-slot[data-slot="' + mode + '"]');
  if (slot && ui.lookupsPanel.parentNode !== slot) slot.appendChild(ui.lookupsPanel);
  try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch (e) { /* ignore */ }
  const hash = mode === "files" ? "" : "#" + mode;
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
}

MODES.forEach((name, i) => {
  const tab = el("mode-" + name);
  tab.addEventListener("click", () => showMode(name));
  // Arrow keys move between tabs, as in any tab list.
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = MODES[(i + (event.key === "ArrowRight" ? 1 : MODES.length - 1)) % MODES.length];
    showMode(next);
    el("mode-" + next).focus();
  });
});

function initialMode() {
  const fromHash = location.hash.replace(/^#/, "");
  if (MODES.includes(fromHash)) return fromHash;
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (MODES.includes(saved)) return saved;
  } catch (e) { /* ignore */ }
  return "files";
}
showMode(initialMode());

ui.loudnessMode.addEventListener("change", () => {
  const mode = ui.loudnessMode.value;
  ui.targetLufs.disabled = mode === "convert_only";
  if (mode === "short_term" && ui.targetLufs.value === "-16") ui.targetLufs.value = "-14";
  if (mode === "integrated" && ui.targetLufs.value === "-14") ui.targetLufs.value = "-16";
});

ui.start.addEventListener("click", () => {
  if (state.running) return;
  // Before anything awaits: this is the moment the browser counts as the click.
  unlockAudio();
  runBatch();
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

syncLookupsState();

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
      // Text the page builds itself, rather than fills from data-i18n.
      syncLookupsState();
      if (resultRows.length > 0) renderResults();
      if (!ui.archivePreview.hidden) renderArchivePreview();
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
    notify("feedback.none");
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
  notify("feedback.cleared");
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
/* ------------------------------------------------------------------ */
/* Rekordbox collection: genres without touching the files             */
/* ------------------------------------------------------------------ */

/*
 * Reads a Rekordbox collection export, looks up a genre for each track by its
 * artist and title, and offers an XML to import back holding only the tracks
 * that changed. The parsing and writing live in rekordbox.js; this is the page
 * around them.
 *
 * Nothing is written without being seen first. Every proposed change is a row
 * with a checkbox, because a confident answer can still be wrong -- on a sample
 * of the owner's collection Discogs filed a drum & bass producer as Rock by
 * matching a rock band of the same name -- and this lands in a working DJ's
 * library. Guesses drawn from the artist rather than the track, right about one
 * time in five, arrive unticked.
 */
const rb = {
  text: null,
  parsed: null,
  rows: [],
  running: false,
  stopRequested: false,
};

const rbUi = {
  pick: el("rb-pick"),
  input: el("rb-input"),
  summary: el("rb-summary"),
  controls: el("rb-controls"),
  onlyEmpty: el("rb-only-empty"),
  start: el("rb-start"),
  stop: el("rb-stop"),
  download: el("rb-download"),
  progress: el("rb-progress"),
  bar: el("rb-bar"),
  counter: el("rb-counter"),
  status: el("rb-status"),
  wait: el("rb-wait"),
  written: el("rb-written"),
  dropzone: el("rb-dropzone"),
  table: el("rb-table"),
  body: el("rb-body"),
  all: el("rb-all"),
};

// The playlist the output carries, so the tracks are one selection away on the
// rekordbox xml tab. The import instructions name it, so it is not translated.
const RB_PLAYLIST = "Музыкальный сортир — жанры";

function ensureRekordboxLibrary() {
  return loadScriptOnce("js/rekordbox.js", () => typeof readRekordboxXml !== "undefined");
}

function rbEta(msPerTrack, remaining) {
  const minutes = Math.max(1, Math.round((msPerTrack * remaining) / 60000));
  if (minutes < 60) return t("rb.minutes", { n: minutes });
  return t("rb.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

function rbSetStatus(key, params) {
  rbUi.status.hidden = false;
  rbUi.status.textContent = t(key, params);
}

function rbRowHtml(row, index) {
  const weakMark = row.weak
    ? '<span class="genre-weak" title="' + escapeHtml(t("rb.weakSource")) + '">?</span>'
    : "";
  return '<tr><td><input type="checkbox" data-rb-row="' + index + '"' +
    (row.checked ? " checked" : "") + "></td>" +
    "<td>" + escapeHtml(row.artist || "—") + "</td>" +
    "<td>" + escapeHtml(row.title || "—") + "</td>" +
    '<td class="muted">' + escapeHtml(row.was || "—") + "</td>" +
    "<td>" + escapeHtml(row.genre) + weakMark + "</td>" +
    '<td class="muted">' + escapeHtml(row.source || "") + "</td></tr>";
}

function rbRefreshDownload() {
  rbUi.download.disabled = rb.running || !rb.rows.some((row) => row.checked);
}

async function rbLoad(file) {
  rb.text = null;
  rb.parsed = null;
  rb.rows = [];
  rbUi.body.innerHTML = "";
  rbUi.table.hidden = true;
  rbUi.status.hidden = true;
  rbUi.progress.hidden = true;
  rbUi.controls.hidden = true;
  rbUi.wait.hidden = false;
  rbUi.written.hidden = true;
  rbRefreshDownload();
  try {
    await ensureRekordboxLibrary();
    const text = await file.text();
    const parsed = readRekordboxXml(text);
    rb.text = text;
    rb.parsed = parsed;
    const empty = parsed.tracks.filter((track) => !(track.attrs.Genre || "").trim()).length;
    rbUi.summary.textContent = t("rb.loaded", { total: parsed.tracks.length, empty });
    rbUi.summary.hidden = false;
    rbUi.controls.hidden = false;
    rbUi.wait.hidden = true;
  } catch (e) {
    rbUi.summary.textContent = t("rb.badFile", { message: (e && e.message) || String(e) });
    rbUi.summary.hidden = false;
  }
}

async function rbRun() {
  if (!rb.parsed || rb.running) return;
  const candidates = rb.parsed.tracks.filter((track) =>
    (!rbUi.onlyEmpty.checked || !(track.attrs.Genre || "").trim()) &&
    ((track.attrs.Artist || "").trim() || (track.attrs.Name || "").trim()));
  if (candidates.length === 0) {
    rbSetStatus("rb.nothing");
    return;
  }

  rb.running = true;
  rb.stopRequested = false;
  rb.rows = [];
  rbUi.body.innerHTML = "";
  rbUi.table.hidden = true;
  rbUi.start.hidden = true;
  rbUi.stop.hidden = false;
  rbUi.progress.hidden = false;
  rbRefreshDownload();

  await ensureIdentifyLibrary();
  const genresMap = await loadGenresMap();
  // The lookup switches and the Last.fm key are the ones set in step 2.
  const options = readOptions();

  const total = candidates.length;
  let done = 0;
  let found = 0;
  let guessed = 0;
  let unknown = 0;
  let failedLookups = 0;
  const started = Date.now();

  for (const track of candidates) {
    if (rb.stopRequested) break;
    const names = lookupNames(track.attrs, parseFilename);
    names.title = withoutArtistPrefix(names.title, names.artist);
    const was = (track.attrs.Genre || "").trim();
    let resolved = { genre: "Unknown" };
    try {
      resolved = await resolveGenreFrom({
        // The collection's current genre stands in for the file tag, so a track
        // no source knows keeps the genre it has instead of being cleared.
        tags: { genre: was || null },
        artist: names.artist,
        track: names.title,
        genresMap,
        options,
        recordingId: null,
      }, { correctionFor, t });
    } catch (e) {
      resolved = { genre: "Unknown" };
      failedLookups++;
    }

    done++;
    const genre = resolved && resolved.genre;
    if (!genre || genre === "Unknown") {
      unknown++;
    } else if (genre !== was) {
      if (resolved.weak) guessed++; else found++;
      const row = {
        id: track.id,
        artist: names.artist,
        title: names.title,
        was,
        genre,
        weak: resolved.weak === true,
        source: resolved.source || "",
        checked: resolved.weak !== true,
      };
      rb.rows.push(row);
      rbUi.table.hidden = false;
      rbUi.body.insertAdjacentHTML("beforeend", rbRowHtml(row, rb.rows.length - 1));
      rbRefreshDownload();
    }

    rbUi.bar.style.width = ((100 * done) / total).toFixed(1) + "%";
    rbUi.counter.textContent = done + " / " + total;
    const msPerTrack = (Date.now() - started) / done;
    rbSetStatus(done < total ? "rb.status" : "rb.statusDone", {
      done, total, found, guessed, unknown, eta: rbEta(msPerTrack, total - done),
    });
  }

  if (rb.stopRequested) {
    rbSetStatus("rb.stopped");
  }
  rb.running = false;
  rbUi.start.hidden = false;
  rbUi.stop.hidden = true;
  rbRefreshDownload();
  reportUsage({
    mode: "rekordbox", tracks: done, failed: failedLookups,
    seconds: (Date.now() - started) / 1000,
  });
}

function rbDownload() {
  const changes = new Map();
  for (const row of rb.rows) if (row.checked) changes.set(row.id, row.genre);
  if (changes.size === 0) {
    notify("rb.noneChecked", null, rbUi.written);
    return;
  }
  const xml = buildGenreImport(rb.text, rb.parsed, changes, RB_PLAYLIST);
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "rekordbox-genres-" + new Date().toISOString().slice(0, 10) + ".xml";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  notify("rb.written", { count: changes.size }, rbUi.written);
}

rbUi.pick.addEventListener("click", () => rbUi.input.click());
rbUi.input.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) rbLoad(file);
  // Cleared so choosing the same file again, after re-exporting it, still fires.
  event.target.value = "";
});
acceptDrops(rbUi.dropzone, (files) => {
  const xml = files.find((file) => /\.xml$/i.test(file.name));
  if (xml) rbLoad(xml);
  else notify("rb.dropNotXml", null, rbUi.summary);
});
rbUi.start.addEventListener("click", rbRun);
rbUi.stop.addEventListener("click", () => { rb.stopRequested = true; });
rbUi.download.addEventListener("click", rbDownload);
rbUi.body.addEventListener("change", (event) => {
  const index = event.target.getAttribute && event.target.getAttribute("data-rb-row");
  if (index === null || index === undefined) return;
  const row = rb.rows[Number(index)];
  if (row) row.checked = event.target.checked;
  rbRefreshDownload();
});
rbUi.all.addEventListener("change", () => {
  const on = rbUi.all.checked;
  for (const row of rb.rows) row.checked = on;
  rbUi.body.querySelectorAll("input[data-rb-row]").forEach((box) => { box.checked = on; });
  rbRefreshDownload();
});

probeEnvironment();

/*
 * Corrections that never reached the server -- made offline, or during the
 * period before /api/feedback existed -- go out now. Deliberately after the
 * interface is up: this is the least urgent thing the page does, and it must
 * never be the reason the app is slow to become usable.
 */
flushFeedback();

/*
 * Reveals the admin link for a session whose role is admin. Purely cosmetic:
 * the check that actually protects the data lives in
 * functions/api/admin/feedback.js, which re-verifies the role itself rather
 * than trusting anything the client sends or hides. Failing silently here --
 * no admin link on a network error -- is the safe direction, since the worst
 * outcome is an admin having to reload rather than a tester seeing a link
 * that would 403 them anyway.
 */
/*
 * The developer log goes the same way, and is also shown on a local server,
 * where there is no gate to ask and the only person looking is the author.
 */
if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) ui.logBox.hidden = false;

(async () => {
  const adminLink = el("admin-link");
  if (!adminLink) return;
  try {
    const res = await fetch("/api/whoami", { credentials: "same-origin" });
    if (!res.ok) return;
    const info = await res.json();
    if (info && info.role === "admin") {
      adminLink.hidden = false;
      ui.logBox.hidden = false;
    }
  } catch (e) { /* no gate locally, or offline -- link stays hidden either way */ }
})();


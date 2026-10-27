"use strict";
/*
 * worker.js -- all CPU-heavy audio work happens here so the UI thread stays
 * responsive. This matters most on mobile Safari, where a long-running main
 * thread gets the tab killed rather than merely janky.
 *
 * Decoding itself stays on the main thread: decodeAudioData is not available
 * inside workers on Safari, so the main thread decodes (which is native code
 * and fast) and transfers raw PCM here for analysis.
 *
 * The protocol is deliberately split into several messages per file so the
 * expensive nearest-centroid fallback only runs when the online lookups on the
 * main thread actually came up empty.
 */

// The worker's own URL carries ?v=…; pass it on so its imports are not served
// from cache after the worker itself has been refreshed.
const WORKER_VERSION = new URLSearchParams(self.location.search).get("v") || "dev";
importScripts("dsp.js?v=" + WORKER_VERSION, "loudness.js?v=" + WORKER_VERSION, "keycnn.js?v=" + WORKER_VERSION,
  "beatgrid.js?v=" + WORKER_VERSION, "downbeat.js?v=" + WORKER_VERSION);

// The Python version analyses the whole file. Capping analysis keeps a batch
// usable in a browser; BPM and key are both stable well inside this window.
const ANALYSIS_MAX_SECONDS = 120;
const GENRE_ANALYSIS_RATE = 22050; // librosa.load default sample rate

let session = null;

/*
 * The key network's weights (keycnn.js), fetched once per worker on the first
 * track that needs a key. `false` once loading has failed: the chroma
 * detector in dsp.js then answers instead, so a missing or blocked model file
 * costs accuracy, never the batch.
 */
let keyModel = null;
let keyModelLoading = null;

function loadKeyModel() {
  if (!keyModelLoading) {
    keyModelLoading = fetch("../data/key_cnn.bin?v=" + WORKER_VERSION, { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.arrayBuffer();
      })
      .then((buffer) => { keyModel = parseKeyCnnModel(buffer); })
      .catch(() => { keyModel = false; });
  }
  return keyModelLoading;
}

function report(stage, value) {
  self.postMessage({ type: "progress", stage, value });
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "analyze":
        handleAnalyze(msg).catch((error) => {
          self.postMessage({ type: "error", message: String((error && error.message) || error) });
        });
        break;
      case "render":
        handleRender(msg);
        break;
      case "release":
        session = null;
        self.postMessage({ type: "released" });
        break;
      default:
        self.postMessage({ type: "error", message: "Unknown worker message: " + msg.type });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String((error && error.message) || error) });
  }
};

async function handleAnalyze(msg) {
  session = {
    mono22k: msg.mono22k ? new Float32Array(msg.mono22k) : null,
    monoNative: msg.monoNative ? new Float32Array(msg.monoNative) : null,
    monoTempo: msg.monoTempo ? new Float32Array(msg.monoTempo) : null,
    channels: msg.channels ? msg.channels.map((buffer) => new Float32Array(buffer)) : null,
    sampleRate: msg.sampleRate,
  };

  const result = {
    bpm: null,
    browseLufs: null,
    bpmMode: null,
    bpmMin: null,
    bpmMax: null,
    key: null,
    keyConfidence: null,
    keyConfident: false,
    keySecond: null,
    keyMethod: null,
    grid: null,
    integratedLufs: null,
    shortTermMaxLufs: null,
    truePeakDb: null,
  };

  if (msg.steps.bpmKey && session.monoNative) {
    report("bpm", 0);
    const tempo = analyzeTempo(session.monoNative, session.sampleRate, (p) => report("bpm", p));
    result.bpm = tempo.bpm;
    result.bpmMode = tempo.mode;
    result.bpmMin = tempo.min;
    result.bpmMax = tempo.max;
    // The grid is always worked out with the tempo; whether it is written is
    // decided on the finished archive (app.js, downloadZip).
    if (tempo.bpm) {
      report("grid", 0);
      result.grid = estimateBeatGrid(session.monoNative, session.sampleRate, tempo.bpm, tempo, session.monoTempo, GRID_TEMPO_RATE);
    }
    report("key", 0);
    // The network wants 44.1 kHz; the main thread sends a resampled copy
    // only when the file is at another rate.
    const mono44k = msg.mono44k ? new Float32Array(msg.mono44k)
      : (session.sampleRate === KEY_CNN_RATE ? session.monoNative : null);
    await loadKeyModel();
    if (keyModel && mono44k) {
      const key = detectKeyCnn(mono44k, keyModel);
      result.key = key.key;
      result.keyConfidence = key.confidence;
      result.keyConfident = key.confident;
      result.keySecond = key.second;
      result.keyMethod = "cnn";
    } else {
      const key = detectKey(session.mono22k, GENRE_ANALYSIS_RATE, (p) => report("key", p));
      result.key = key.key;
      result.keyConfidence = key.confidence;
      result.keyConfident = key.confident;
      result.keyMethod = "chroma";
    }
    report("key", 1);
  }

  /*
   * Two loudness figures, deliberately from different inputs.
   *
   * `browseLufs` comes from the mono downmix that is already being transferred
   * for tempo analysis, and covers the first two minutes. It exists so the
   * results table can be sorted by level without copying every channel of every
   * file into the worker, and without the true-peak scan -- together those cost
   * about 1.5 s and a full extra copy of the audio per track.
   *
   * The figures used to compute gain come from the full channel set over the
   * whole file, below, and are the ones that decide what is actually written.
   * They are only computed when normalization is on.
   */
  if (session.monoNative) {
    const browse = measureLoudness([session.monoNative], session.sampleRate, false);
    result.browseLufs = browse.integrated;
  }

  if (msg.steps.loudness && session.channels && session.channels.length > 0) {
    report("loudness", 0);
    const measured = measureLoudness(session.channels, session.sampleRate, true);
    result.integratedLufs = measured.integrated;
    result.shortTermMaxLufs = measured.shortTermMax;
    result.truePeakDb = measured.truePeak;
    report("loudness", 1);
  }

  self.postMessage({ type: "analyzed", result });
}

/*
 * Applies the loudness gain, then optionally the safe limiter, silence trim and
 * sample-rate change, and encodes the result. This replaces the ffmpeg filter
 * chain built by _build_render_filters() in the Python version.
 */
function handleRender(msg) {
  if (!session || !session.channels) {
    self.postMessage({ type: "error", message: "No audio loaded for rendering" });
    return;
  }
  const opts = msg.options;
  report("render", 0);

  let channels = applyGain(session.channels, msg.gainDb || 0);
  report("render", 0.3);

  if (opts.safeLimiter) {
    channels = applyLimiter(channels, session.sampleRate);
    report("render", 0.5);
  }
  if (opts.removeSilence) {
    channels = trimSilence(channels, session.sampleRate);
    report("render", 0.6);
  }

  let outputRate = session.sampleRate;
  if (opts.sampleRate && opts.sampleRate !== "same") {
    const target = parseInt(opts.sampleRate, 10);
    if (target && target !== session.sampleRate) {
      channels = resampleChannels(channels, session.sampleRate, target);
      outputRate = target;
    }
  }
  report("render", 0.75);

  let buffer = null;
  let format = "wav";
  if (opts.outputFormat === "mp3") {
    buffer = encodeMp3(channels, outputRate, 320);
    if (buffer) format = "mp3";
  }
  if (!buffer) {
    buffer = encodeWav(channels, outputRate);
    format = "wav";
  }
  report("render", 1);

  self.postMessage(
    { type: "rendered", buffer, format, sampleRate: outputRate, mp3Requested: opts.outputFormat === "mp3" },
    [buffer]
  );
}

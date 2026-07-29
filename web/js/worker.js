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
importScripts("dsp.js?v=" + WORKER_VERSION, "loudness.js?v=" + WORKER_VERSION);

// The Python version analyses the whole file. Capping analysis keeps a batch
// usable in a browser; BPM and key are both stable well inside this window.
const ANALYSIS_MAX_SECONDS = 120;
const GENRE_ANALYSIS_SECONDS = 60; // librosa.load(duration=60) in the Python code
const GENRE_ANALYSIS_RATE = 22050; // librosa.load default sample rate

let session = null;

function report(stage, value) {
  self.postMessage({ type: "progress", stage, value });
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "analyze":
        handleAnalyze(msg);
        break;
      case "genreFallback":
        handleGenreFallback();
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

function handleAnalyze(msg) {
  session = {
    mono22k: msg.mono22k ? new Float32Array(msg.mono22k) : null,
    monoNative: msg.monoNative ? new Float32Array(msg.monoNative) : null,
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
    report("key", 0);
    const key = detectKey(session.mono22k, GENRE_ANALYSIS_RATE, (p) => report("key", p));
    result.key = key.key;
    result.keyConfidence = key.confidence;
    result.keyConfident = key.confident;
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
 * Nearest-centroid genre classification, reached only when the tag, MusicBrainz
 * and Last.fm lookups have all failed -- the same position it occupies in the
 * Python process_file() chain.
 *
 * The Python version feeds this stage a 22050 Hz mono signal truncated to 60
 * seconds, including for its tempo feature, which is a *different* input from
 * the BPM reported in the results table. Reproducing that split matters: the
 * centroid distances were tuned against these exact numbers.
 */
function handleGenreFallback() {
  if (!session || !session.mono22k) {
    self.postMessage({ type: "genre", result: null });
    return;
  }
  report("genre", 0);
  const limit = Math.min(session.mono22k.length, GENRE_ANALYSIS_SECONDS * GENRE_ANALYSIS_RATE);
  const excerpt = session.mono22k.subarray(0, limit);

  const features = spectralFeatures(excerpt, GENRE_ANALYSIS_RATE, (p) => report("genre", p * 0.4));
  const tempo = detectBpm(excerpt, GENRE_ANALYSIS_RATE, (p) => report("genre", 0.4 + p * 0.6)) || 120;
  const classified = classifyByCentroid({
    tempo,
    centroid: features.centroid,
    bandwidth: features.bandwidth,
    zcr: features.zcr,
  });

  self.postMessage({
    type: "genre",
    result: {
      genre: classified.genre,
      distance: Math.round(classified.distance * 100) / 100,
      features: {
        tempo,
        centroid: Math.round(features.centroid),
        bandwidth: Math.round(features.bandwidth),
        zcr: Math.round(features.zcr * 10000) / 10000,
      },
    },
  });
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

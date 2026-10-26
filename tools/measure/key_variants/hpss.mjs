/*
 * Variant: harmonic/percussive separation on the constant-Q frames before
 * they are folded into chroma (Fitzgerald's median filtering, as librosa's
 * hpss does it).
 *
 * A held note is steady along time in its own semitone; a kick or a hat is
 * spread across many semitones in one frame. So, per semitone and frame:
 *
 *   H = median of that semitone over `timeKernel` neighbouring frames
 *   P = median of that frame over `freqKernel` neighbouring semitones
 *
 * and only the harmonic share, H^2 / (H^2 + P^2), of the magnitude is kept.
 * Everything after -- folding from C3 up, per-frame normalization, the
 * profiles -- is unchanged.
 *
 * Frames are 4096 samples at 22.05 kHz, 0.19 s, so the default time kernel of
 * 9 frames is 1.7 s; hpss_long.mjs tries 17 (3.2 s).
 *
 *   node tools/measure/measure_key.mjs --patch tools/measure/key_variants/hpss.mjs
 *
 * Result, 2026-10-26: not adopted. Exact matches, fixed/broken against the
 * shipped detector: library train half 78/63 (p = 0.24), held-out half
 * 72/67 (p = 0.73), GiantSteps 19/13 (p = 0.38). A small lean the right way
 * on every set, significant on none; major keys got slightly worse on the
 * library (15.8% -> 12.1% held-out) and better on GiantSteps (12.9% -> 16.1%).
 */

export function hpssPatches({ timeKernel = 9, freqKernel = 7 } = {}) {
  return [
    ["  const perClassFrames = [];",
      "  const perClassFrames = [];\n  const semitoneFrames = [];"],
    [`    frameChroma.fill(0);
    for (let s = CHROMA_LOWEST_SEMITONE; s < semitones.length; s++) {
      frameChroma[(s - CHROMA_LOWEST_SEMITONE) % 12] += semitones[s];
    }

    // Normalized per frame, so a loud bar does not outweigh a quiet one. On
    // real tracks this measured better than leaving the frames raw.
    let peak = 0;
    for (let i = 0; i < 12; i++) if (frameChroma[i] > peak) peak = frameChroma[i];
    if (peak > 1e-20) {
      for (let i = 0; i < 12; i++) perClassFrames[i].push(frameChroma[i] / peak);
    }
    if (onProgress) onProgress(Math.min(1, start / Math.max(1, n - maxLen)));
  }
`, `    semitoneFrames.push(Float64Array.from(semitones));
    if (onProgress) onProgress(Math.min(1, start / Math.max(1, n - maxLen)));
  }

  for (const frame of harmonicPart(semitoneFrames, ${timeKernel}, ${freqKernel})) {
    frameChroma.fill(0);
    for (let s = CHROMA_LOWEST_SEMITONE; s < frame.length; s++) {
      frameChroma[(s - CHROMA_LOWEST_SEMITONE) % 12] += frame[s];
    }
    let peak = 0;
    for (let i = 0; i < 12; i++) if (frameChroma[i] > peak) peak = frameChroma[i];
    if (peak > 1e-20) {
      for (let i = 0; i < 12; i++) perClassFrames[i].push(frameChroma[i] / peak);
    }
  }
`],
    ["function pearson(a, b) {", `${HARMONIC_PART}
function pearson(a, b) {`],
  ];
}

export const HARMONIC_PART = `
function medianOf(values, count) {
  const v = values.slice(0, count).sort((a, b) => a - b);
  return count % 2 ? v[count >> 1] : 0.5 * (v[(count >> 1) - 1] + v[count >> 1]);
}

// Frames x bins in, the same shape out with the percussive share removed.
function harmonicPart(frames, timeKernel, freqKernel) {
  const total = frames.length;
  if (total === 0) return frames;
  const bins = frames[0].length;
  const th = timeKernel >> 1;
  const fh = freqKernel >> 1;
  const scratch = new Float64Array(Math.max(timeKernel, freqKernel));
  const out = [];
  for (let t = 0; t < total; t++) {
    const row = new Float64Array(bins);
    for (let b = 0; b < bins; b++) {
      let count = 0;
      for (let u = Math.max(0, t - th); u <= Math.min(total - 1, t + th); u++) scratch[count++] = frames[u][b];
      const h = medianOf(scratch, count);
      count = 0;
      for (let c = Math.max(0, b - fh); c <= Math.min(bins - 1, b + fh); c++) scratch[count++] = frames[t][c];
      const p = medianOf(scratch, count);
      const hh = h * h;
      const pp = p * p;
      row[b] = hh + pp > 0 ? (frames[t][b] * hh) / (hh + pp) : 0;
    }
    out.push(row);
  }
  return out;
}
`;

export default hpssPatches();

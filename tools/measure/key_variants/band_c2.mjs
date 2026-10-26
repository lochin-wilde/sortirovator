/*
 * Variant: fold the C2 octave (65-130 Hz) into the chroma as well -- the
 * bassline. dsp.js starts at C3 and says why (kick and sub-bass swamp the
 * lowest filter); that was measured on 165 tracks, this re-asks it on 4523.
 * The high-pass moves down with it: the two only work together.
 */
export default [
  ["const CHROMA_LOWEST_SEMITONE = 24;", "const CHROMA_LOWEST_SEMITONE = 12;"],
  ["const CHROMA_HIGHPASS_HZ = 130.8127826502993; // C3", "const CHROMA_HIGHPASS_HZ = 65.40639132514966; // C2"],
];

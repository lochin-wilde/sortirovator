/*
 * Variant: drop the top octave (C6-B6, 1-2 kHz) from the filterbank. Hats,
 * cymbals and vocal sibilance sit there with little pitch information.
 */
export default [["const CQT_OCTAVES = 6;", "const CQT_OCTAVES = 5;"]];

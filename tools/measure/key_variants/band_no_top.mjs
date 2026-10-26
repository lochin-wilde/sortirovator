/*
 * Variant: drop the top octave (C6-B6, 1-2 kHz) from the filterbank. Hats,
 * cymbals and vocal sibilance sit there with little pitch information.
 *
 * Result, 2026-10-26: rejected. Fixed/broken: GiantSteps 25/18 (p = 0.36),
 * but the library got significantly worse -- train 64/119, held-out 56/115
 * (p < 1e-4). The top octave carries real pitch in this library (vocals,
 * leads). The HPSS + no-top combination, declared in advance as one
 * hypothesis conditional on this not hurting the library, was therefore not
 * run.
 */
export default [["const CQT_OCTAVES = 6;", "const CQT_OCTAVES = 5;"]];

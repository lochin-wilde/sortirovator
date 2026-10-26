/*
 * Variant: hpss.mjs with a 17-frame (3.2 s) time kernel.
 *
 * Result, 2026-10-26: not adopted -- no change. Fixed/broken: library train
 * 78/89, held-out 76/75, GiantSteps 20/18.
 */
import { hpssPatches } from "./hpss.mjs";

export default hpssPatches({ timeKernel: 17 });

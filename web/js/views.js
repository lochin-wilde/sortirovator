"use strict";
/*
 * views.js -- the pure decisions behind what the page shows.
 *
 * Which preset a set of switches amounts to, which tracks in a batch mix with
 * a given one, and what the archive will hold. None of it touches the DOM, so
 * it runs under the test suite in Node; app.js draws the results.
 */

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/*
 * The four switches in step 2, in the combinations people actually want.
 *
 * "library" is first and is what the page opens with: genres plus tempo and
 * key, leaving names and audio alone. It is the only one that changes nothing
 * about the files themselves except where they are filed and what their tags
 * say, which makes it the safe thing to run on a whole collection. "everything"
 * also renames and re-encodes, so it is offered, not defaulted to.
 */
const PRESETS = [
  { id: "library", steps: { fixNames: false, sort: true, bpmKey: true, loudness: false } },
  { id: "everything", steps: { fixNames: true, sort: true, bpmKey: true, loudness: true } },
  { id: "analyze", steps: { fixNames: false, sort: false, bpmKey: true, loudness: false } },
  { id: "genres", steps: { fixNames: false, sort: true, bpmKey: false, loudness: false } },
];

// The preset these switches amount to, or null for a combination of the user's own.
function matchPreset(steps) {
  for (const preset of PRESETS) {
    const same = Object.keys(preset.steps).every((name) => Boolean(steps[name]) === preset.steps[name]);
    if (same) return preset.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* What mixes with what                                                */
/* ------------------------------------------------------------------ */

/*
 * How far a tempo can be pitched before it stops sounding like the record.
 *
 * A Technics pitch fader runs to ±8%, but past about 6% vocals and pads start
 * to sound wrong, and that is where DJs say a blend stops working. The figure
 * is a convention, not a measurement; the list is sorted by distance, so the
 * closest matches come first whatever the cut-off.
 */
const MIX_TEMPO_TOLERANCE = 0.06;
const MIX_LIMIT = 12;

function parseCamelot(key) {
  const match = /^(\d{1,2})([AB])$/.exec(String(key || "").trim().toUpperCase());
  if (!match) return null;
  const number = parseInt(match[1], 10);
  if (number < 1 || number > 12) return null;
  return { number, letter: match[2] };
}

/*
 * How two keys sit on the Camelot wheel, by the standard harmonic-mixing rules:
 * the same key, one step either way round the wheel in the same ring, or the
 * same number in the other ring (relative major and minor). Anything else is
 * null -- not "unmixable", just not one of the moves the wheel vouches for.
 */
function camelotRelation(from, to) {
  const a = parseCamelot(from);
  const b = parseCamelot(to);
  if (!a || !b) return null;
  if (a.number === b.number) return a.letter === b.letter ? "same" : "relative";
  if (a.letter !== b.letter) return null;
  const step = ((b.number - a.number) % 12 + 12) % 12;
  if (step === 1) return "up";
  if (step === 11) return "down";
  return null;
}

/*
 * How far apart two tempos are once half and double time are allowed for.
 *
 * An 87 BPM hip hop record and a 174 drum & bass one share a pulse, and DJs
 * mix across exactly that. Rekordbox itself files the same 90s hip hop at both
 * speeds, so without this the tempo a track happened to be measured at would
 * decide whether it showed up at all.
 *
 * Returns { delta, factor }: delta is the signed fraction the second track has
 * to move to meet the first, factor is 1, 2 or 0.5.
 */
function tempoDistance(from, to) {
  if (!(from > 0) || !(to > 0)) return null;
  let best = null;
  for (const factor of [1, 2, 0.5]) {
    const delta = (from - to * factor) / (to * factor);
    if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { delta, factor };
  }
  return best;
}

const RELATION_RANK = { same: 0, relative: 1, up: 1, down: 1 };

/*
 * The tracks in `rows` that mix with rows[index], closest first.
 *
 * Both measurements count when both are known: a track in the right key at the
 * wrong tempo is not a mix. When the chosen track lacks one of them, the other
 * decides alone, because "nothing" would be a worse answer than "these share
 * your key". A candidate missing a measurement the chosen track has is left
 * out -- there is nothing to say it fits.
 */
function mixNeighbours(rows, index) {
  const target = rows[index];
  if (!target || target.error) return [];
  const hasKey = parseCamelot(target.key) !== null;
  const hasTempo = target.bpm > 0;
  if (!hasKey && !hasTempo) return [];

  const found = [];
  rows.forEach((row, i) => {
    if (i === index || !row || row.error) return;
    let relation = null;
    if (hasKey) {
      relation = camelotRelation(target.key, row.key);
      if (relation === null) return;
    }
    let tempo = null;
    if (hasTempo) {
      tempo = tempoDistance(target.bpm, row.bpm);
      if (tempo === null || Math.abs(tempo.delta) > MIX_TEMPO_TOLERANCE) return;
    }
    found.push({
      index: i,
      relation,
      delta: tempo ? tempo.delta : null,
      factor: tempo ? tempo.factor : 1,
    });
  });

  found.sort((a, b) =>
    (a.relation === null ? 0 : RELATION_RANK[a.relation]) -
      (b.relation === null ? 0 : RELATION_RANK[b.relation]) ||
    Math.abs(a.delta || 0) - Math.abs(b.delta || 0) ||
    a.index - b.index);
  return found.slice(0, MIX_LIMIT);
}

/* ------------------------------------------------------------------ */
/* What the archive holds                                              */
/* ------------------------------------------------------------------ */

/*
 * The archive as folders, from the paths actually written into it.
 *
 * Built from the ZIP's own entries rather than from the results table, so what
 * is shown is what will unpack -- including the playlists, and including the
 * "(2)" a duplicate name was given. Largest folder first, since the question
 * being answered is where the library went; the playlists close the list
 * because they are not music.
 */
function archiveTree(paths, playlistFolder) {
  const folders = new Map();
  const rootFiles = [];
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      rootFiles.push(path);
      continue;
    }
    const folder = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    if (!rest) continue; // a directory entry, not a file
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(rest);
  }
  const list = [...folders.entries()].map(([name, files]) => ({
    name,
    files: files.slice().sort((a, b) => a.localeCompare(b)),
    playlists: name === playlistFolder,
  }));
  list.sort((a, b) =>
    Number(a.playlists) - Number(b.playlists) ||
    b.files.length - a.files.length ||
    a.name.localeCompare(b.name));
  return { folders: list, rootFiles: rootFiles.sort((a, b) => a.localeCompare(b)) };
}

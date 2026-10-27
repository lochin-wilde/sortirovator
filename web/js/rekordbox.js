"use strict";
/*
 * rekordbox.js -- reading a Rekordbox collection export and handing genres back.
 *
 * The point is to put genres into the DJ's real Rekordbox collection without
 * renaming or moving a single file. Rekordbox exports its whole collection as
 * XML (File -> Export Collection in xml format) and can import one back; this
 * reads the export, and writes a smaller XML carrying only the tracks whose
 * genre changed.
 *
 * Why only those tracks
 * ---------------------
 * Importing a track that already exists replaces it wholesale with the XML
 * version -- beat grid, cue points, rating, comments, everything. That is how
 * the genre gets in, and it is also the danger: a stale export would roll back
 * any cue set since it was made. So the output is kept to the tracks this
 * changes, each one copied from the user's own export byte for byte with a
 * single attribute altered. Nothing else in the collection is touched, and a
 * fresh export imported straight back loses nothing.
 *
 * Why a scanner and not DOMParser
 * -------------------------------
 * Copying byte for byte needs exact offsets into the original text, which a DOM
 * does not keep; and the code has to run under the test suite in Node, which has
 * no DOMParser. Rekordbox's XML is machine-written and regular enough to scan
 * safely, provided quoted attribute values are honoured -- a raw ">" is legal
 * inside one, and a title can contain it.
 *
 * Loaded only when the user opens a collection file, like identify.js.
 */

/* ------------------------------------------------------------------ */
/* Attribute text                                                      */
/* ------------------------------------------------------------------ */

const XML_NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlUnescape(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ref) => {
    if (ref[0] !== "#") return XML_NAMED_ENTITIES[ref];
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

// For a double-quoted attribute value. Control characters other than tab, line
// feed and carriage return are not allowed in XML at all, so they are dropped
// rather than written into a file Rekordbox would then refuse.
function xmlEscapeAttr(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

/*
 * Returns the index just past the ">" closing the tag that opens at `start`,
 * skipping over quoted attribute values, or -1 if the tag never closes.
 */
function endOfTag(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return -1;
}

/*
 * The attributes of one start tag, each with where its value sits inside the
 * tag text, so a value can be replaced without disturbing anything around it.
 */
function readAttributes(tag) {
  const attrs = {};
  const spans = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    const raw = match[3] !== undefined ? match[3] : match[4];
    attrs[match[1]] = xmlUnescape(raw);
    const valueStart = match.index + match[0].length - match[2].length + 1;
    spans[match[1]] = { start: valueStart, end: valueStart + raw.length };
  }
  return { attrs, spans };
}

// A tag name match must end at the name: "<TRACKS" is not "<TRACK".
function findTag(text, name, from, until) {
  let at = from;
  while (true) {
    at = text.indexOf("<" + name, at);
    if (at < 0 || at >= until) return -1;
    const next = text[at + name.length + 1];
    if (next === ">" || next === "/" || /\s/.test(next)) return at;
    at += name.length + 1;
  }
}

/*
 * Reads a Rekordbox collection export.
 *
 * Returns { product, tracks }. `product` is the PRODUCT tag as written, kept so
 * the output declares the same origin. Each track is { id, attrs, start, end,
 * tagEnd, selfClosing }: `start` to `end` is the whole element in the original
 * text, children and all, and `tagEnd` is where its start tag stops.
 *
 * Throws with a readable message when the file is not a Rekordbox collection,
 * because the likeliest mistake is choosing the wrong file.
 */
function readRekordboxXml(text) {
  if (typeof text !== "string" || text.indexOf("<DJ_PLAYLISTS") < 0) {
    throw new Error("not a Rekordbox collection export: no DJ_PLAYLISTS element");
  }
  const collectionAt = findTag(text, "COLLECTION", 0, text.length);
  if (collectionAt < 0) {
    throw new Error("not a Rekordbox collection export: no COLLECTION element");
  }
  const collectionOpenEnd = endOfTag(text, collectionAt);
  const collectionClose = text.indexOf("</COLLECTION>", collectionOpenEnd);
  if (collectionOpenEnd < 0 || collectionClose < 0) {
    throw new Error("the COLLECTION element is not closed; the file may be cut short");
  }

  let product = null;
  const productAt = findTag(text, "PRODUCT", 0, collectionAt);
  if (productAt >= 0) {
    const productEnd = endOfTag(text, productAt);
    if (productEnd > 0) product = text.slice(productAt, productEnd);
  }

  const tracks = [];
  let cursor = collectionOpenEnd;
  while (true) {
    const start = findTag(text, "TRACK", cursor, collectionClose);
    if (start < 0) break;
    const tagEnd = endOfTag(text, start);
    if (tagEnd < 0 || tagEnd > collectionClose) {
      throw new Error("a TRACK tag is not closed; the file may be damaged");
    }
    const tag = text.slice(start, tagEnd);
    const selfClosing = /\/\s*>$/.test(tag);
    let end = tagEnd;
    if (!selfClosing) {
      // Children are TEMPO and POSITION_MARK; a TRACK never nests another.
      const close = text.indexOf("</TRACK>", tagEnd);
      if (close < 0 || close > collectionClose) {
        throw new Error("a TRACK element is not closed; the file may be damaged");
      }
      end = close + "</TRACK>".length;
    }
    const { attrs } = readAttributes(tag);
    if (attrs.TrackID !== undefined && attrs.TrackID !== "") {
      tracks.push({ id: attrs.TrackID, attrs, start, end, tagEnd, selfClosing });
    }
    cursor = end;
  }
  return { product, tracks };
}

/*
 * One track element with its Genre set to `genre`, everything else unchanged.
 *
 * Replaces the value in place when the attribute exists; otherwise inserts it
 * just before the start tag closes. The children -- grid, cues -- are copied
 * as they were.
 */
function withGenre(text, track, genre) {
  const element = text.slice(track.start, track.end);
  const tagLength = track.tagEnd - track.start;
  const tag = element.slice(0, tagLength);
  const rest = element.slice(tagLength);
  const escaped = xmlEscapeAttr(genre);
  const { spans } = readAttributes(tag);

  let newTag;
  if (spans.Genre) {
    newTag = tag.slice(0, spans.Genre.start) + escaped + tag.slice(spans.Genre.end);
  } else {
    const closer = /\s*\/?\s*>$/.exec(tag);
    newTag = tag.slice(0, closer.index) + ' Genre="' + escaped + '"' + tag.slice(closer.index);
  }
  return newTag + rest;
}

/*
 * The XML to import back into Rekordbox: only the tracks in `changes`
 * (a Map of TrackID -> genre), plus one playlist holding them so they are easy
 * to select together on the rekordbox xml tab.
 */
function buildGenreImport(text, parsed, changes, playlistName) {
  const byId = new Map(parsed.tracks.map((t) => [t.id, t]));
  const kept = [];
  for (const [id, genre] of changes) {
    const track = byId.get(id);
    if (track) kept.push(withGenre(text, track, genre));
  }
  const ids = [...changes.keys()].filter((id) => byId.has(id));
  const product = parsed.product
    || '<PRODUCT Name="rekordbox" Version="" Company="AlphaTheta"/>';

  return '<?xml version="1.0" encoding="UTF-8"?>\n\n'
    + '<DJ_PLAYLISTS Version="1.0.0">\n'
    + "  " + product + "\n"
    + '  <COLLECTION Entries="' + kept.length + '">\n'
    + kept.map((element) => "    " + element).join("\n") + (kept.length ? "\n" : "")
    + "  </COLLECTION>\n"
    + "  <PLAYLISTS>\n"
    + '    <NODE Type="0" Name="ROOT" Count="1">\n'
    + '      <NODE Name="' + xmlEscapeAttr(playlistName) + '" Type="1" KeyType="0" Entries="'
    + ids.length + '">\n'
    + ids.map((id) => '        <TRACK Key="' + xmlEscapeAttr(id) + '"/>').join("\n")
    + (ids.length ? "\n" : "")
    + "      </NODE>\n"
    + "    </NODE>\n"
    + "  </PLAYLISTS>\n"
    + "</DJ_PLAYLISTS>\n";
}

/*
 * The artist and title to look a track up by.
 *
 * Usually just the Artist and Name attributes. But in a real collection about
 * one track in seven had no artist at all -- 666 of 4738 -- with the whole
 * "Artist - Title" packed into Name, as it arrived from the filename. Sent as
 * it stands, every one of those came back unknown. `split` is the app's own
 * filename parser (parseFilename from identify.js), passed in rather than
 * reached for, so this file stays loadable on its own; it already knows which
 * way round a "Title - Artist" name reads.
 */
function lookupNames(attrs, split) {
  const artist = (attrs.Artist || "").trim();
  const title = (attrs.Name || "").trim();
  if (artist || !title || typeof split !== "function") return { artist, title };
  const parsed = split(title + ".mp3");
  if (parsed && parsed.artist && parsed.track) {
    return { artist: parsed.artist.trim(), title: parsed.track.trim() };
  }
  return { artist, title };
}

/* ------------------------------------------------------------------ */
/* Beat grids for new tracks                                           */
/* ------------------------------------------------------------------ */

/*
 * An XML that brings the archive's tracks into Rekordbox with the grid this
 * app fitted, so they reach a USB stick -- and the CDJs -- already gridded.
 *
 * Only for tracks the collection does not have. Rekordbox matches an imported
 * track to its collection by Location, and the header above explains what an
 * import does to a track it matches: replaces it. The archive is unpacked into
 * a folder the collection has not seen, so every Location here is new; the page
 * also drops any Location a loaded collection export already holds.
 *
 * Format as pyrekordbox documents Rekordbox's own XML: a TRACK per file with a
 * file://localhost URI, and one TEMPO child -- Inizio in seconds, Bpm, Metro,
 * and Battito, the first beat's place in the bar. The app does not find bars,
 * so Battito is 1; measured against Rekordbox's grids that is the right bar
 * position for 69% of the tracks given a grid.
 */

/*
 * The folder the archive will be unpacked into, typed by the user, as the
 * absolute path Rekordbox will look for files under -- or null if it is not
 * one. A browser cannot see where a download ends up, so this is the one fact
 * the page has to be told. "~" is refused rather than guessed at: the page
 * does not know the home folder either.
 */
function archiveFolderPath(text) {
  let path = String(text || "").trim().replace(/^["']|["']$/g, "");
  if (/^[A-Za-z]:[\\/]/.test(path)) path = path.replace(/\\/g, "/");
  else if (!path.startsWith("/")) return null;
  path = path.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

// file://localhost URI for `relative` (the path inside the archive) under
// `folder` (from archiveFolderPath). Each segment is percent-encoded, so
// spaces, "&", "#" and Cyrillic survive; a Windows drive letter keeps its
// colon.
function trackLocation(folder, relative) {
  const segments = (folder.replace(/^\//, "") + "/" + relative).split("/").filter((s) => s !== "");
  const encoded = segments.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)));
  return "file://localhost/" + encoded.join("/");
}

/*
 * tracks: [{ location, name, artist, genre, kind, seconds, bpm, firstBeat }],
 * firstBeat already on Rekordbox's timeline (see gridOffsetFor in tags.js).
 */
function buildGridImport(tracks, playlistName) {
  const attr = (name, value) => " " + name + '="' + xmlEscapeAttr(value) + '"';
  const elements = tracks.map((track, i) => {
    const period = 60 / track.bpm;
    // A grid line before the start of the file means nothing to Rekordbox;
    // the same grid one beat later does.
    let first = track.firstBeat;
    while (first < 0) first += period;
    return "    <TRACK" + attr("TrackID", i + 1)
      + attr("Name", track.name || "") + attr("Artist", track.artist || "")
      + (track.genre ? attr("Genre", track.genre) : "")
      + attr("Kind", track.kind)
      + (Number.isFinite(track.seconds) ? attr("TotalTime", Math.round(track.seconds)) : "")
      + attr("AverageBpm", track.bpm.toFixed(2))
      + attr("Location", track.location) + ">\n"
      + '      <TEMPO Inizio="' + first.toFixed(3) + '" Bpm="' + track.bpm.toFixed(2)
      + '" Metro="4/4" Battito="1"/>\n'
      + "    </TRACK>";
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n\n'
    + '<DJ_PLAYLISTS Version="1.0.0">\n'
    + '  <PRODUCT Name="Sortirovator" Version="" Company=""/>\n'
    + '  <COLLECTION Entries="' + tracks.length + '">\n'
    + elements.join("\n") + (tracks.length ? "\n" : "")
    + "  </COLLECTION>\n"
    + "  <PLAYLISTS>\n"
    + '    <NODE Type="0" Name="ROOT" Count="1">\n'
    + '      <NODE Name="' + xmlEscapeAttr(playlistName) + '" Type="1" KeyType="0" Entries="'
    + tracks.length + '">\n'
    + tracks.map((_, i) => '        <TRACK Key="' + (i + 1) + '"/>').join("\n")
    + (tracks.length ? "\n" : "")
    + "      </NODE>\n"
    + "    </NODE>\n"
    + "  </PLAYLISTS>\n"
    + "</DJ_PLAYLISTS>\n";
}

// Locations a collection export already holds, decoded so that two spellings
// of one path -- "%20" or a space, "file://localhost//Volumes" or "/Volumes"
// -- compare equal.
function locationKey(location) {
  let path = String(location || "").replace(/^file:\/\/localhost/i, "").replace(/^\/+(?=[A-Za-z]:\/)/, "");
  try { path = decodeURIComponent(path); } catch (e) { /* keep it as written */ }
  return path.replace(/^\/+/, "/").normalize("NFC").toLowerCase();
}

function collectionLocations(parsed) {
  return new Set((parsed ? parsed.tracks : []).map((t) => locationKey(t.attrs.Location)));
}

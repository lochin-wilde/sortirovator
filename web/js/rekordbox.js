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

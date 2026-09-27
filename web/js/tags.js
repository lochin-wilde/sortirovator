"use strict";
/*
 * tags.js -- minimal read-only tag parsing, replacing mutagen's role in
 * get_metadata(). Reads genre / artist / title from ID3v2 (MP3), Vorbis
 * comments (FLAC) and MP4 ilst atoms (M4A).
 *
 * Only the header region of the file is needed, so callers hand over a small
 * slice rather than the whole track.
 */

const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
  "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock",
  "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack",
  "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance",
  "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
  "Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
  "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic",
  "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
  "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native US", "Cabaret", "New Wave",
  "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk",
  "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock",
];

function decodeText(bytes, encoding) {
  try {
    if (encoding === 0) return new TextDecoder("iso-8859-1").decode(bytes);
    if (encoding === 3) return new TextDecoder("utf-8").decode(bytes);
    if (encoding === 2) return new TextDecoder("utf-16be").decode(bytes);
    // encoding 1: UTF-16 with a byte order mark
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    return new TextDecoder("utf-16le").decode(bytes);
  } catch (e) {
    return "";
  }
}

function cleanTagValue(value) {
  return (value || "").replace(/ +$/g, "").trim();
}

// ID3 genre frames may hold a bare ID3v1 index such as "(17)" or "17".
function normalizeGenreValue(value) {
  let text = cleanTagValue(value);
  if (!text) return null;
  const numeric = text.match(/^\((\d+)\)(.*)$/);
  if (numeric) {
    const rest = numeric[2].trim();
    if (rest) return rest;
    text = numeric[1];
  }
  if (/^\d+$/.test(text)) {
    const index = parseInt(text, 10);
    return ID3V1_GENRES[index] || null;
  }
  return text;
}

function parseId3v2(bytes) {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // "ID3"

  // Header layout: "ID3", major, revision, flags, then a 4-byte syncsafe size.
  const major = bytes[3];
  const flags = bytes[5];
  const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);

  let offset = 10;
  const end = Math.min(bytes.length, 10 + tagSize);

  // Skip an extended header if present.
  if (major >= 3 && (flags & 0x40) !== 0 && offset + 4 <= end) {
    const extSize = major === 4
      ? ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f)
      : (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += major === 4 ? extSize : extSize + 4;
  }

  const idLength = major === 2 ? 3 : 4;
  const sizeLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  const wanted = major === 2
    ? { TCO: "genre", TP1: "artist", TT2: "title" }
    : { TCON: "genre", TPE1: "artist", TIT2: "title" };

  const result = { genre: null, artist: null, title: null };

  while (offset + headerLength <= end) {
    let id = "";
    for (let i = 0; i < idLength; i++) id += String.fromCharCode(bytes[offset + i]);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding reached

    let frameSize = 0;
    const sizeOffset = offset + idLength;
    if (major === 4) {
      for (let i = 0; i < sizeLength; i++) frameSize = (frameSize << 7) | (bytes[sizeOffset + i] & 0x7f);
    } else {
      for (let i = 0; i < sizeLength; i++) frameSize = (frameSize << 8) | bytes[sizeOffset + i];
    }
    if (frameSize <= 0 || offset + headerLength + frameSize > end) break;

    const field = wanted[id];
    if (field) {
      const payload = bytes.subarray(offset + headerLength, offset + headerLength + frameSize);
      if (payload.length > 1) {
        const text = decodeText(payload.subarray(1), payload[0]);
        result[field] = field === "genre" ? normalizeGenreValue(text) : cleanTagValue(text);
      }
    }
    offset += headerLength + frameSize;
  }

  return result;
}

function parseFlacTags(bytes) {
  if (bytes.length < 8) return null;
  if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null; // "fLaC"

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  const result = { genre: null, artist: null, title: null };

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockSize = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    if (offset + blockSize > bytes.length) break;

    if (blockType === 4) {
      let p = offset;
      const vendorLength = view.getUint32(p, true);
      p += 4 + vendorLength;
      if (p + 4 > bytes.length) break;
      const count = view.getUint32(p, true);
      p += 4;
      for (let i = 0; i < count && p + 4 <= bytes.length; i++) {
        const length = view.getUint32(p, true);
        p += 4;
        if (p + length > bytes.length) break;
        const entry = new TextDecoder("utf-8").decode(bytes.subarray(p, p + length));
        p += length;
        const eq = entry.indexOf("=");
        if (eq < 0) continue;
        const key = entry.slice(0, eq).toUpperCase();
        const value = cleanTagValue(entry.slice(eq + 1));
        if (key === "GENRE" && !result.genre) result.genre = normalizeGenreValue(value);
        else if (key === "ARTIST" && !result.artist) result.artist = value;
        else if (key === "TITLE" && !result.title) result.title = value;
      }
      break;
    }
    offset += blockSize;
    if (isLast) break;
  }
  return result;
}

function parseMp4Tags(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = { genre: null, artist: null, title: null };
  const containers = new Set(["moov", "udta", "meta", "ilst"]);
  const wanted = { "©gen": "genre", gnre: "genre", "©ART": "artist", "©nam": "title" };
  let found = false;

  const walk = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      let name = "";
      for (let i = 0; i < 4; i++) name += String.fromCharCode(bytes[offset + 4 + i]);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        // 64-bit size; the high word is effectively always zero for audio files.
        size = view.getUint32(offset + 12);
        headerSize = 16;
      }
      if (size < headerSize || offset + size > end) break;

      if (containers.has(name)) {
        // The "meta" atom carries a 4-byte version/flags field before children.
        const childStart = offset + headerSize + (name === "meta" ? 4 : 0);
        walk(childStart, offset + size);
      } else if (wanted[name]) {
        let p = offset + headerSize;
        while (p + 8 <= offset + size) {
          const dataSize = view.getUint32(p);
          let dataName = "";
          for (let i = 0; i < 4; i++) dataName += String.fromCharCode(bytes[p + 4 + i]);
          if (dataName === "data" && dataSize >= 16 && p + dataSize <= offset + size) {
            const payload = bytes.subarray(p + 16, p + dataSize);
            const field = wanted[name];
            if (name === "gnre" && payload.length >= 2) {
              const index = (payload[0] << 8) | payload[1];
              if (!result.genre) result.genre = ID3V1_GENRES[index - 1] || null;
            } else {
              const text = cleanTagValue(new TextDecoder("utf-8").decode(payload));
              if (!result[field]) result[field] = field === "genre" ? normalizeGenreValue(text) : text;
            }
            found = true;
            break;
          }
          if (dataSize < 8) break;
          p += dataSize;
        }
      }
      offset += size;
    }
  };

  walk(0, bytes.length);
  return found ? result : null;
}

/*
 * Best-effort tag read. Returns { genre, artist, title } with null fields when
 * a tag is absent or the container is not recognised -- callers fall back to
 * the filename exactly like the Python version does.
 */
function readTags(bytes, extension) {
  try {
    const ext = (extension || "").toLowerCase();
    if (ext === ".flac") return parseFlacTags(bytes) || { genre: null, artist: null, title: null };
    if (ext === ".m4a" || ext === ".mp4") return parseMp4Tags(bytes) || { genre: null, artist: null, title: null };
    const id3 = parseId3v2(bytes);
    if (id3) return id3;
    const flac = parseFlacTags(bytes);
    if (flac) return flac;
    const mp4 = parseMp4Tags(bytes);
    if (mp4) return mp4;
  } catch (e) {
    // A malformed tag must never abort the batch.
  }
  return { genre: null, artist: null, title: null };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/*
 * Writes what the batch worked out back into the file itself.
 *
 * Renaming a file and filing it in a folder is only half the job, because
 * Rekordbox reads the tag and not the name. A track that arrives as
 * "Afro House/Black Coffee - Drive.mp3" still shows up with an empty genre
 * column unless TCON says so.
 *
 * Two containers are handled, and between them they cover every file this app
 * produces: MP3, which is what most of a DJ library is and what the encoder
 * emits, and WAV, which is what loudness normalization writes by default. FLAC
 * and M4A pass through untouched -- rewriting their metadata means rebuilding
 * Vorbis blocks or shifting MP4 atom offsets, and a half-correct rewrite of a
 * container is worse than leaving it alone. The caller is told which happened.
 *
 * Only the output copy inside the archive is written to. The file the user
 * selected is never opened for writing; the browser cannot do that, and this
 * app's promise is that the originals stay as they are.
 */

// ID3v2.4, with UTF-8 payloads. Rekordbox reads v2.4, and v2.3 would cost a
// second size encoding for no gain.
const ID3_TEXT_ENCODING_UTF8 = 0x03;

/*
 * TKEY carries the Camelot code ("8A"), not the notation the spec asks for
 * ("Am"). That is a deliberate deviation: Mixed In Key established the
 * convention, DJ software displays it, and it is the same string the results
 * table shows, so what lands in the tag is what the user already checked.
 */
const ID3_FRAMES = [
  ["TIT2", "title"], ["TPE1", "artist"], ["TCON", "genre"],
  ["TBPM", "bpm"], ["TKEY", "key"],
];

// Every byte holds seven bits, so a size can never contain 0xFF and be mistaken
// for the start of an audio frame.
function synchsafeBytes(value) {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function synchsafeValue(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function id3TextFrame(id, text) {
  const payload = new TextEncoder().encode(String(text));
  const frame = new Uint8Array(10 + 1 + payload.length);
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  frame.set(synchsafeBytes(payload.length + 1), 4);
  // Frame flags: none set.
  frame[8] = 0;
  frame[9] = 0;
  frame[10] = ID3_TEXT_ENCODING_UTF8;
  frame.set(payload, 11);
  return frame;
}

/*
 * Everything already in the tag that we are not replacing, re-emitted for the
 * new one.
 *
 * Without this the writer is a data-loss bug wearing a feature's clothes: it
 * replaces the whole ID3v2 block, so cover art, comments, album, year and
 * anything else the file arrived with disappear. Measured on one real track
 * from the library, rewriting it dropped 102 KB of embedded artwork and nothing
 * anywhere said so.
 *
 * Copying is deliberately timid, because a frame carried across wrongly is
 * worse than a frame left behind:
 *
 *   v2.2 is skipped whole -- three-character ids and three-byte sizes are a
 *   different layout, and the format is long dead.
 *
 *   An unsynchronised tag is skipped whole. Its frame bytes have been altered
 *   to avoid false sync words, and copying them into a tag that does not
 *   declare unsynchronisation would hand the reader mangled data.
 *
 *   A frame with any flag set is dropped. Those bits mean compressed,
 *   encrypted, grouped, or carrying a data-length indicator, and each needs
 *   handling this writer does not have.
 *
 * Sizes are re-encoded rather than copied: v2.3 counts frame length as a plain
 * integer and v2.4 as a synchsafe one, so the bytes differ even when the number
 * does not.
 */
function framesToCarryOver(bytes, replacing) {
  const kept = [];
  if (bytes.length < 10) return kept;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return kept;

  const major = bytes[3];
  const flags = bytes[5];
  if (major !== 3 && major !== 4) return kept;
  if ((flags & 0x80) !== 0) return kept;

  let at = 10;
  const end = Math.min(bytes.length, 10 + synchsafeValue(bytes, 6));

  if ((flags & 0x40) !== 0 && at + 4 <= end) {
    const extended = major === 4 ? synchsafeValue(bytes, at)
      : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) + 4;
    at += extended;
  }

  while (at + 10 <= end) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    // Padding: the rest of the tag is zero bytes, not another frame.
    if (bytes[at] === 0) break;
    const size = major === 4 ? synchsafeValue(bytes, at + 4)
      : ((bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7]) >>> 0;
    if (size <= 0 || at + 10 + size > end) break;

    const clean = bytes[at + 8] === 0 && bytes[at + 9] === 0;
    if (clean && !replacing.has(id) && /^[A-Z0-9]{4}$/.test(id)) {
      const payload = bytes.subarray(at + 10, at + 10 + size);
      const frame = new Uint8Array(10 + size);
      for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
      frame.set(synchsafeBytes(size), 4);
      frame.set(payload, 10);
      kept.push(frame);
    }
    at += 10 + size;
  }
  return kept;
}

function buildId3v2(fields, carried) {
  const frames = [];
  for (const [id, key] of ID3_FRAMES) {
    const value = fields[key];
    if (value === null || value === undefined || value === "") continue;
    frames.push(id3TextFrame(id, value));
  }
  if (frames.length === 0) return null;
  if (carried) for (const frame of carried) frames.push(frame);

  const body = frames.reduce((sum, f) => sum + f.length, 0);
  const tag = new Uint8Array(10 + body);
  tag[0] = 0x49; tag[1] = 0x44; tag[2] = 0x33; // "ID3"
  tag[3] = 4; tag[4] = 0;                      // v2.4.0
  tag[5] = 0;                                  // no extended header, no footer
  tag.set(synchsafeBytes(body), 6);
  let at = 10;
  for (const frame of frames) { tag.set(frame, at); at += frame.length; }
  return tag;
}

// How many bytes an existing ID3v2 tag occupies at the front, 0 when there is
// none. A footer, when present, adds another ten that belong to the tag too.
function id3v2Length(bytes) {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + synchsafeValue(bytes, 6) + footer;
}

function writeMp3Tags(bytes, fields) {
  /*
   * Only the frames we are actually about to write count as replaced. Listing
   * all five would delete the file's own artist and title on a batch that
   * resolved a genre but no names -- turning "we learned something new" into
   * "we lost what was already there".
   */
  const replacing = new Set(ID3_FRAMES
    .filter(([, key]) => fields[key] !== null && fields[key] !== undefined && fields[key] !== "")
    .map(([id]) => id));
  const tag = buildId3v2(fields, framesToCarryOver(bytes, replacing));
  if (!tag) return null;
  // The old tag is replaced rather than appended to: two ID3v2 headers in one
  // file is undefined behaviour, and readers disagree about which one wins.
  // What was worth keeping from it has already been carried across.
  const start = id3v2Length(bytes);
  if (start >= bytes.length) return null;
  const out = new Uint8Array(tag.length + (bytes.length - start));
  out.set(tag, 0);
  out.set(bytes.subarray(start), tag.length);
  return out;
}

const RIFF_HEADER_BYTES = 12;

function writeWavTags(bytes, fields) {
  const tag = buildId3v2(fields);
  if (!tag) return null;
  if (bytes.length < RIFF_HEADER_BYTES) return null;
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  if (!ascii(0, "RIFF") || !ascii(8, "WAVE")) return null;

  /*
   * The tag rides in its own "id3 " chunk at the end. RIFF chunks are padded to
   * an even length, and the size in the RIFF header counts everything after
   * that header -- recomputed from the real length rather than trusted, since a
   * streamed WAV can carry a placeholder there.
   */
  const padding = tag.length % 2;
  const chunk = 8 + tag.length + padding;
  const out = new Uint8Array(bytes.length + chunk);
  out.set(bytes, 0);

  let at = bytes.length;
  out[at++] = 0x69; out[at++] = 0x64; out[at++] = 0x33; out[at++] = 0x20; // "id3 "
  const size = tag.length;
  out[at++] = size & 0xff; out[at++] = (size >> 8) & 0xff;
  out[at++] = (size >> 16) & 0xff; out[at++] = (size >> 24) & 0xff;
  out.set(tag, at);

  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff; out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff; out[7] = (riffSize >> 24) & 0xff;
  return out;
}

/*
 * Returns the tagged bytes, or null when this container is not one we write.
 * Null is an answer, not a failure: the caller keeps the untagged output and
 * reports it, rather than shipping a file that was rewritten badly.
 */
function writeTags(bytes, extension, fields) {
  const kind = String(extension || "").toLowerCase();
  if (kind === ".mp3") return writeMp3Tags(bytes, fields);
  if (kind === ".wav") return writeWavTags(bytes, fields);
  return null;
}

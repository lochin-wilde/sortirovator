/*
 * Checks the Serato beat grid written into MP3 tags (tags.js).
 *
 * The expected bytes are a real Serato DJ grid: the "bpmlock-enabled" sample
 * in the serato-tags project (data/id3/bpmlock-enabled/Serato
 * BeatGrid.octet-stream, MIT licence), 0.305 s and 115 BPM. When this was
 * written, an MP3 tagged by this code was also read back with mutagen, which
 * found the GEOB frame with the right MIME, description and encoding, and the
 * marker's position and tempo intact.
 *
 *   node tools/test/test_serato_grid.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const tags = new Function(readFileSync("web/js/tags.js", "utf8")
  + "return { writeTags, seratoBeatGridData, id3GeobFrame, geobDescription, id3GeobDescriptions, seratoGridTag, mp3HeaderKind, mp3SampleRate, gridOffsetFor };")();

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/* ---------- Payload ---------- */

const SERATO_SAMPLE = "0100000000013e9c283842e6000000";
check("байты совпадают с сеткой из Serato (0.305 с, 115 BPM)", hex(tags.seratoBeatGridData(0.3049943447113037, 115)) === SERATO_SAMPLE);
{
  const d = tags.seratoBeatGridData(1.5, 128.25);
  const view = new DataView(d.buffer);
  check("версия 01 00 и один маркер", d[0] === 1 && d[1] === 0 && view.getUint32(2, false) === 1);
  check("позиция и темп — float32 big-endian", view.getFloat32(6, false) === 1.5 && view.getFloat32(10, false) === 128.25);
  check("длина 15 байт с хвостом", d.length === 15);
}

/* ---------- GEOB frame ---------- */

{
  const frame = tags.id3GeobFrame("Serato BeatGrid", tags.seratoBeatGridData(0.5, 120));
  const text = new TextDecoder("latin1").decode(frame.subarray(10, 10 + 1 + 24 + 1 + 1 + 15 + 1));
  check("кадр GEOB", String.fromCharCode(...frame.subarray(0, 4)) === "GEOB");
  check("кодировка Latin-1, MIME application/octet-stream, пустое имя файла",
    frame[10] === 0 && text.slice(1, 25) === "application/octet-stream" && frame[35] === 0 && frame[36] === 0);
  check("описание читается обратно", tags.geobDescription(frame) === "Serato BeatGrid");
}

/* ---------- Writing into an MP3 ---------- */

// A minimal MP3: an ID3v2.4 tag with one GEOB frame or none, then two bytes
// standing in for audio.
function mp3With(frames) {
  const body = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(10 + body + 2);
  out.set([0x49, 0x44, 0x33, 4, 0, 0, (body >> 21) & 0x7f, (body >> 14) & 0x7f, (body >> 7) & 0x7f, body & 0x7f]);
  let at = 10;
  for (const f of frames) { out.set(f, at); at += f.length; }
  out.set([0xff, 0xfb], at);
  return out;
}

{
  const out = tags.writeTags(mp3With([]), ".mp3", { bpm: "125", seratoBeatGrid: { position: 0.25, bpm: 125.5 } });
  check("сетка записана в MP3 без сетки", tags.id3GeobDescriptions(out).includes("Serato BeatGrid"));
  check("звук после тега не тронут", out[out.length - 2] === 0xff && out[out.length - 1] === 0xfb);
  const text = new TextDecoder("latin1").decode(out);
  check("BPM в тегах тоже записан (кадр TBPM с 125)", /TBPM[\s\S]{7}125/.test(text));
}
{
  // The file already has a Serato grid -- possibly set by hand. Ours must not
  // replace it.
  const theirs = tags.id3GeobFrame("Serato BeatGrid", tags.seratoBeatGridData(0.3049943447113037, 115));
  const out = tags.writeTags(mp3With([theirs]), ".mp3", { bpm: "126", seratoBeatGrid: { position: 9.9, bpm: 99 } });
  const at = Array.from(out).findIndex((_, i) => hex(out.subarray(i, i + 15)) === SERATO_SAMPLE);
  check("существующая сетка Serato сохранена", at > 0);
  check("и она одна, вторая не добавлена", tags.id3GeobDescriptions(out).filter((d) => d === "Serato BeatGrid").length === 1);
}
{
  const other = tags.id3GeobFrame("Serato Overview", new Uint8Array([1, 2, 3]));
  const out = tags.writeTags(mp3With([other]), ".mp3", { bpm: "126", seratoBeatGrid: { position: 1, bpm: 126 } });
  const found = tags.id3GeobDescriptions(out);
  check("другие кадры Serato переносятся, сетка добавляется", found.includes("Serato Overview") && found.includes("Serato BeatGrid"));
}
check("без сетки в полях кадр не появляется",
  tags.id3GeobDescriptions(tags.writeTags(mp3With([]), ".mp3", { bpm: "120" })).length === 0);

/* ---------- WAV ---------- */

{
  const wav = new Uint8Array(44);
  wav.set([82, 73, 70, 70], 0); // RIFF
  new DataView(wav.buffer).setUint32(4, 36, true);
  wav.set([87, 65, 86, 69], 8); // WAVE
  const out = tags.writeTags(wav, ".wav", { bpm: "120", seratoBeatGrid: { position: 1, bpm: 120 } });
  const text = new TextDecoder("latin1").decode(out);
  check("в WAV сетка Serato не пишется (формат не описан)", out && !text.includes("Serato BeatGrid"));
}

/* ---------- Grid added on download ---------- */

{
  const file = mp3With([tags.id3GeobFrame("Serato Overview", new Uint8Array([9, 9]))]);
  const swap = tags.seratoGridTag(file, { position: 0.5, bpm: 124 });
  const out = new Uint8Array(swap.tag.length + file.length - swap.replaces);
  out.set(swap.tag, 0);
  out.set(file.subarray(swap.replaces), swap.tag.length);
  check("новый тег заменяет ровно старый", swap.replaces === file.length - 2);
  check("после замены звук тот же, сетка и прежние кадры на месте",
    out[out.length - 2] === 0xff && out[out.length - 1] === 0xfb
    && tags.id3GeobDescriptions(out).sort().join() === "Serato BeatGrid,Serato Overview");
  check("второй раз сетка не добавляется", tags.seratoGridTag(out, { position: 1, bpm: 1 }) === null);
  const bare = tags.seratoGridTag(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { position: 0.1, bpm: 120 });
  check("MP3 без ID3 получает тег спереди, ничего не заменяя", bare && bare.replaces === 0 && bare.tag[0] === 0x49);
}

/* ---------- MP3 headers and offsets ---------- */

{
  // An MPEG-1 layer III frame header at 44.1 kHz (ff fb 90 00), then 36 bytes
  // of side information and the gapless header text.
  const frame = (text) => {
    const bytes = new Uint8Array(4 + 32 + text.length + 400);
    bytes.set([0xff, 0xfb, 0x90, 0x00]);
    bytes.set(Array.from(text, (c) => c.charCodeAt(0)), 36);
    return bytes;
  };
  check("заголовок LAME распознан", tags.mp3HeaderKind(frame("Info....LAME3.100")) === "lame");
  check("Xing без LAME", tags.mp3HeaderKind(frame("Xing")) === "xing");
  check("без заголовка — none", tags.mp3HeaderKind(frame("")) === "none");
  check("частота 44.1 кГц из заголовка кадра", tags.mp3SampleRate(frame("")) === 44100);
  const f48 = frame(""); f48[2] = 0x94;
  check("частота 48 кГц", tags.mp3SampleRate(f48) === 48000);
  // Behind a large ID3 tag the header is still found.
  const tag = new Uint8Array(10 + 300000);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0, (300000 >> 21) & 0x7f, (300000 >> 14) & 0x7f, (300000 >> 7) & 0x7f, 300000 & 0x7f]);
  const behind = new Uint8Array(tag.length + 500);
  behind.set(tag); behind.set(frame("Info....LAME3.99"), tag.length);
  check("заголовок за тегом в 300 КБ (обложка) находится", tags.mp3HeaderKind(behind) === "lame");
  check("Rekordbox: без LAME поправки нет", tags.gridOffsetFor("rekordbox", "xing", 44100) === 0);
  check("Rekordbox: LAME с маленьким тегом +17 мс, с большим +45 мс",
    tags.gridOffsetFor("rekordbox", "lame", 44100, 4000) === 0.017 && tags.gridOffsetFor("rekordbox", "lame", 44100, 200000) === 0.045);
  check("Serato: LAME +47 мс, без заголовка −5 мс, Xing +16 мс (по сеткам Serato в файлах)",
    tags.gridOffsetFor("serato", "lame", 44100) === 0.047 && tags.gridOffsetFor("serato", "none", 44100) === -0.005
    && tags.gridOffsetFor("serato", "xing", 48000) === 0.016);
  check("WAV — без поправки", tags.gridOffsetFor("serato", "wav", 44100) === 0);
}

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

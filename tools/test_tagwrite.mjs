/*
 * Checks the tags written back into the output files.
 *
 * A malformed tag is the quietest failure this app can produce. The archive
 * builds, the file downloads, the player still plays it, and the damage only
 * shows when Rekordbox reads a genre that isn't there -- or refuses the file
 * outright. So the writer is checked against the reader that ships beside it:
 * whatever buildId3v2 produces, parseId3v2 has to be able to read back.
 *
 *   node tools/test_tagwrite.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

// tags.js is a plain script with no browser API, so it loads whole and the
// writer is exercised against the reader from the same file.
const src = readFileSync("web/js/tags.js", "utf8");
const T = new Function(src + `
  return { readTags, parseId3v2, buildId3v2, writeTags, id3v2Length };`)();

const FIELDS = { title: "Drive", artist: "Black Coffee", genre: "Afro House", bpm: "121", key: "8A" };

/* ---------- the tag itself ---------- */

const tag = T.buildId3v2(FIELDS);
check("тег начинается с «ID3»",
  tag[0] === 0x49 && tag[1] === 0x44 && tag[2] === 0x33);
check("версия 2.4.0", tag[3] === 4 && tag[4] === 0);
check("флаги пустые: ни расширенного заголовка, ни футера", tag[5] === 0);
check("размер в заголовке совпадает с длиной кадров",
  (((tag[6] & 0x7f) << 21) | ((tag[7] & 0x7f) << 14) | ((tag[8] & 0x7f) << 7) | (tag[9] & 0x7f))
    === tag.length - 10);
check("в байтах размера нет 0xFF — иначе плеер примет их за синхрослово",
  [6, 7, 8, 9].every((i) => tag[i] < 0x80));
check("пустой набор полей не создаёт тег", T.buildId3v2({}) === null);
check("поля со значением null пропускаются",
  T.buildId3v2({ title: null, artist: "", genre: "House" }).length < tag.length);

/* ---------- читается собственным парсером ---------- */

const back = T.parseId3v2(tag);
check("парсер возвращает записанное название", back.title === "Drive");
check("парсер возвращает записанного артиста", back.artist === "Black Coffee");
check("парсер возвращает записанный жанр", back.genre === "Afro House");

const cyr = T.parseId3v2(T.buildId3v2({ artist: "Скриптонит", title: "Это любовь" }));
check("кириллица переживает запись и чтение",
  cyr.artist === "Скриптонит" && cyr.title === "Это любовь");

// The reader only wants genre, artist and title, so tempo and key are read here.
const frameText = (bytes, id) => {
  for (let at = 10; at + 10 < bytes.length;) {
    const name = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = ((bytes[at + 4] & 0x7f) << 21) | ((bytes[at + 5] & 0x7f) << 14)
      | ((bytes[at + 6] & 0x7f) << 7) | (bytes[at + 7] & 0x7f);
    if (size <= 0) break;
    if (name === id) return new TextDecoder().decode(bytes.subarray(at + 11, at + 10 + size));
    at += 10 + size;
  }
  return null;
};
check("темп попадает в TBPM", frameText(tag, "TBPM") === "121");
check("тональность попадает в TKEY в нотации Camelot", frameText(tag, "TKEY") === "8A");

/* ---------- MP3 ---------- */

const audio = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
const bare = new Uint8Array(audio);
const mp3 = T.writeTags(bare, ".mp3", FIELDS);
check("тег встаёт перед звуком", T.id3v2Length(mp3) > 0);
check("звук не тронут",
  Buffer.compare(Buffer.from(mp3.subarray(T.id3v2Length(mp3))), Buffer.from(audio)) === 0);
check("жанр читается из готового MP3", T.readTags(mp3, ".mp3").genre === "Afro House");

// A file that already has a tag must end up with one, not two.
const twice = T.writeTags(mp3, ".mp3", { genre: "UK Garage" });
check("прежний тег заменяется, а не дописывается",
  T.readTags(twice, ".mp3").genre === "UK Garage");
check("после замены звук всё ещё цел",
  Buffer.compare(Buffer.from(twice.subarray(T.id3v2Length(twice))), Buffer.from(audio)) === 0);
check("второй «ID3» в файле не появился",
  T.id3v2Length(twice.subarray(T.id3v2Length(twice))) === 0);

/* ---------- WAV ---------- */

const wav = (() => {
  const body = Uint8Array.from([
    0x66, 0x6d, 0x74, 0x20, 4, 0, 0, 0, 1, 0, 2, 0,       // "fmt " + 4 bytes
    0x64, 0x61, 0x74, 0x61, 4, 0, 0, 0, 9, 9, 9, 9,       // "data" + 4 bytes
  ]);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0);                    // "RIFF"
  const size = out.length - 8;
  out[4] = size & 0xff; out[5] = (size >> 8) & 0xff;
  out.set([0x57, 0x41, 0x56, 0x45], 8);                    // "WAVE"
  out.set(body, 12);
  return out;
})();

const tagged = T.writeTags(wav, ".wav", FIELDS);
const riffSize = tagged[4] | (tagged[5] << 8) | (tagged[6] << 16) | (tagged[7] << 24);
check("размер RIFF пересчитан под новую длину", riffSize === tagged.length - 8);
check("исходные чанки не сдвинулись",
  Buffer.compare(Buffer.from(tagged.subarray(12, wav.length)), Buffer.from(wav.subarray(12))) === 0);
check("в конце появился чанк «id3 »",
  String.fromCharCode(...tagged.subarray(wav.length, wav.length + 4)) === "id3 ");
check("длина чанка совпадает с длиной тега",
  (tagged[wav.length + 4] | (tagged[wav.length + 5] << 8)) === tag.length);
check("чанк выровнен по чётной границе", tagged.length % 2 === 0);
check("тег внутри чанка читается парсером",
  T.parseId3v2(tagged.subarray(wav.length + 8)).genre === "Afro House");
check("не-RIFF не трогается",
  T.writeTags(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), ".wav", FIELDS) === null);

/* ---------- чего мы не пишем ---------- */

check("FLAC возвращается нетронутым", T.writeTags(bare, ".flac", FIELDS) === null);
check("M4A возвращается нетронутым", T.writeTags(bare, ".m4a", FIELDS) === null);
check("неизвестное расширение не трогается", T.writeTags(bare, "", FIELDS) === null);
check("нечего писать — нет и записи", T.writeTags(bare, ".mp3", {}) === null);


/* ---------- перенос чужих кадров ---------- */

// A tag carrying something we never write: the writer must not eat it.
const withExtras = (() => {
  const base = T.buildId3v2({ title: "Старое имя", artist: "Старый артист", genre: "House" });
  const geob = Uint8Array.from([0x47, 0x45, 0x4f, 0x42, 0, 0, 0, 5, 0, 0, 7, 7, 7, 7, 7]);
  const merged = new Uint8Array(base.length + geob.length);
  merged.set(base, 0); merged.set(geob, base.length);
  const size = merged.length - 10;
  merged[6] = (size >> 21) & 0x7f; merged[7] = (size >> 14) & 0x7f;
  merged[8] = (size >> 7) & 0x7f; merged[9] = size & 0x7f;
  const out = new Uint8Array(merged.length + audio.length);
  out.set(merged, 0); out.set(audio, merged.length);
  return out;
})();

const rewritten = T.writeTags(withExtras, ".mp3", { genre: "Afro House" });
check("чужой кадр переносится в новый тег",
  frameText(rewritten.subarray(0, T.id3v2Length(rewritten)), "GEOB") !== null);
check("поле, которое мы пишем, заменяется",
  T.readTags(rewritten, ".mp3").genre === "Afro House");
check("поле, которое мы НЕ пишем, сохраняется",
  T.readTags(rewritten, ".mp3").artist === "Старый артист"
  && T.readTags(rewritten, ".mp3").title === "Старое имя");
check("звук после переноса кадров цел",
  Buffer.compare(Buffer.from(rewritten.subarray(T.id3v2Length(rewritten))), Buffer.from(audio)) === 0);
check("кадр с выставленными флагами отбрасывается, а не копируется криво", (() => {
  const flagged = new Uint8Array(withExtras);
  const at = flagged.indexOf(0x47, 10); // "G" of GEOB
  flagged[at + 9] = 0x02;               // compressed
  const out = T.writeTags(flagged, ".mp3", { genre: "X" });
  return frameText(out.subarray(0, T.id3v2Length(out)), "GEOB") === null;
})());

/* ---------- итог ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
for (const line of results) if (line.includes("МИМО")) console.log(line);
console.log(`пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);

/*
 * What reaches the genre lookups, and how fast.
 *
 * Every check here is a fault found by running a real batch -- 92 UK garage
 * tracks -- through the app: NUL bytes from ID3 tags sent as part of the
 * artist, version words taken for remixers, an artist repeated at the front
 * of a title read as a remix credit, and a rate limiter that let a request
 * out 141 ms after a throttled one.
 *
 *   node tools/test/test_lookup_hygiene.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const tags = new Function(readFileSync("web/js/tags.js", "utf8") + "return { parseId3v2, readTags };")();
const identify = new Function(readFileSync("web/js/identify.js", "utf8") +
  "return { remixerFromTitle, withoutArtistPrefix, makeRateLimiter };")();

/* ---------- ID3 text with NUL bytes ---------- */

// A minimal ID3v2 tag holding the given text frames, each payload given raw.
function id3(major, frames) {
  const body = [];
  for (const [id, payload] of frames) {
    const size = payload.length;
    const sizeBytes = major === 4
      ? [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]
      : [(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
    body.push(...[...id].map((c) => c.charCodeAt(0)), ...sizeBytes, 0, 0, ...payload);
  }
  const n = body.length;
  return new Uint8Array([0x49, 0x44, 0x33, major, 0, 0,
    (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f, ...body]);
}
const latin1 = (text) => [0, ...[...text].map((c) => c.charCodeAt(0))];
const utf8 = (text) => [3, ...new TextEncoder().encode(text)];
const utf16 = (text) => {
  const out = [1, 0xff, 0xfe];
  for (const c of text) { const code = c.charCodeAt(0); out.push(code & 0xff, code >> 8); }
  return out;
};

{
  const t = tags.parseId3v2(id3(3, [["TPE1", latin1("Aviso\0")], ["TIT2", latin1("STOP THINKING ABOUT ME\0")]]));
  check("ID3v2.3 latin-1: завершающий NUL убран из исполнителя", t.artist === "Aviso");
  check("ID3v2.3 latin-1: завершающий NUL убран из названия", t.title === "STOP THINKING ABOUT ME");
}
{
  const t = tags.parseId3v2(id3(3, [["TPE1", utf16("Pìjus\0")], ["TIT2", utf16("Count That\0")]]));
  check("UTF-16 с BOM: NUL убран, буквы с диакритикой целы", t.artist === "Pìjus" && t.title === "Count That");
}
{
  const t = tags.parseId3v2(id3(4, [["TPE1", utf8("KETTAMA\0Interplanetary Criminal")], ["TIT2", utf8("Yosemite\0")]]));
  check("ID3v2.4: несколько исполнителей через NUL -> через запятую", t.artist === "KETTAMA, Interplanetary Criminal");
  check("ID3v2.4: у названия берётся первое значение", t.title === "Yosemite");
}
{
  const t = tags.parseId3v2(id3(4, [["TCON", utf8("\0UK Garage\0")]]));
  check("жанр: пустое значение пропускается, берётся первое настоящее", t.genre === "UK Garage");
}
{
  const t = tags.parseId3v2(id3(3, [["TPE1", latin1("\0")]]));
  check("тег из одного NUL — пустой, а не строка из NUL", t.artist === null);
}
{
  const t = tags.parseId3v2(id3(3, [["TPE1", latin1("Disclosure")], ["TIT2", latin1("Latch")]]));
  check("обычный тег без NUL читается как раньше", t.artist === "Disclosure" && t.title === "Latch");
}

/* ---------- Remixer words ---------- */

const remixer = identify.remixerFromTitle;
check("(Vocal Edit) — не ремикс исполнителя Vocal", remixer("Be Alone (Vocal Edit)") === "");
check("(UK Garage Mix) — не ремиксер UK Garage", remixer("Gone (UK Garage Mix)") === "");
check("(Extended Vocal Mix) — никого не называет", remixer("Track (Extended Vocal Mix)") === "");
check("(MJ Cole Remix) — ремиксер MJ Cole", remixer("Remember Me (MJ Cole Remix)") === "MJ Cole");
check("(DJ EZ Remix) — DJ остаётся частью имени", remixer("Track (DJ EZ Remix)") === "DJ EZ");
check("последняя скобка с именем выигрывает", remixer("Track (Vocal Mix) (Sammy Virji Remix)") === "Sammy Virji");
check("форма «Название - Имя Remix» работает", remixer("Track - Kettama Remix") === "Kettama");

/* ---------- Artist repeated in the title ---------- */

const strip = identify.withoutArtistPrefix;
check("«KASHIN - HEY DJ DUB» при KASHIN -> «HEY DJ DUB»", strip("KASHIN - HEY DJ DUB", "KASHIN") === "HEY DJ DUB");
check("после этого «HEY DJ» больше не ремиксер", remixer(strip("KASHIN - HEY DJ DUB", "KASHIN")) === "");
check("длинное тире тоже отделяет исполнителя", strip("Disclosure — Latch", "Disclosure") === "Latch");
check("название, просто начинающееся с имени, не трогается", strip("Kashin Dreams", "KASHIN") === "Kashin Dreams");
check("название, равное имени, не стирается", strip("KASHIN", "KASHIN") === "KASHIN");
check("без исполнителя ничего не меняется", strip("A - B", "") === "A - B" && strip(null, "X") === null);

/* ---------- Rate limiter spacing ---------- */

/*
 * The gap is counted from when the previous task ended. A task that takes a
 * while -- a lookup with its retries -- must not let the next one out the
 * moment it finishes.
 */
{
  const limited = identify.makeRateLimiter(150);
  const starts = [];
  const slowTask = () => new Promise((resolve) => { starts.push(Date.now()); setTimeout(resolve, 300); });
  const quickTask = () => { starts.push(Date.now()); return Promise.resolve(); };
  await Promise.all([limited(slowTask), limited(quickTask), limited(quickTask)]);
  const gap1 = starts[1] - starts[0];
  const gap2 = starts[2] - starts[1];
  check(`после долгой задачи следующая ждёт полный интервал (${gap1} мс ≥ 440)`, gap1 >= 440);
  check(`быстрые задачи разнесены не меньше интервала (${gap2} мс ≥ 140)`, gap2 >= 140);
}
{
  const limited = identify.makeRateLimiter(100);
  const starts = [];
  const failing = () => { starts.push(Date.now()); return Promise.reject(new Error("503")); };
  await Promise.allSettled([limited(failing), limited(failing)]);
  check("после отказа следующий запрос тоже ждёт интервал", starts[1] - starts[0] >= 95);
}

const identifySrc = readFileSync("web/js/identify.js", "utf8");
check("MusicBrainz реже раза в секунду", /const rateLimited = makeRateLimiter\((\d+)\)/.exec(identifySrc)[1] > 1000);
check("все запросы к MusicBrainz идут с увеличенным числом попыток",
  !/rateLimited\(\(\) => fetchJson\(/.test(identifySrc) && /const MUSICBRAINZ_ATTEMPTS = ([5-9])/.test(identifySrc));
check("Discogs реже 25 в минуту", /const discogsRateLimited = makeRateLimiter\((\d+)\)/.exec(identifySrc)[1] > 2400);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

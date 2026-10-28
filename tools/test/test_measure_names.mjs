/*
 * Checks the yardstick in tools/measure/measure_names.mjs (nameOk): a name is
 * right when it carries every word of Rekordbox's artist and title, however
 * the two spell the joins between them.
 *
 *   node tools/test/test_measure_names.mjs
 */
import { nameOk } from "../measure/measure_names.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

check("то же имя — верно", nameOk("Alexander IV - Honest", "Alexander IV", "Honest"));
check("«&» и «;» между исполнителями не мешают", nameOk("Kraak & Smaak, Kosta G - Nothing Is Forever", "Kraak & Smaak Kosta G", "Nothing Is Forever"));
check("Sub:liminal и SubLiminal — одно имя", nameOk("SubLiminal & KVR - En Busca Del Sol", "Sub:liminal kVR", "En Busca del Sol"));
check("пропал приглашённый исполнитель — неверно", !nameOk("Max Oazo - Ain't No Sunshine (Original Mix)", "Max Oazo feat. Cami", "Ain't No Sunshine (Original Mix)"));
check("кавер переименован в оригинал — неверно", !nameOk("Lana Del Rey - Summertime Sadness", "Annabel", "Summertime Sadness"));
check("пустой эталон — не «верно»", !nameOk("Track", "", ""));

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

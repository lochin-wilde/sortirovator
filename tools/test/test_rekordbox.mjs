/*
 * Checks the Rekordbox collection round trip: reading an export, and writing
 * back only the tracks whose genre changed.
 *
 * This output goes into a working DJ's collection, where a track imported from
 * XML replaces the existing one wholesale -- grid, cues, rating, all of it. So
 * the property that matters most is that nothing but the Genre attribute
 * differs from what the user exported. The fixture is built to be awkward:
 * escaped and raw special characters, Cyrillic, a track with a grid and cues,
 * one with no Genre attribute at all, and playlist entries named TRACK that must
 * not be mistaken for collection tracks.
 *
 * The output is also parsed by Python's own XML parser, so well-formedness is
 * judged by something other than the scanner that produced it.
 *
 *   node tools/test/test_rekordbox.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const R = new Function(readFileSync("web/js/rekordbox.js", "utf8")
  + "\nreturn { readRekordboxXml, buildGenreImport, withGenre, xmlUnescape, xmlEscapeAttr, lookupNames };")();
const { parseFilename } = new Function(readFileSync("web/js/identify.js", "utf8") + "\nreturn { parseFilename };")();

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>

<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.14" Company="AlphaTheta"/>
  <COLLECTION Entries="5">
    <TRACK TrackID="11" Name="Drive" Artist="Black Coffee" Genre="" Kind="MP3 File" AverageBpm="121.00" Location="file://localhost/Volumes/HomeSSD/Lochin/Afro/Black%20Coffee%20-%20Drive.mp3" Tonality="8A">
      <TEMPO Inizio="0.025" Bpm="121.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="drop" Type="0" Start="64.123" Num="0" Red="40" Green="226" Blue="20"/>
    </TRACK>
    <TRACK TrackID="12" Name="Это любовь" Artist="Скриптонит" Kind="MP3 File" Location="file://localhost/x/%D0%AD.mp3" Tonality="12B"/>
    <TRACK TrackID="13" Name="A &gt; B &amp; &quot;C&quot;" Artist="Kraak &amp; Smaak" Genre="RUSSIAN" Comments="raw > inside" Location="file://localhost/y.mp3"/>
    <TRACK TrackID="14" Name="Keep" Artist="Me" Genre="House" Location="file://localhost/z.mp3"/>
    <TRACKS_NOT_A_TRACK TrackID="99" Name="bait"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="Set" Type="1" KeyType="0" Entries="2">
        <TRACK Key="11"/>
        <TRACK Key="13"/>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;

/* ---------- чтение ---------- */

const parsed = R.readRekordboxXml(FIXTURE);
check("найдено ровно 4 трека коллекции", parsed.tracks.length === 4);
check("TRACK из плейлистов не приняты за треки коллекции",
  parsed.tracks.every((t) => t.attrs.Key === undefined));
check("<TRACKS_NOT_A_TRACK> не принят за трек, хоть у него и есть TrackID", !parsed.tracks.some((t) => t.id === "99"));
const byId = Object.fromEntries(parsed.tracks.map((t) => [t.id, t]));
check("кириллица читается", byId["12"].attrs.Artist === "Скриптонит");
check("сущности раскрываются", byId["13"].attrs.Name === 'A > B & "C"');
check("сырой «>» в значении не рвёт тег", byId["13"].attrs.Comments === "raw > inside");
check("пустой жанр читается как пустая строка", byId["11"].attrs.Genre === "");
check("трека без атрибута Genre — undefined", byId["12"].attrs.Genre === undefined);
check("элемент трека включает сетку и кью",
  FIXTURE.slice(byId["11"].start, byId["11"].end).includes("<POSITION_MARK"));
check("PRODUCT сохранён как написан", parsed.product.includes('Version="7.2.14"'));

let threw = "";
try { R.readRekordboxXml("<html>not it</html>"); } catch (e) { threw = e.message; }
check("чужой файл — понятная ошибка, а не падение", threw.includes("not a Rekordbox"));
threw = "";
try { R.readRekordboxXml(FIXTURE.slice(0, FIXTURE.indexOf("</COLLECTION>"))); } catch (e) { threw = e.message; }
check("обрезанный файл — понятная ошибка", threw.includes("not closed"));

/* ---------- запись ---------- */

const changes = new Map([["11", "Afro House"], ["12", "Hip-Hop"], ["13", "Funky / Disco House & <Soul>"]]);
const out = R.buildGenreImport(FIXTURE, parsed, changes, "Музыкальный сортир — жанры");
const back = R.readRekordboxXml(out);
const outBy = Object.fromEntries(back.tracks.map((t) => [t.id, t]));

check("в выгрузке только изменённые треки", back.tracks.length === 3 && !outBy["14"]);
check("жанр заменён там, где был пустым", outBy["11"].attrs.Genre === "Afro House");
check("жанр добавлен туда, где атрибута не было", outBy["12"].attrs.Genre === "Hip-Hop");
check("жанр заменён поверх старого", outBy["13"].attrs.Genre === "Funky / Disco House & <Soul>");

// The central property: strip the Genre attribute from both versions of each
// track and they must be identical, grid and cues included.
const withoutGenre = (s) => s.replace(/\sGenre="[^"]*"/, "");
for (const id of ["11", "12", "13"]) {
  const before = withoutGenre(FIXTURE.slice(byId[id].start, byId[id].end));
  const after = withoutGenre(out.slice(outBy[id].start, outBy[id].end));
  check(`трек ${id}: кроме жанра не изменилось ни байта`, before === after);
}
check("сетка и кью перенесены", out.includes('<POSITION_MARK Name="drop" Type="0" Start="64.123"'));
check("Location не тронут", out.includes("Black%20Coffee%20-%20Drive.mp3"));

check("плейлист ссылается ровно на изменённые треки",
  (out.match(/<TRACK Key="/g) || []).length === 3);
check("имя плейлиста экранировано и на месте", out.includes('Name="Музыкальный сортир — жанры"'));
check("нет изменений — пустая коллекция, но валидный файл",
  R.readRekordboxXml(R.buildGenreImport(FIXTURE, parsed, new Map(), "x")).tracks.length === 0);

/* ---------- независимая проверка корректности XML ---------- */

const pyCheck = `
import sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.buffer.read())
coll = root.find("COLLECTION")
tracks = coll.findall("TRACK")
assert coll.get("Entries") == str(len(tracks)), "Entries does not match"
print(len(tracks), "|".join(t.get("Genre") for t in tracks))
`;
let pyOut = "";
try {
  pyOut = execFileSync("python3", ["-c", pyCheck], { input: out }).toString().trim();
} catch (e) { pyOut = "ОШИБКА: " + e.message.split("\n")[0]; }
check("Python разбирает выгрузку как корректный XML", !pyOut.startsWith("ОШИБКА"));
check("Python видит те же три жанра",
  pyOut === "3 Afro House|Hip-Hop|Funky / Disco House & <Soul>");

/* ---------- артист, спрятанный в названии ---------- */

let n = R.lookupNames({ Artist: "Black Coffee", Name: "Drive" }, parseFilename);
check("обычный трек: артист и название как есть", n.artist === "Black Coffee" && n.title === "Drive");
n = R.lookupNames({ Artist: "", Name: "Мари Краймбрери - Глупая" }, parseFilename);
check("пустой артист: «Артист - Название» делится", n.artist === "Мари Краймбрери" && n.title === "Глупая");
n = R.lookupNames({ Name: "Nothing Is Forever - Kraak & Smaak; Kosta G" }, parseFilename);
check("перевёрнутое «Название - Артист» распознаётся", n.artist === "Kraak & Smaak; Kosta G");
n = R.lookupNames({ Artist: "", Name: "Untitled" }, parseFilename);
check("без разделителя — название остаётся названием", n.artist === "" && n.title === "Untitled");
n = R.lookupNames({ Artist: "", Name: "A - B" });
check("без разборщика ничего не выдумывается", n.artist === "" && n.title === "A - B");

/* ---------- экранирование ---------- */

check("управляющие символы выкидываются, XML их не допускает",
  R.xmlEscapeAttr("a\u0001b\u0008c") === "abc");
check("перевод строки в значении сохраняется", R.xmlEscapeAttr("a\nb") === "a\nb");
check("числовые ссылки раскрываются", R.xmlUnescape("&#1069;&#x42D;") === "ЭЭ");

const failed = results.filter((line) => line.includes("МИМО"));
for (const line of failed) console.log(line);
console.log(`пройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);

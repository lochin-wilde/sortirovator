/*
 * Checks rekordbox.xml for the archive's new tracks (rekordbox.js): the folder
 * the user types, the file URIs built from it, the TEMPO element, and the
 * guard that keeps out tracks the collection already has.
 *
 * Rekordbox finds an imported file by its Location and nothing else, so a
 * wrongly encoded path is a track that silently does not arrive. The output is
 * also read by Python's XML parser, so well-formedness is judged by something
 * other than the code that wrote it.
 *
 *   node tools/test/test_rekordbox_grid.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const R = new Function(readFileSync("web/js/rekordbox.js", "utf8")
  + "\nreturn { archiveFolderPath, trackLocation, buildGridImport, locationKey, collectionLocations, readRekordboxXml };")();

/* ---------- The folder ---------- */

check("путь Mac, слэш в конце убран", R.archiveFolderPath(" /Users/dj/Music/SortedMusic/ ") === "/Users/dj/Music/SortedMusic");
check("путь Windows: обратные слэши в прямые", R.archiveFolderPath("C:\\Users\\dj\\Music\\Sorted") === "C:/Users/dj/Music/Sorted");
check("путь в кавычках (как копирует Finder)", R.archiveFolderPath("'/Volumes/HomeSSD/New'") === "/Volumes/HomeSSD/New");
check("«~» и относительный путь — нет", R.archiveFolderPath("~/Music") === null && R.archiveFolderPath("Music/Sorted") === null);
check("пусто — нет", R.archiveFolderPath("") === null && R.archiveFolderPath("   ") === null);

/* ---------- Locations ---------- */

const mac = R.trackLocation("/Users/dj/Music/Sorted Music", "UK Garage/Kraak & Smaak - #1 Это.mp3");
check(`Mac: пробел, &, # и кириллица закодированы (${mac})`,
  mac === "file://localhost/Users/dj/Music/Sorted%20Music/UK%20Garage/Kraak%20%26%20Smaak%20-%20%231%20%D0%AD%D1%82%D0%BE.mp3");
const win = R.trackLocation("C:/Music", "House/a b.wav");
check(`Windows: буква диска с двоеточием как есть (${win})`, win === "file://localhost/C:/Music/House/a%20b.wav");
check("корень диска не даёт двойного слэша", R.trackLocation("/", "x.mp3") === "file://localhost/x.mp3");
check("один путь в двух написаниях — один ключ",
  R.locationKey("file://localhost//Volumes/A%20B/%D0%AD.mp3") === R.locationKey("file://localhost/Volumes/A B/Э.mp3"));
check("разные файлы — разные ключи", R.locationKey(mac) !== R.locationKey(win));

/* ---------- XML ---------- */

const tracks = [
  { location: mac, name: 'A "quoted" & <odd>', artist: "Kraak & Smaak", genre: "UK Garage", kind: "MP3 File", seconds: 301.6, bpm: 130, firstBeat: 0.0623 },
  // A first beat before 0 (an offset can push it there) moves one beat later.
  { location: win, name: "b", artist: "", genre: "", kind: "WAV File", seconds: 200, bpm: 120, firstBeat: -0.1 },
];
const xml = R.buildGridImport(tracks, "Музыкальный сортир — сетка");
const pyCheck = `
import sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.buffer.read())
out = []
for t in root.find("COLLECTION").findall("TRACK"):
    tempo = t.findall("TEMPO")
    out.append("|".join([t.get("TrackID"), t.get("Name"), t.get("Artist"), t.get("Genre") or "-", t.get("Kind"),
                         t.get("TotalTime") or "-", t.get("AverageBpm"), str(len(tempo))] +
                        [tempo[0].get(k) for k in ("Inizio", "Bpm", "Metro", "Battito")]))
node = root.find("PLAYLISTS").find("NODE").find("NODE")
out.append(node.get("Name") + "|" + node.get("Entries") + "|" + ",".join(k.get("Key") for k in node.findall("TRACK")))
print("\\n".join(out))
`;
let py;
try {
  py = execFileSync("python3", ["-c", pyCheck], { input: xml }).toString().trim().split("\n");
} catch (e) { py = ["ОШИБКА: " + e.message.split("\n")[0]]; }
check("Python разбирает файл как корректный XML", !py[0].startsWith("ОШИБКА"));
check(`первый трек: имя с кавычками и &, жанр, MP3, 302 с, 130.00 BPM, одна TEMPO (${py[0]})`,
  py[0] === '1|A "quoted" & <odd>|Kraak & Smaak|UK Garage|MP3 File|302|130.00|1|0.062|130.00|4/4|1');
check(`первая доля до начала файла сдвинута на долю позже: 0.400 (${py[1]})`,
  py[1] === "2|b||-|WAV File|200|120.00|1|0.400|120.00|4/4|1");
check(`плейлист со всеми треками по TrackID (${py[2]})`, py[2] === "Музыкальный сортир — сетка|2|1,2");

const back = R.readRekordboxXml(xml);
check("свой же файл читается обратно, пути те же", back.tracks.length === 2 && back.tracks[0].attrs.Location === mac);
check("пустой список — тоже корректный файл", R.readRekordboxXml(R.buildGridImport([], "x")).tracks.length === 0);

/* ---------- Tracks the collection already has ---------- */

const collection = R.readRekordboxXml(`<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1">
<TRACK TrackID="7" Name="x" Location="file://localhost//Users/dj/Music/Sorted%20Music/UK%20Garage/Kraak%20&amp;%20Smaak%20-%20%231%20%D0%AD%D1%82%D0%BE.mp3"/>
</COLLECTION></DJ_PLAYLISTS>`);
const known = R.collectionLocations(collection);
check("трек из коллекции узнан, хотя путь записан иначе", known.has(R.locationKey(mac)));
check("новый трек не узнан", !known.has(R.locationKey(win)));
check("без коллекции — пусто", R.collectionLocations(null).size === 0);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

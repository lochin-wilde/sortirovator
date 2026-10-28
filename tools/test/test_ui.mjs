/*
 * Checks the decisions behind the page: presets, what mixes with what, what the
 * archive preview shows, and that every string the page asks for exists in
 * both languages.
 *
 * The translation check is here because a missing key does not fail anywhere:
 * t() shows the key itself, so "mix.title" would sit on the page in place of a
 * heading until someone happened to look. And a key written twice in one table
 * is legal JavaScript -- the second silently wins -- which is how the English
 * interface came to say "could not load the archive library" in Russian.
 *
 *   node tools/test/test_ui.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const views = new Function(readFileSync("web/js/views.js", "utf8") +
  "return { PRESETS, matchPreset, parseCamelot, camelotRelation, tempoDistance, mixNeighbours, archiveTree, MIX_TEMPO_TOLERANCE," +
  " keyConfidenceLevel, emptyColumns, primaryAction, unsavedWork, OPTIONAL_COLUMNS, batchPlan, secondsLeft," +
  " needsCheck, matchQuery, tableCsv, barAction };")();
const html = readFileSync("web/index.html", "utf8");
const appSrc = readFileSync("web/js/app.js", "utf8");
const i18nSrc = readFileSync("web/js/i18n.js", "utf8");

/* ---------- Presets ---------- */

const off = { fixNames: false, sort: false, bpmKey: false, loudness: false };
check("«Разобрать библиотеку» = жанры + BPM/тональность",
  views.matchPreset({ ...off, sort: true, bpmKey: true }) === "library");
check("«Всё сразу» = все четыре", views.matchPreset({ fixNames: true, sort: true, bpmKey: true, loudness: true }) === "everything");
check("«Только BPM и тональность»", views.matchPreset({ ...off, bpmKey: true }) === "analyze");
check("«Только жанры»", views.matchPreset({ ...off, sort: true }) === "genres");
check("своя комбинация — без набора", views.matchPreset({ ...off, loudness: true }) === null);
check("ничего не выбрано — без набора", views.matchPreset(off) === null);

// The switches the page opens with have to be a preset, or the first thing a
// user sees is "your own combination" under a row of chips none of which is lit.
const checkedOnLoad = {
  fixNames: /id="step-fix-names" checked/.test(html),
  sort: /id="step-sort" checked/.test(html),
  bpmKey: /id="step-bpm-key" checked/.test(html),
  loudness: /id="step-loudness" checked/.test(html),
};
check("страница открывается на наборе «Разобрать библиотеку»", views.matchPreset(checkedOnLoad) === "library");
const chipIds = [...html.matchAll(/data-preset="([a-z]+)"/g)].map((m) => m[1]);
check("кнопки наборов = наборы из views.js, в том же порядке",
  JSON.stringify(chipIds) === JSON.stringify(views.PRESETS.map((p) => p.id)));

/* ---------- Camelot ---------- */

check("8A и 8A — та же", views.camelotRelation("8A", "8A") === "same");
check("8A и 8B — параллельная", views.camelotRelation("8A", "8B") === "relative");
check("8A → 9A — +1", views.camelotRelation("8A", "9A") === "up");
check("8A → 7A — −1", views.camelotRelation("8A", "7A") === "down");
check("12A → 1A — +1 через конец круга", views.camelotRelation("12A", "1A") === "up");
check("1B → 12B — −1 через начало круга", views.camelotRelation("1B", "12B") === "down");
check("8A и 9B — не по правилам", views.camelotRelation("8A", "9B") === null);
check("8A и 10A — не по правилам", views.camelotRelation("8A", "10A") === null);
check("регистр и пробелы не мешают", views.camelotRelation(" 8a", "8A ") === "same");
check("13A — не ключ", views.parseCamelot("13A") === null);
check("пустой ключ — не ключ", views.camelotRelation(null, "8A") === null);

/* ---------- Tempo ---------- */

const near = views.tempoDistance(124, 122);
check("124 и 122 — прямо, около +1.6%", near.factor === 1 && Math.abs(near.delta - 2 / 122) < 1e-9);
const half = views.tempoDistance(174, 87);
check("174 и 87 — в половинном темпе, без разницы", half.factor === 2 && Math.abs(half.delta) < 1e-9);
const double = views.tempoDistance(85, 172);
check("85 и 172 — в двойном темпе", double.factor === 0.5);
check("нет темпа — нет сравнения", views.tempoDistance(124, null) === null && views.tempoDistance(0, 120) === null);

/* ---------- Neighbours ---------- */

const rows = [
  { name: "target", key: "8A", bpm: 124 },
  { name: "same key, close", key: "8A", bpm: 125 },
  { name: "+1, closer tempo", key: "9A", bpm: 124 },
  { name: "relative", key: "8B", bpm: 122 },
  { name: "wrong key", key: "3A", bpm: 124 },
  { name: "too fast", key: "8A", bpm: 140 },
  { name: "half time", key: "7A", bpm: 62 },
  { name: "no key", key: null, bpm: 124 },
  { name: "failed", key: "8A", bpm: 124, error: "decode" },
  { name: "same key, exact", key: "8A", bpm: 124 },
];
const names = (list, from) => list.map((n) => from[n.index].name);
const found = views.mixNeighbours(rows, 0);
const foundNames = names(found, rows);
check("та же тональность идёт первой, ближайший темп раньше",
  foundNames[0] === "same key, exact" && foundNames[1] === "same key, close");
check("соседи по кругу и параллельная — в списке",
  ["+1, closer tempo", "relative", "half time"].every((n) => foundNames.includes(n)));
check("чужая тональность отсеяна", !foundNames.includes("wrong key"));
check("темп дальше допуска отсеян", !foundNames.includes("too fast"));
check("трек без тональности отсеян, когда у выбранного она есть", !foundNames.includes("no key"));
check("трек с ошибкой отсеян", !foundNames.includes("failed"));
check("сам трек не советует сам себя", !found.some((n) => n.index === 0));
const halfEntry = found.find((n) => rows[n.index].name === "half time");
check("половинный темп помечен множителем 2", halfEntry && halfEntry.factor === 2);
check("каждый найденный — в пределах ±6%",
  found.every((n) => Math.abs(n.delta) <= views.MIX_TEMPO_TOLERANCE));

const tempoOnly = views.mixNeighbours([{ key: null, bpm: 124 }, { key: "3A", bpm: 123 }, { key: null, bpm: 150 }], 0);
check("без тональности решает один темп", tempoOnly.length === 1 && tempoOnly[0].index === 1 && tempoOnly[0].relation === null);
check("ничего не измерено — пустой список", views.mixNeighbours([{ key: null, bpm: null }, { key: "8A", bpm: 120 }], 0).length === 0);
check("строка с ошибкой — пустой список", views.mixNeighbours([{ error: "x", key: "8A", bpm: 120 }, { key: "8A", bpm: 120 }], 0).length === 0);
const many = [{ key: "8A", bpm: 120 }, ...Array.from({ length: 30 }, () => ({ key: "8A", bpm: 120 }))];
check("список ограничен 12 треками", views.mixNeighbours(many, 0).length === 12);

/* ---------- Archive preview ---------- */

const tree = views.archiveTree([
  "House/A - One.mp3",
  "House/B - Two.mp3",
  "House/B - Two (2).mp3",
  "Techno/C - Three.wav",
  "Playlists/All tracks.m3u8",
  "Playlists/By BPM.m3u8",
  "Playlists/By key.m3u8",
  "Loose - Track.mp3",
  "Empty/",
], "Playlists");
check("самая большая папка первой", tree.folders[0].name === "House" && tree.folders[0].files.length === 3);
check("плейлисты в конце, хотя их больше", tree.folders[tree.folders.length - 1].name === "Playlists");
check("файл с (2) показан отдельно", tree.folders[0].files.includes("B - Two (2).mp3"));
check("файлы в корне собраны отдельно", tree.rootFiles.length === 1 && tree.rootFiles[0] === "Loose - Track.mp3");
check("запись-каталог без файлов не даёт пустой папки", !tree.folders.some((f) => f.name === "Empty"));
check("пустой архив — пустое дерево", views.archiveTree([], "Playlists").folders.length === 0);

/* ---------- macOS bookkeeping files ---------- */

const cut = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`не найдена функция ${name} в web/js/app.js`);
  let depth = 0;
  for (let i = appSrc.indexOf("{", start); i < appSrc.length; i++) {
    if (appSrc[i] === "{") depth++;
    else if (appSrc[i] === "}" && --depth === 0) return appSrc.slice(start, i + 1);
  }
  throw new Error(`не удалось выделить ${name}`);
};
const isMacMetadata = new Function(cut("isMacMetadata") + "return isMacMetadata;")();
check("._трек.mp3 — служебный файл macOS", isMacMetadata({ name: "._Artist - Title.mp3" }));
check(".DS_Store — служебный файл macOS", isMacMetadata({ name: ".DS_Store" }));
check("обычный трек — не служебный", !isMacMetadata({ name: "Artist - Title.mp3" }));
check("точка в середине имени не мешает", !isMacMetadata({ name: "Mr._Oizo - Flat Beat.mp3" }));

/* ---------- Starting audio ---------- */

/*
 * A batch that cannot get a running AudioContext must stop and say so, not
 * hang. Contexts here are stand-ins with the three behaviours a browser shows.
 */
// cut() starts at "function", so the async keyword is put back here.
const audioReady = new Function("async " + cut("audioReady") + "return audioReady;")();
const ctx = (state, resume) => ({ state, resume });
check("уже запущенный звук — готов", await audioReady(ctx("running", () => { throw new Error("not called"); }), 50));
{
  const c = ctx("suspended", null);
  c.resume = () => { c.state = "running"; return Promise.resolve(); };
  check("пауза, браузер разрешил — готов", await audioReady(c, 50));
}
{
  // Bounded here as well, so the old behaviour -- waiting forever -- shows up
  // as a failure instead of a test run that never ends.
  const ready = await Promise.race([
    audioReady(ctx("suspended", () => new Promise(() => {})), 60),
    new Promise((resolve) => setTimeout(() => resolve("завис"), 1000)),
  ]);
  check("браузер молчит — не готов, без зависания", ready === false);
}
check("браузер отказал — не готов", await audioReady(ctx("suspended", () => Promise.reject(new Error("NotAllowed"))), 50) === false);
check("resume бросает сразу — не готов", await audioReady(ctx("suspended", () => { throw new Error("x"); }), 50) === false);
check("нет контекста — не готов", await audioReady(null, 50) === false);

// The click handler has to start audio before anything in it awaits; after a
// network wait Safari no longer counts the click.
const startHandler = appSrc.slice(appSrc.indexOf('ui.start.addEventListener("click"'));
const handlerBody = startHandler.slice(0, startHandler.indexOf("});"));
check("кнопка запуска включает звук до запуска прогона",
  handlerBody.includes("unlockAudio()") && handlerBody.indexOf("unlockAudio()") < handlerBody.indexOf("runBatch()"));
const runBatchSrc = cut("runBatch");
check("прогон без звука останавливается с сообщением, а не ждёт",
  /audioReady\(state\.audioContext, AUDIO_RESUME_TIMEOUT_MS\)/.test(runBatchSrc) &&
  runBatchSrc.indexOf('notify("msg.audioBlocked")') < runBatchSrc.indexOf("state.running = true"));
check("в прогоне не осталось ожидания resume() без срока",
  !/await state\.audioContext\.resume\(\)/.test(appSrc));

/*
 * Decoding happens at 44.1 kHz whatever the sound card runs at, in an offline
 * context; the page's own context only when that one cannot decode. Stand-ins
 * record which context decoded and at what rate the offline one was made.
 */
{
  const make = (offline) => {
    const log = { made: [], decodedBy: [], reads: 0 };
    const window = {
      OfflineAudioContext: offline === "missing" ? undefined : function (channels, length, rate) {
        if (offline === "throws") throw new Error("NotSupported");
        log.made.push(rate);
        this.name = "offline";
        this.decodeAudioData = () => (offline === "refuses" ? Promise.reject(new Error("EncodingError")) : Promise.resolve({ by: "offline" }));
      },
    };
    const state = { decodeContext: undefined, audioContext: { decodeAudioData: () => Promise.resolve({ by: "page" }) } };
    const decodeFile = new Function("window", "state", cut("decodeAudioData") + "\nconst DECODE_RATE = 44100;\nasync " + cut("decodeFile") + "return decodeFile;")(window, state);
    const file = { arrayBuffer: async () => { log.reads++; return new ArrayBuffer(8); } };
    return { decodeFile, file, log };
  };
  {
    const { decodeFile, file, log } = make("works");
    const a = await decodeFile(file), b = await decodeFile(file);
    check("декодирует в отдельном контексте на 44.1 кГц, а не в контексте страницы",
      a.by === "offline" && b.by === "offline" && JSON.stringify(log.made) === "[44100]");
  }
  {
    const { decodeFile, file, log } = make("refuses");
    const a = await decodeFile(file).catch(() => ({}));
    check("отказ отдельного контекста — декодирует страница, файл прочитан заново", a.by === "page" && log.reads === 2);
  }
  {
    const { decodeFile, file } = make("throws");
    check("отдельный контекст не создаётся — декодирует страница", (await decodeFile(file).catch(() => ({}))).by === "page");
  }
  {
    const { decodeFile, file } = make("missing");
    check("в браузере нет OfflineAudioContext — декодирует страница", (await decodeFile(file).catch(() => ({}))).by === "page");
  }
  check("файлы декодирует decodeFile, а не контекст страницы напрямую",
    /audioBuffer = await decodeFile\(file\)/.test(appSrc) && !/decodeAudioData\(state\.audioContext, bytes\)/.test(appSrc));
}

/* ---------- Setup: what a batch will do ---------- */

{
  const all = { musicbrainz: true, discogs: true, lastfm: false };
  const library = views.batchPlan({ fixNames: false, sort: true, bpmKey: true, loudness: false }, all);
  check("«Разобрать библиотеку»: папки, теги, плейлисты",
    JSON.stringify(library.archive) === JSON.stringify(["plan.folders", "plan.tags", "plan.playlists"]));
  check("«Разобрать библиотеку»: жанры ищутся в Discogs, iTunes, MusicBrainz",
    JSON.stringify(library.online) === JSON.stringify(["Discogs", "iTunes", "MusicBrainz"]));
  check("только BPM и тональность — в интернет ничего не уходит",
    views.batchPlan({ fixNames: false, sort: false, bpmKey: true, loudness: false }, all).online.length === 0);
  check("названия без MusicBrainz — не ищутся нигде",
    views.batchPlan({ fixNames: true, sort: false, bpmKey: false, loudness: false }, { musicbrainz: false, discogs: true, lastfm: true }).online.length === 0);
  check("Last.fm назван только при ключе и сортировке",
    views.batchPlan({ fixNames: false, sort: true, bpmKey: false, loudness: false }, { musicbrainz: false, discogs: false, lastfm: true }).online.join() === "Last.fm" &&
    views.batchPlan({ fixNames: true, sort: false, bpmKey: false, loudness: false }, { musicbrainz: false, discogs: false, lastfm: true }).online.length === 0);
  check("ничего не включено — архив пуст", views.batchPlan({ fixNames: false, sort: false, bpmKey: false, loudness: false }, all).archive.length === 0);
  // Keys built in code are invisible to the data-i18n check further down.
  const keys = ["plan.folders", "plan.tags", "plan.names", "plan.loudness", "plan.playlists",
    ...["fixNames", "sort", "bpmKey", "loudness"].map((n) => "short." + n)];
  const enTable = i18nSrc.slice(i18nSrc.indexOf("  en: {"), i18nSrc.indexOf("  ru: {"));
  const ruTable = i18nSrc.slice(i18nSrc.indexOf("  ru: {"));
  const lost = keys.filter((k) => !enTable.includes(`"${k}":`) || !ruTable.includes(`"${k}":`));
  check("строки, собираемые в коде, есть на обоих языках" + (lost.length ? ": нет " + lost.join(", ") : ""), lost.length === 0);
}

check("время до конца: после одного трека не гадаем", views.secondsLeft(1, 10, 5) === null);
check("время до конца: 2 трека за 20 с из 10 — ещё 80 с", views.secondsLeft(2, 10, 20) === 80);
check("время до конца: пачка закончена — ничего", views.secondsLeft(10, 10, 60) === null);

{
  const aside = html.slice(html.indexOf('<aside class="setup-plan"'), html.indexOf("</aside>"));
  check("кнопка запуска стоит в блоке «Что получится»", aside.includes('id="start"'));
  check("секция результатов скрыта, пока нечего показать", /<section class="step" id="step-3" hidden>/.test(html));
  check("сообщение о том, почему прогон не начался, открывает секцию результатов",
    /closest\("\.step"\)/.test(cut("notify")) && /section\.hidden = false/.test(cut("notify")));
  const tune = html.slice(html.indexOf('<details class="fine-tune"'), html.indexOf("</details>\n\n  <!-- Shown only while loudness"));
  check("четыре переключателя и поиск свёрнуты в «Тонкую настройку»",
    ["step-fix-names", "step-sort", "step-bpm-key", "step-loudness", 'data-slot="files"'].every((id) => tune.includes(id)));
}

/* ---------- The results table ---------- */

check("нет тональности — нет точек", views.keyConfidenceLevel({ key: null }) === 0);
check("ниже порога работника — одна точка", views.keyConfidenceLevel({ key: "4A", keyConfident: false, keyConfidence: 0.14 }) === 1);
check("уверенно, 0.69 — две точки", views.keyConfidenceLevel({ key: "4A", keyConfident: true, keyConfidence: 0.69 }) === 2);
check("уверенно, 0.70 — три точки", views.keyConfidenceLevel({ key: "4A", keyConfident: true, keyConfidence: 0.7 }) === 3);
check("уверенно, но без числа — две точки", views.keyConfidenceLevel({ key: "4A", keyConfident: true, keyConfidence: null }) === 2);

{
  const rows = [
    { feedbackArtist: "ZHU", genre: null, bpm: 125, key: "3A", browseLufs: -13.4 },
    { feedbackArtist: null, genre: null, bpm: null, key: null, browseLufs: null },
  ];
  check("жанры не искались — колонка жанра скрыта, остальные нет",
    JSON.stringify(views.emptyColumns(rows)) === JSON.stringify(["genre"]));
  check("жанр есть хотя бы у одного трека — колонка видна",
    !views.emptyColumns([...rows, { genre: "House" }]).includes("genre"));
  check("пустая таблица — ничего не скрываем", views.emptyColumns([]).length === 0);
  check("только жанры — скрыты темп, тональность и громкость",
    JSON.stringify(views.emptyColumns([{ feedbackArtist: "ZHU", genre: "House", bpm: null, key: null, browseLufs: null }])) ===
    JSON.stringify(["bpm", "key", "loudness"]));
}
// A column the code can hide has to be marked in all three places, or hiding
// it takes the header away and leaves the cells, shifting every column after.
{
  const css = readFileSync("web/css/styles.css", "utf8");
  const cells = cut("resultCells");
  const missing = Object.keys(views.OPTIONAL_COLUMNS).filter((c) =>
    !new RegExp(`<th class="[^"]*\\bc-${c}\\b`).test(html) || !cells.includes(`c-${c}`) ||
    !css.includes(`.results[data-hide~="${c}"] .c-${c}`));
  check("каждая скрываемая колонка помечена в заголовке, в ячейке и в стилях" + (missing.length ? ": нет " + missing.join(", ") : ""),
    missing.length === 0);
}

check("идёт пачка — главная кнопка «Начать»", views.primaryAction({ running: true, produced: 3 }) === "start");
check("ничего не собрано — главная «Начать»", views.primaryAction({ running: false, produced: 0 }) === "start");
check("архив собран — главная «Скачать ZIP»", views.primaryAction({ running: false, produced: 6 }) === "download");

check("пачка идёт — уход со страницы спрашивает", views.unsavedWork({ running: true, produced: 0, downloaded: false }));
check("архив не скачан — спрашивает", views.unsavedWork({ running: false, produced: 6, downloaded: false }));
check("архив скачан — не спрашивает", !views.unsavedWork({ running: false, produced: 6, downloaded: true }));
check("пустая страница — не спрашивает", !views.unsavedWork({ running: false, produced: 0, downloaded: false }));
check("страница предупреждает при закрытии, пока работа не сохранена",
  /addEventListener\("beforeunload"/.test(appSrc) && /unsavedWork\(/.test(appSrc) && /state\.downloaded = true/.test(cut("downloadZip")));

{
  const stub = { t: (k) => ({ "table.keyConf1": "уверенность низкая", "table.drift": "плавает", "table.driftRange": "120–132" })[k] || k,
    escapeHtml: (x) => String(x), keyConfidenceLevel: views.keyConfidenceLevel };
  const keyCellHtml = new Function(...Object.keys(stub), cut("keyCellHtml") + "return keyCellHtml;")(...Object.values(stub));
  const bpmCellHtml = new Function(...Object.keys(stub), cut("bpmCellHtml") + "return bpmCellHtml;")(...Object.values(stub));
  const unsure = keyCellHtml({ key: "4A", keyConfident: false, keyConfidence: 0.14 });
  check("неуверенная тональность — без «?» и «(0.14)» в тексте, с точками",
    !/4A\?|\(0\.14\)/.test(unsure.replace(/title="[^"]*"/, "")) && unsure.includes("level-1"));
  check("плавающий темп — словом, а не «~»", !bpmCellHtml({ bpm: 128, bpmMode: "dynamic" }).includes("~") &&
    bpmCellHtml({ bpm: 128, bpmMode: "dynamic" }).includes("плавает"));
  check("ровный темп — просто число", bpmCellHtml({ bpm: 125, bpmMode: "constant" }) === "125");
}

check("блок архива свёрнут в одну строку, пояснения к сетке спрятаны",
  /<details class="archive-preview" id="archive-preview"/.test(html) &&
  /<details class="grid-help">[\s\S]*grid\.accuracy[\s\S]*grid\.rb\.how[\s\S]*grid\.cdj[\s\S]*<\/details>/.test(html));

/* ---------- Results: search, the "check" view, CSV, the open track ---------- */

{
  const zhu = { name: "ZHU - Ghost In My Bed.mp3", feedbackArtist: "ZHU", genre: "House", bpm: 125, key: "3A", keyConfident: true, keyConfidence: 0.86 };
  check("поиск «3a» — по тональности", views.matchQuery(zhu, "3a") && !views.matchQuery(zhu, "4a"));
  check("поиск «124 – 128» с пробелами и длинным тире — диапазон темпа", views.matchQuery(zhu, "124 – 128"));
  check("поиск «128-124» — диапазон в обратном порядке тоже", views.matchQuery(zhu, "128-124"));
  check("границы диапазона включены", views.matchQuery(zhu, "125-130") && !views.matchQuery(zhu, "126-130"));
  check("все слова должны совпасть: «zhu 3a» да, «zhu 4a» нет", views.matchQuery(zhu, "zhu 3a") && !views.matchQuery(zhu, "zhu 4a"));
  check("трек без темпа в диапазон не попадает", !views.matchQuery({ name: "x" }, "120-130"));
  check("пустой поиск — всё", views.matchQuery(zhu, "  "));

  check("проверить: тональность ниже порога", views.needsCheck({ key: "4A", keyConfident: false }));
  check("проверить: плавающий темп", views.needsCheck({ bpmMode: "dynamic" }));
  check("проверить: жанр угадан по артисту или не найден", views.needsCheck({ genreWeak: true }) && views.needsCheck({ genre: "Unknown" }));
  check("проверить: ошибка", views.needsCheck({ error: "x" }));
  check("уверенный трек проверять не нужно", !views.needsCheck(zhu));

  const csv = views.tableCsv([
    { name: '=HYPERLINK("x"),a.mp3', feedbackArtist: "A; B", bpm: 125, bpmMode: "dynamic", key: "3A", keyConfidence: 0.8612, browseLufs: -13.44, outputPath: "House/a.mp3" },
  ], ["Файл", "Исполнитель", "Жанр", "BPM", "Темп", "мин", "макс", "Тональность", "Уверенность", "LUFS", "Результат"]);
  const lines = csv.split("\r\n");
  check("CSV: метка UTF-8 для Excel и строки через CRLF", csv.startsWith("\uFEFFФайл,") && lines.length === 3 && lines[2] === "");
  check("CSV: формула в имени файла обезврежена и взята в кавычки", lines[1].startsWith('"\'=HYPERLINK(""x""),a.mp3"'));
  check("CSV: поле с «;» в кавычках, числа как числа", lines[1].includes('"A; B"') && lines[1].includes(",125,dynamic,") && lines[1].includes(",0.86,-13.4,"));
}
{
  const area = html.slice(html.indexOf('<div class="results-area"'));
  check("панель трека стоит рядом с таблицей", /<aside class="track-panel" id="track-panel" hidden><\/aside>/.test(area));
  check("колонка «Результат» помечена в заголовке и в ячейке",
    /<th class="c-output"/.test(html) && cut("resultCells").includes("c-output"));
  const place = cut("placePlayer");
  check("плеер создаётся заново только при смене трека, иначе переносится",
    /player\.row !== openRow/.test(place) && /appendChild\(player\.element\)/.test(place));
  check("закрытый трек — плеер останавливается и отпускает файл",
    /\.pause\(\)/.test(cut("stopPlayer")) && /revokeObjectURL/.test(cut("stopPlayer")));
  check("место для плеера есть и в панели, и в строке под треком",
    cut("panelHtml").includes("player-slot") && cut("renderResults").includes("player-slot"));
  check("новая пачка и очистка закрывают трек и плеер", (appSrc.match(/clearTrackPanel\(\);/g) || []).length === 2);
  check("файл трека запоминается для плеера", /resultFiles\.set\(result, file\)/.test(appSrc));
}

/* ---------- Phones ---------- */

check("кнопка внизу телефона: до прогона — «Начать»", views.barAction({ running: false, produced: 0 }) === "start");
check("во время прогона — «Отмена»", views.barAction({ running: true, produced: 3 }) === "cancel");
check("после прогона — «Скачать ZIP»", views.barAction({ running: false, produced: 6 }) === "download");
{
  const files = html.slice(html.indexOf('id="mode-files-panel"'), html.indexOf('id="mode-rekordbox-panel"'));
  check("закреплённая кнопка живёт в режиме файлов и прячется вместе с ним", files.includes('id="action-bar"'));
  const sync = cut("syncActionBar");
  check("она повторяет подпись, доступность и нажатие настоящей кнопки",
    /textContent = actionTarget\.textContent/.test(sync) && /disabled = actionTarget\.disabled/.test(sync) &&
    /actionTarget\.click\(\)/.test(appSrc) && /new MutationObserver\(syncActionBar\)/.test(appSrc));
  const css = readFileSync("web/css/styles.css", "utf8");
  const phone = css.slice(css.indexOf("/* Phones: the button that matters now"));
  check("на телефоне таблица становится карточками без заголовка",
    /\.results thead \{ display: none; \}/.test(phone) && /tr\.track-row \{\s*display: grid;/.test(phone));
  check("на компьютере закреплённой кнопки нет", /^\.action-bar \{ display: none; \}$/m.test(css));
}

/* ---------- Translations ---------- */

// Lines of one language's table, by its opening line, up to the next table.
function tableKeys(language) {
  const start = i18nSrc.indexOf(`  ${language}: {`);
  const end = i18nSrc.indexOf("\n  },", start);
  return [...i18nSrc.slice(start, end).matchAll(/^\s+"([\w.]+)":/gm)].map((m) => m[1]);
}
const en = tableKeys("en");
const ru = tableKeys("ru");
const duplicates = (keys) => keys.filter((k, i) => keys.indexOf(k) !== i);
check(`в английской таблице нет повторов (${duplicates(en).join(", ") || "—"})`, duplicates(en).length === 0);
check(`в русской таблице нет повторов (${duplicates(ru).join(", ") || "—"})`, duplicates(ru).length === 0);
const onlyEn = en.filter((k) => !ru.includes(k));
const onlyRu = ru.filter((k) => !en.includes(k));
check(`ключи есть в обоих языках (только en: ${onlyEn.join(", ") || "—"}; только ru: ${onlyRu.join(", ") || "—"})`,
  onlyEn.length === 0 && onlyRu.length === 0);

const pageKeys = [...html.matchAll(/data-i18n(?:-placeholder|-title|-html|-aria)?="([\w.]+)"/g)].map((m) => m[1]);
const missingOnPage = [...new Set(pageKeys)].filter((k) => !en.includes(k) || !ru.includes(k));
check(`каждый ключ из index.html переведён (нет: ${missingOnPage.join(", ") || "—"})`, missingOnPage.length === 0);

// Keys app.js asks for by literal name: t("…") and notify("…"). A prefix with
// the rest added in code -- t("mix." + relation) -- is not a key and is skipped.
const codeKeys = [...appSrc.matchAll(/\b(?:t|notify|rbSetStatus)\("([\w.]+)"\s*[,)]/g)].map((m) => m[1]);
const missingInCode = [...new Set(codeKeys)].filter((k) => !en.includes(k) || !ru.includes(k));
check(`каждый ключ из app.js переведён (нет: ${missingInCode.join(", ") || "—"})`, missingInCode.length === 0);

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

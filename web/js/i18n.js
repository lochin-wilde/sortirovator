"use strict";
/*
 * i18n.js -- interface language, Russian and English.
 *
 * Static markup carries a data-i18n attribute and is filled in on load and on
 * every switch; strings built in code go through t(). Placeholders are named
 * ({count}, {file}) rather than positional, because Russian and English put the
 * same values in different places in a sentence.
 *
 * The brand name stays Cyrillic in both languages, the way brand names normally
 * do, so it is deliberately not in this table.
 */

const TRANSLATIONS = {
  en: {
    "gate.signout": "Sign out",
    "app.tagline": "Sorts, renames and normalizes your library in the browser. Your audio stays here \u2014 only track names go out, to look them up in the music databases.",
    "lang.label": "Language",

    "step1.title": "Select tracks",
    "step1.pickFiles": "Choose files",
    "step1.pickFolder": "Choose folder",
    "step1.hint": "Supported: MP3, WAV, FLAC, M4A.",
    "step1.hintNoFolder": "Supported: MP3, WAV, FLAC, M4A. This browser has no folder picker, so select the files directly (you can select many at once).",

    "step2.title": "Choose what to run",
    "step2.fixNames": "Fix track names",
    "step2.fixNamesHint": "Look the track up on iTunes and MusicBrainz and rename it to the canonical Artist - Title.",
    "step2.sort": "Sort by genre",
    "step2.sortHint": "Place each track into a folder named after its genre.",
    "step2.bpmKey": "Detect BPM and key",
    "step2.bpmKeyHint": "Tempo plus the Camelot wheel code, for harmonic mixing.",
    "step2.loudness": "Normalize loudness",
    "step2.loudnessHint": "Match every track to the same LUFS target. Re-encodes the audio.",

    "loudness.legend": "Loudness options",
    "loudness.mode": "Mode",
    "loudness.shortTerm": "Short-Term Max",
    "loudness.integrated": "Integrated",
    "loudness.convertOnly": "Convert only (no gain change)",
    "loudness.target": "Target LUFS",
    "loudness.format": "Output format",
    "loudness.wav": "WAV (16-bit)",
    "loudness.mp3": "MP3 (320 kbps)",
    "loudness.sampleRate": "Sample rate",
    "loudness.sameRate": "Same as source",
    "loudness.limiter": "Safe limiter (-1 dBTP)",
    "loudness.trim": "Remove leading/trailing silence",
    "loudness.prefix": "Add LUFS prefix to filename",

    "lookups.legend": "Online lookups",
    "lookups.musicbrainz": "Identify tracks online — iTunes and MusicBrainz (names, genre tags)",
    "lookups.discogs": "Use Discogs (the most precise genre source)",
    "lookups.lastfm": "Last.fm API key (optional)",
    "lookups.lastfmPlaceholder": "Leave empty to skip Last.fm",
    "lookups.hint": "Only the artist and title are sent, never the audio. iTunes is asked first because it has far more of the streaming era; MusicBrainz answers where iTunes has nothing. Both allow about one request per second and Discogs 25 per minute, so large batches with lookups enabled take a while. Turn both off to run fully offline on audio analysis alone.",

    "step3.title": "Run",
    "step3.start": "Start analysis",
    "step3.cancel": "Cancel",
    "step3.download": "Download ZIP",
    "step3.reset": "Clear and start over",
    "step3.resetHint": "Download the ZIP before clearing — the archive is held in memory and clearing discards it.",
    "step3.batch": "Batch",
    "step3.currentFile": "Current file",

    "table.file": "File",
    "table.artist": "Artist",
    "table.filterPlaceholder": "Filter by genre, artist or name…",
    "table.showing": "showing {shown} of {total}",
    "table.sortHint": "Click a column heading to sort. Loudness sorts calmest first — it reflects how the track was mastered, not how intense the music is.",
    "table.genre": "Genre",
    "table.bpm": "BPM",
    "table.key": "Key",
    "table.loudness": "Loudness",
    "table.output": "Output",
    "log.title": "Developer log",

    "stage.identifying": "Identifying",
    "stage.decoding": "Decoding",
    "stage.bpm": "BPM",
    "stage.key": "Key",
    "stage.genre": "Genre",
    "stage.loudness": "Loudness",
    "stage.rendering": "Rendering",

    "msg.noFlac": "Note: this browser reports no FLAC support. FLAC files may fail to decode; convert them to MP3 or WAV first.",
    "msg.environment": "Environment: {agent}",
    "msg.dirPicker": "Directory picker: {state}",
    "msg.available": "available",
    "msg.notAvailable": "not available",
    "msg.noSab": "SharedArrayBuffer unavailable (no COOP/COEP headers). Analysis runs single-threaded, which is expected here.",
    "summary.selected": "{count} tracks selected",
    "summary.skippedType": "{count} skipped (unsupported format)",
    "summary.skippedSize": "{count} skipped (larger than {limit} MB)",
    "summary.more": "and {count} more",
    "msg.zipUnavailable": "Could not load the archive library. Check the connection and try again.",
    "msg.zipUnavailable": "Не удалось загрузить библиотеку архивации. Проверьте соединение и попробуйте снова.",
    "msg.tooBig": "Skipped {name} — {size} MB, over the {limit} MB limit. Decoding expands audio, so a file this size can exhaust the tab's memory and lose the whole batch.",
    "msg.selected": "Selected {count} supported files, skipped {skipped}.",
    "msg.workerError": "Worker error: {message}",
    "msg.mp3Unavailable": "MP3 encoder unavailable (lamejs did not load); wrote WAV instead.",
    "msg.mapLoaded": "Loaded genre map with {count} tag mappings.",
    "msg.mapFailed": "Could not load data/genres_map.json ({message}). Genre normalization will fall back to audio analysis.",
    "msg.nothingToDo": "Nothing to do: select at least one process in step 2.",
    "msg.batchStart": "Starting batch of {total} files.",
    "msg.steps": "Steps: {steps}",
    "msg.cancelled": "Cancelled by user after {done} files.",
    "msg.processing": "[{index}/{total}] Processing: {file}",
    "msg.finished": "Finished: {done} processed, {failed} failed, {produced} files in the archive.",
    "msg.zipReady": "The ZIP is ready. Press Download ZIP, then Clear and start over for the next batch.",
    "msg.cleared": "Cleared. Select the next batch of files.",
    "msg.packing": "Packing...",
    "msg.packingPercent": "Packing {percent}%",
    "msg.archiveWritten": "Archive written: {size} MB.",
    "msg.archiveFailed": "Failed to build the archive: {message}",
    "msg.cancelRequested": "Cancel requested; finishing the current file first.",

    "res.identifiedAs": "  Identified as: {name} (title similarity {title}, artist similarity {artist})",
    "res.notIdentified": "  Identification: no confident MusicBrainz match, keeping the original name",
    "res.lookupFailed": "  Identification: lookup failed ({message}), keeping the original name",
    "res.viaCyrillic": ", via Cyrillic retry",
    "res.genre": "  Genre: {genre}",
    "res.genreWithSource": "  Genre: {genre} (from {source})",
    "res.genreOff": "  Genre: (sorting off)",
    "res.bpmKey": "  BPM: {bpm}   Key: {key}",
    "res.bpmNotDetected": "not detected",
    "res.bpmDynamic": "{bpm} (dynamic tempo, {min}-{max} across the track; the grid will drift)",
    "res.keyNotDetected": "not detected",
    "res.keyConfident": "{key} (chroma correlation {score})",
    "res.keyGuess": "{key}? — low confidence ({score} < {threshold}), treat as a guess",
    "res.loudnessConvert": "  Loudness: convert only, no gain change applied",
    "res.loudnessFull": "  Loudness ({mode}): measured {measured} LUFS -> target {target} LUFS = gain {gain} dB{peak}",
    "res.loudnessPeak": ", true peak before: {peak} dBFS",
    "res.loudnessGain": "  Loudness gain applied: {gain} dB",
    "res.output": "  -> {path}",
    "res.error": "  ERROR: {message}",
    "genre.fromYouTrack": "your correction for this track",
    "genre.fromYouArtist": "your corrections for this artist",
    "feedback.saved": "Genre corrected to {genre}. {count} corrections stored — they will be applied automatically from now on.",
    "feedback.sent": "Corrections sent to the author: {count}.",
    "feedback.sendFailed": "Could not send corrections ({count}) — saved locally, will go out next time.",
    "feedback.hint": "Click a genre in the table to correct it. Corrections are remembered, reused, and sent to the author to improve detection — the track name, the genre and the measured BPM and key, never the audio.",
    "feedback.export": "Export corrections",
    "feedback.clear": "Clear corrections",
    "feedback.cleared": "Corrections cleared.",
    "feedback.none": "No corrections stored yet.",
    "clean.underscores": "underscores replaced with spaces",
    "clean.spaces": "repeated spaces collapsed",
    "clean.downloadId": "trailing download id removed",
    "clean.site": "download site address removed",
    "clean.bitrate": "bitrate or format tag removed",
    "clean.mediaLabel": "\"official video\" style label removed",
    "clean.leftovers": "leftover separators tidied",
    "res.cleaned": "  Name tidied ({changes}): {name}",
    "res.maybeRussian": "  Note: this name reads like transliterated Russian. It was left as is — restoring Cyrillic needs a MusicBrainz match, and guessing would damage genuine English titles.",
  },

  ru: {
    "gate.signout": "Выйти",
    "app.tagline": "Сортирует, переименовывает и выравнивает громкость прямо в браузере. Музыка никуда не уходит \u2014 наружу отправляются только названия треков, чтобы найти их в музыкальных базах.",
    "lang.label": "Язык",

    "step1.title": "Выбор треков",
    "step1.pickFiles": "Выбрать файлы",
    "step1.pickFolder": "Выбрать папку",
    "step1.hint": "Поддерживаются: MP3, WAV, FLAC, M4A.",
    "step1.hintNoFolder": "Поддерживаются: MP3, WAV, FLAC, M4A. В этом браузере нет выбора папки — укажите файлы напрямую, можно сразу много.",

    "step2.title": "Что запустить",
    "step2.fixNames": "Исправить названия",
    "step2.fixNamesHint": "Найти трек в iTunes и MusicBrainz и переименовать в канонический вид «Исполнитель — Название».",
    "step2.sort": "Разложить по жанрам",
    "step2.sortHint": "Каждый трек попадёт в папку с названием своего жанра.",
    "step2.bpmKey": "Определить BPM и тональность",
    "step2.bpmKeyHint": "Темп и код по колесу Camelot — для гармоничного сведения.",
    "step2.loudness": "Выровнять громкость",
    "step2.loudnessHint": "Привести все треки к одной громкости в LUFS. Звук перекодируется.",

    "loudness.legend": "Настройки громкости",
    "loudness.mode": "Режим",
    "loudness.shortTerm": "Пиковая кратковременная",
    "loudness.integrated": "Интегральная",
    "loudness.convertOnly": "Только конвертация (без изменения громкости)",
    "loudness.target": "Целевая LUFS",
    "loudness.format": "Формат на выходе",
    "loudness.wav": "WAV (16 бит)",
    "loudness.mp3": "MP3 (320 кбит/с)",
    "loudness.sampleRate": "Частота дискретизации",
    "loudness.sameRate": "Как в исходнике",
    "loudness.limiter": "Безопасный лимитер (−1 dBTP)",
    "loudness.trim": "Убрать тишину в начале и в конце",
    "loudness.prefix": "Добавить LUFS в начало имени файла",

    "lookups.legend": "Поиск в интернете",
    "lookups.musicbrainz": "Опознавать треки в интернете — iTunes и MusicBrainz (названия, жанры)",
    "lookups.discogs": "Использовать Discogs (самый точный источник жанров)",
    "lookups.lastfm": "Ключ Last.fm API (необязательно)",
    "lookups.lastfmPlaceholder": "Оставьте пустым, чтобы не обращаться к Last.fm",
    "lookups.hint": "Наружу уходят только исполнитель и название, звук — никогда. Сначала спрашиваем iTunes: у него заметно полнее покрыта стриминговая эпоха; MusicBrainz отвечает там, где у iTunes ничего нет. Оба разрешают примерно один запрос в секунду, Discogs — 25 в минуту, поэтому большие пачки с поиском идут долго. Отключите оба, чтобы работать полностью офлайн — только по анализу звука.",

    "step3.title": "Запуск",
    "step3.start": "Начать анализ",
    "step3.cancel": "Отмена",
    "step3.download": "Скачать ZIP",
    "step3.reset": "Очистить и начать заново",
    "step3.resetHint": "Скачайте архив до очистки — он хранится в памяти и при очистке пропадёт.",
    "step3.batch": "Пачка",
    "step3.currentFile": "Текущий файл",

    "table.file": "Файл",
    "table.artist": "Исполнитель",
    "table.filterPlaceholder": "Фильтр по жанру, исполнителю или имени…",
    "table.showing": "показано {shown} из {total}",
    "table.sortHint": "Нажмите на заголовок столбца для сортировки. Громкость сортируется от тихих — она отражает мастеринг, а не музыкальную энергичность.",
    "table.genre": "Жанр",
    "table.bpm": "BPM",
    "table.key": "Тональность",
    "table.loudness": "Громкость",
    "table.output": "Результат",
    "log.title": "Журнал для разработчика",

    "stage.identifying": "Опознание",
    "stage.decoding": "Декодирование",
    "stage.bpm": "BPM",
    "stage.key": "Тональность",
    "stage.genre": "Жанр",
    "stage.loudness": "Громкость",
    "stage.rendering": "Сборка",

    "msg.noFlac": "Внимание: браузер сообщает, что не поддерживает FLAC. Такие файлы могут не открыться — переконвертируйте их в MP3 или WAV.",
    "msg.environment": "Окружение: {agent}",
    "msg.dirPicker": "Выбор папки: {state}",
    "msg.available": "доступен",
    "msg.notAvailable": "недоступен",
    "msg.noSab": "SharedArrayBuffer недоступен (нет заголовков COOP/COEP). Анализ идёт в один поток — здесь это нормально.",
    "summary.selected": "Выбрано треков: {count}",
    "summary.skippedType": "пропущено {count} (неподдерживаемый формат)",
    "summary.skippedSize": "пропущено {count} (больше {limit} МБ)",
    "summary.more": "и ещё {count}",
    "msg.zipUnavailable": "Не удалось загрузить библиотеку архивации. Проверьте соединение и попробуйте снова.",
    "msg.tooBig": "Пропущен {name} — {size} МБ при пределе {limit} МБ. При декодировании звук занимает больше, чем на диске, и такой файл может исчерпать память вкладки, потеряв всю партию.",
    "msg.selected": "Выбрано подходящих файлов: {count}, пропущено: {skipped}.",
    "msg.workerError": "Ошибка воркера: {message}",
    "msg.mp3Unavailable": "Кодировщик MP3 недоступен (lamejs не загрузился), записан WAV.",
    "msg.mapLoaded": "Карта жанров загружена: {count} тегов.",
    "msg.mapFailed": "Не удалось загрузить data/genres_map.json ({message}). Жанр будет определяться только по звуку.",
    "msg.nothingToDo": "Нечего делать: отметьте хотя бы один пункт на шаге 2.",
    "msg.batchStart": "Запуск пачки из {total} файлов.",
    "msg.steps": "Этапы: {steps}",
    "msg.cancelled": "Отменено пользователем после {done} файлов.",
    "msg.processing": "[{index}/{total}] Обработка: {file}",
    "msg.finished": "Готово: обработано {done}, с ошибкой {failed}, в архиве {produced} файлов.",
    "msg.zipReady": "Архив готов. Нажмите «Скачать ZIP», затем «Очистить и начать заново» для следующей пачки.",
    "msg.cleared": "Очищено. Выберите следующую пачку файлов.",
    "msg.packing": "Упаковка…",
    "msg.packingPercent": "Упаковка {percent}%",
    "msg.archiveWritten": "Архив записан: {size} МБ.",
    "msg.archiveFailed": "Не удалось собрать архив: {message}",
    "msg.cancelRequested": "Запрошена отмена; текущий файл будет дообработан.",

    "res.identifiedAs": "  Опознан как: {name} (совпадение названия {title}, исполнителя {artist})",
    "res.notIdentified": "  Опознание: уверенного совпадения в MusicBrainz нет, имя оставлено как было",
    "res.lookupFailed": "  Опознание: поиск не удался ({message}), имя оставлено как было",
    "res.viaCyrillic": ", через повтор с кириллицей",
    "res.genre": "  Жанр: {genre}",
    "res.genreWithSource": "  Жанр: {genre} (источник: {source})",
    "res.genreOff": "  Жанр: (сортировка выключена)",
    "res.bpmKey": "  BPM: {bpm}   Тональность: {key}",
    "res.bpmNotDetected": "не определён",
    "res.bpmDynamic": "{bpm} (плавающий темп, {min}-{max} по треку; сетка будет уплывать)",
    "res.keyNotDetected": "не определена",
    "res.keyConfident": "{key} (корреляция хромы {score})",
    "res.keyGuess": "{key}? — низкая уверенность ({score} < {threshold}), считайте догадкой",
    "res.loudnessConvert": "  Громкость: только конвертация, усиление не менялось",
    "res.loudnessFull": "  Громкость ({mode}): измерено {measured} LUFS -> цель {target} LUFS = усиление {gain} дБ{peak}",
    "res.loudnessPeak": ", истинный пик до обработки: {peak} dBFS",
    "res.loudnessGain": "  Применено усиление: {gain} дБ",
    "res.output": "  -> {path}",
    "res.error": "  ОШИБКА: {message}",
    "genre.fromYouTrack": "ваше исправление для этого трека",
    "genre.fromYouArtist": "ваши исправления по этому исполнителю",
    "feedback.saved": "Жанр исправлен на {genre}. Сохранено исправлений: {count} — дальше применяются автоматически.",
    "feedback.sent": "Исправлений отправлено автору: {count}.",
    "feedback.sendFailed": "Не удалось отправить исправления ({count}) — сохранены локально, уйдут в следующий раз.",
    "feedback.hint": "Нажмите на жанр в таблице, чтобы исправить. Исправления запоминаются, применяются впредь и отправляются автору, чтобы улучшить определение жанров: название трека, жанр и измеренные BPM с тональностью. Сама музыка не отправляется.",
    "feedback.export": "Выгрузить исправления",
    "feedback.clear": "Очистить исправления",
    "feedback.cleared": "Исправления очищены.",
    "feedback.none": "Исправлений пока нет.",
    "clean.underscores": "подчёркивания заменены пробелами",
    "clean.spaces": "лишние пробелы убраны",
    "clean.downloadId": "убран номер закачки в конце",
    "clean.site": "убран адрес сайта-качалки",
    "clean.bitrate": "убрана пометка о битрейте или формате",
    "clean.mediaLabel": "убрана пометка вида «official video»",
    "clean.leftovers": "подчищены осиротевшие разделители",
    "res.cleaned": "  Имя приведено в порядок ({changes}): {name}",
    "res.maybeRussian": "  Похоже, это русское название латиницей. Оставлено как есть — вернуть кириллицу можно только по совпадению в MusicBrainz, а угадывать опасно: пострадали бы настоящие английские названия.",
  },
};

const LANGUAGE_STORAGE_KEY = "sortirovator.language";

// Russian first: the app is built for a Russian-speaking DJ, and an unfamiliar
// interface language is a worse first impression than an unfamiliar layout.
let currentLanguage = "ru";

/*
 * A saved choice always wins. Failing that the interface opens in Russian
 * regardless of the browser's locale: the app is built for a Russian-speaking
 * DJ, and several machines here report en-GB while their owner does not read
 * English comfortably. The switch is in the masthead for anyone who wants
 * otherwise, and their choice is remembered from then on.
 */
function detectInitialLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved && TRANSLATIONS[saved]) return saved;
  } catch (e) { /* private browsing blocks storage */ }
  return "ru";
}

/*
 * Looks up a string and fills in named placeholders.
 *
 * A missing key returns the key itself rather than an empty string, so a gap in
 * the table is visible in the interface instead of silently blank.
 */
function t(key, values) {
  const table = TRANSLATIONS[currentLanguage] || TRANSLATIONS.en;
  let text = table[key];
  if (text === undefined) text = TRANSLATIONS.en[key];
  if (text === undefined) return key;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    (values[name] !== undefined ? String(values[name]) : match));
}

function getLanguage() {
  return currentLanguage;
}

function setLanguage(language) {
  if (!TRANSLATIONS[language]) return;
  currentLanguage = language;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch (e) { /* ignore */ }
  document.documentElement.lang = language;
  applyTranslations();
}

/*
 * Fills every element carrying data-i18n. Attributes are addressed as
 * data-i18n-placeholder and data-i18n-title so one element can localize both
 * its text and its attributes.
 */
function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("[data-i18n-html]").forEach((node) => {
    node.textContent = t(node.getAttribute("data-i18n-html"));
  });
}

"use strict";
/*
 * admin.js -- usage figures and genre corrections on admin.html.
 *
 * The 403 a non-admin gets back from /api/admin/feedback is the actual
 * security boundary (see functions/api/admin/feedback.js); everything here is
 * just turning that response, or a successful one, into something readable.
 * A tester who navigates here directly by guessing the URL sees a polite
 * "admins only" message, not broken markup or a silent blank page.
 */

const el = (id) => document.getElementById(id);

function initLanguage() {
  const buttons = Array.from(document.querySelectorAll(".lang-button"));
  const paint = () => {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === getLanguage())));
  };
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      setLanguage(button.dataset.lang);
      paint();
      renderRows(lastEntries);
      if (lastStats) renderStats(lastStats);
    });
  });
  setLanguage(detectInitialLanguage());
  paint();
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso || "");
  // Locale-aware but stable across reloads: same visitor, same rendering.
  return d.toLocaleString(getLanguage() === "ru" ? "ru-RU" : "en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function bpmKeyCell(entry) {
  const bpm = entry.bpm != null ? Math.round(entry.bpm * 10) / 10 : null;
  const parts = [bpm != null ? `${bpm}` : "", entry.song_key || ""].filter(Boolean);
  return escapeHtml(parts.join(" / "));
}

/*
 * Raw values are kept raw until the one point they are written out.
 *
 * The filename used to be escaped when it stood in for a missing title and then
 * escaped again on output, so "Kraak & Smaak.mp3" rendered as "Kraak &amp;
 * Smaak.mp3". And because the comparison below then held an escaped string
 * against a raw one, the two never matched and the filename appeared twice.
 */
function trackCell(entry) {
  const artist = entry.artist || "";
  const title = entry.title || "";
  const file = entry.file || "";
  const line1 = [artist, title].filter(Boolean).join(" \u2014 ") || file;
  const hint = file && line1 !== file ? `<div class="hint">${escapeHtml(file)}</div>` : "";
  return `${escapeHtml(line1)}${hint}`;
}

function detectedCell(entry) {
  const source = entry.detected_source ? ` <span class="hint">(${escapeHtml(entry.detected_source)})</span>` : "";
  return `${escapeHtml(entry.detected || "\u2014")}${source}`;
}

let lastEntries = [];

function renderRows(entries) {
  lastEntries = entries;
  const body = el("admin-body");
  body.innerHTML = entries.map((entry) => `
    <tr>
      <td>${formatWhen(entry.received_at)}</td>
      <td>${escapeHtml(entry.invite || "")}</td>
      <td>${trackCell(entry)}</td>
      <td>${detectedCell(entry)}</td>
      <td>${escapeHtml(entry.corrected || "")}</td>
      <td>${bpmKeyCell(entry)}</td>
    </tr>`).join("");
}

function setStatus(key, isError) {
  const status = el("admin-status");
  const table = el("admin-table");
  if (!key) {
    status.hidden = true;
    table.hidden = false;
    return;
  }
  status.hidden = false;
  table.hidden = true;
  status.dataset.i18n = key;
  status.textContent = t(key);
  status.classList.toggle("error", Boolean(isError));
}

async function load() {
  setStatus("admin.loading", false);
  let res;
  try {
    res = await fetch("/api/admin/feedback", { credentials: "same-origin" });
  } catch (e) {
    setStatus("admin.loadError", true);
    return;
  }

  if (res.status === 403) {
    setStatus("admin.forbidden", true);
    return;
  }
  if (!res.ok) {
    setStatus("admin.loadError", true);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    setStatus("admin.loadError", true);
    return;
  }

  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (entries.length === 0) {
    setStatus("admin.empty", false);
    // The empty state still needs an up-to-date table underneath it in case
    // the visitor's language changes afterwards and re-renders zero rows.
    renderRows(entries);
    return;
  }

  renderRows(entries);
  setStatus(null, false);
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

let lastStats = null;

function number(value) {
  const n = Number(value) || 0;
  return n.toLocaleString(getLanguage() === "ru" ? "ru-RU" : "en-GB");
}

function modeName(mode) {
  return mode === "rekordbox" ? t("mode.rekordbox") : t("mode.files");
}

function presetName(preset) {
  return preset ? t("preset." + preset) : "\u2014";
}

function breakdown(rows, label, value) {
  if (!rows.length) return `<tr><td class="hint">${escapeHtml(t("stats.none"))}</td></tr>`;
  return rows.map((row) =>
    `<tr><td>${escapeHtml(label(row))}</td><td class="num">${escapeHtml(value(row))}</td></tr>`).join("");
}

function renderStats(stats) {
  lastStats = stats;
  const totals = stats.totals || {};
  const tiles = [
    ["stats.users7", totals.users7],
    ["stats.users30", totals.users30],
    ["stats.runs30", totals.runs30],
    ["stats.tracks30", totals.tracks30],
    ["stats.runsAll", totals.runsAll],
    ["stats.tracksAll", totals.tracksAll],
  ];
  el("stats-totals").innerHTML = tiles.map(([key, value]) =>
    `<div class="stat"><div class="stat-value">${escapeHtml(number(value))}</div>` +
    `<div class="stat-label">${escapeHtml(t(key))}</div></div>`).join("");

  el("stats-by-mode").innerHTML = breakdown(stats.byMode || [],
    (row) => modeName(row.mode),
    (row) => t("stats.runsTracks", { runs: number(row.runs), tracks: number(row.tracks) }));
  el("stats-by-preset").innerHTML = breakdown(stats.byPreset || [],
    (row) => presetName(row.preset), (row) => number(row.runs));
  el("stats-by-version").innerHTML = breakdown(stats.byVersion || [],
    (row) => row.version, (row) => number(row.runs));

  el("stats-recent-body").innerHTML = (stats.recent || []).map((run) => `
    <tr>
      <td>${formatWhen(run.at)}</td>
      <td><code>${escapeHtml(run.pseudonym)}</code></td>
      <td>${escapeHtml(modeName(run.mode))}</td>
      <td>${escapeHtml(run.mode === "files" ? presetName(run.preset) : "\u2014")}</td>
      <td class="num">${escapeHtml(number(run.tracks))}</td>
      <td class="num">${escapeHtml(number(run.failed))}</td>
      <td class="num">${escapeHtml(number(run.seconds))}</td>
      <td>${escapeHtml(run.version)}</td>
    </tr>`).join("");
}

function setStatsStatus(key, isError) {
  const status = el("stats-status");
  status.hidden = !key;
  el("stats-body").hidden = Boolean(key);
  if (!key) return;
  status.dataset.i18n = key;
  status.textContent = t(key);
  status.classList.toggle("error", Boolean(isError));
}

async function loadStats() {
  setStatsStatus("admin.loading", false);
  try {
    const res = await fetch("/api/admin/usage", { credentials: "same-origin" });
    if (res.status === 403) return setStatsStatus("admin.forbidden", true);
    if (!res.ok) return setStatsStatus("stats.loadError", true);
    const stats = await res.json();
    if (!stats.totals || !Number(stats.totals.runsAll)) {
      renderStats(stats);
      return setStatsStatus("stats.empty", false);
    }
    renderStats(stats);
    setStatsStatus(null, false);
  } catch (e) {
    setStatsStatus("stats.loadError", true);
  }
}

el("admin-refresh").addEventListener("click", () => {
  loadStats();
  load();
});

initLanguage();
loadStats();
load();

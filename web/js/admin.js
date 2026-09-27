"use strict";
/*
 * admin.js -- lists genre corrections on admin.html.
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

function trackCell(entry) {
    const artist = entry.artist || "";
    const title = entry.title || "";
    const line1 = [artist, title].filter(Boolean).join(" \u2014 ") || escapeHtml(entry.file || "");
    const file = entry.file && line1 !== entry.file
      ? `<div class="hint">${escapeHtml(entry.file)}</div>` : "";
    return `${escapeHtml(line1)}${file}`;
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
                                                </tr>
                                                  `).join("");
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

el("admin-refresh").addEventListener("click", load);

initLanguage();
load();

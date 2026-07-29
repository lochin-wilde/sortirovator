"use strict";
/*
 * invite.js -- invite gate for the closed testing period.
 *
 * THIS IS NOT ACCESS CONTROL. Everything here runs in the user's browser, so
 * the codes are in the page source and the gate is bypassed by anyone who opens
 * the console. It exists to keep the test group deliberate -- people arrive
 * with a code rather than stumbling in -- and to have the flow, the UI and the
 * storage in place so that attaching a server later is one function.
 *
 * The real gate is functions/_middleware.js, which runs on Cloudflare Pages
 * before any file is served and answers an unauthenticated request with a login
 * page instead of the app. That one holds, because it decides what leaves the
 * server; this one only decides what an already-delivered page chooses to show.
 * Deployed behind that middleware, this file is convenience only -- keep it for
 * `python3 -m http.server` during development, and do not mistake it for
 * protection. Until the site is deployed there, treat the app as public.
 *
 * Codes are stored as hashes rather than plaintext. That is not security either
 * -- a hash of a short code is brute-forced instantly -- but it stops a code
 * being read straight out of the page by someone glancing at it.
 */

const INVITE_STORAGE_KEY = "sortirovator.invite";

/*
 * FNV-1a. Chosen because it is four lines and needs no crypto API; the security
 * value is zero either way, so a real hash would only imply a strength that is
 * not there.
 */
function inviteHash(text) {
  let h = 0x811c9dc5;
  const normalized = String(text || "").trim().toUpperCase();
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/*
 * Codes for local development only.
 *
 * Stored as hashes, not because that protects anything -- a short code falls to
 * a wordlist instantly and this file is public anyway -- but so a code is not
 * readable by someone glancing over a shoulder at the source.
 *
 * The owner's code is deliberately NOT here. On the deployed site it lives in
 * the Cloudflare environment, where the middleware checks it before serving any
 * file; writing it into this file would publish it to anyone who opens the page,
 * and a code that everyone has is not an individual code. These four are
 * throwaways for `python3 -m http.server`.
 */
const INVITE_HASHES = new Set([
  inviteHash("SORTIR-2026"),
  inviteHash("DJ-TEST-01"),
  inviteHash("DJ-TEST-02"),
  inviteHash("DJ-TEST-03"),
]);

/*
 * Server hand-off point, mirroring submitFeedback() in feedback.js.
 *
 * Replacing the body with a fetch() that asks a server to validate the code is
 * the entire integration -- but note that the caller must also refuse to
 * continue when the request fails, which the local version cannot meaningfully
 * do.
 */
function verifyInvite(code) {
  return Promise.resolve({ ok: INVITE_HASHES.has(inviteHash(code)), local: true });
}

function storedInvite() {
  try {
    return localStorage.getItem(INVITE_STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

function rememberInvite(code) {
  try {
    localStorage.setItem(INVITE_STORAGE_KEY, String(code).trim().toUpperCase());
  } catch (e) { /* private browsing: the gate reappears next visit */ }
}

function forgetInvite() {
  try {
    localStorage.removeItem(INVITE_STORAGE_KEY);
  } catch (e) { /* ignore */ }
}

async function hasValidInvite() {
  const saved = storedInvite();
  if (!saved) return false;
  const result = await verifyInvite(saved);
  return result.ok;
}

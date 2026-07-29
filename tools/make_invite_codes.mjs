/*
 * Generates invite codes and the INVITE_CODES value to paste into Cloudflare.
 *
 * Codes are random rather than memorable on purpose. The gate answers every
 * guess instantly and for free, so a code's only defence is being too long to
 * find: "SORTIR-2026" falls to a wordlist, 20 hex characters does not.
 *
 *   node tools/make_invite_codes.mjs "Ваня" "Марина" "клуб Осень"
 */
import { randomBytes } from "node:crypto";

const owners = process.argv.slice(2);
if (owners.length === 0) {
  console.error("Укажите, кому предназначены коды: node tools/make_invite_codes.mjs Ваня Марина");
  process.exit(1);
}

const group = () => randomBytes(2).toString("hex").toUpperCase();
const codes = {};
console.log("Выдать людям:\n");
for (const owner of owners) {
  const code = `DJ-${group()}-${group()}-${group()}-${group()}`;
  codes[code] = owner.replace(/[^\wЀ-ӿ-]/g, "_");
  console.log(`  ${owner.padEnd(16)} ${code}`);
}
console.log("\nЗначение INVITE_CODES для Cloudflare (Settings -> Environment variables, Encrypt):\n");
console.log("  " + JSON.stringify(codes));
console.log("\nИ отдельно SESSION_SECRET:\n");
console.log("  " + randomBytes(32).toString("base64"));

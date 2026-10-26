/*
 * Checks the key report's arithmetic. Every decision about the key detector
 * will be taken on these numbers, so a slip in the McNemar test or the
 * held-out split would quietly turn noise into a "result".
 *
 *   node tools/test/test_key_report.mjs
 */
import {
  relation, halfOf, summarize, mcnemar, camelotFromKeyName, wheelStep, confusionMatrix, WHEEL,
} from "../measure/key_report.mjs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

/* ---------- Relations on the wheel ---------- */

check("8A и 8A — точно", relation("8A", "8A") === "exact");
check("8B при истине 8A — параллельная", relation("8B", "8A") === "relative");
check("7A при истине 8A — сосед", relation("7A", "8A") === "neighbour");
check("1A при истине 12A — сосед через конец круга", relation("1A", "12A") === "neighbour");
check("9B при истине 8A — ошибка", relation("9B", "8A") === "wrong");
check("нет ответа — failed", relation(null, "8A") === "failed");
check("нет истины — не считается", relation("8A", "") === "unlabelled");

/* ---------- Key names from annotated sets ---------- */

check("A minor -> 8A", camelotFromKeyName("A minor") === "8A");
check("C major -> 8B", camelotFromKeyName("C major") === "8B");
check("Eb minor -> 2A", camelotFromKeyName("Eb minor") === "2A");
check("D# minor совпадает с Eb minor", camelotFromKeyName("D# minor") === "2A");
check("Gb major -> 2B, F# major тоже", camelotFromKeyName("Gb major") === "2B" && camelotFromKeyName("F# major") === "2B");
check("Cb minor заворачивается к B minor -> 10A", camelotFromKeyName("Cb minor") === "10A");
check("лишние пробелы и перевод строки не мешают", camelotFromKeyName("  F minor\n") === "4A");
check("мусор -> null", camelotFromKeyName("H minor") === null && camelotFromKeyName("") === null);
{
  // Every one of the 24 names lands on a distinct Camelot code.
  const names = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const codes = new Set(names.flatMap((n) => [camelotFromKeyName(n + " major"), camelotFromKeyName(n + " minor")]));
  check(`24 названия -> 24 разных кода (${codes.size})`, codes.size === 24 && WHEEL.every((k) => codes.has(k)));
}

/* ---------- Steps round the wheel ---------- */

check("8A -> 7A: шаг -1, лад тот же", JSON.stringify(wheelStep("7A", "8A")) === '{"step":-1,"flip":false}');
check("12A -> 1A: шаг +1 через конец круга", wheelStep("1A", "12A").step === 1);
check("8A -> 8B: шаг 0, лад перевернулся", wheelStep("8B", "8A").step === 0 && wheelStep("8B", "8A").flip);
check("противоположная сторона круга — +6", wheelStep("2A", "8A").step === 6);
check("нет ответа — нет шага", wheelStep(null, "8A") === null);

/* ---------- Held-out halves ---------- */

const names = Array.from({ length: 2000 }, (_, i) => `/Volumes/Music/Folder ${i % 37}/Track ${i}.mp3`);
const train = names.filter((n) => halfOf(n) === "train").length;
check(`половины примерно поровну (${train} из 2000)`, train > 900 && train < 1100);
check("половина зависит только от имени", halfOf(names[5]) === halfOf(String(names[5])));
check("известное имя всегда в одной и той же половине", halfOf("a") === halfOf("a") && ["train", "test"].includes(halfOf("a")));

/* ---------- Summary ---------- */

const rows = [
  { name: "1", truth: "8A", ours: "8A" },
  { name: "2", truth: "8A", ours: "7A" },
  { name: "3", truth: "8A", ours: "8B" },
  { name: "4", truth: "8B", ours: "8A" },
  { name: "5", truth: "8B", ours: "8B" },
  { name: "6", truth: "3A", ours: null },
  { name: "7", truth: null, ours: "8A" },
];
const s = summarize(rows);
check("неразмеченный трек не входит в n", s.n === 6);
check("точно: 2 из 6", Math.abs(s.exact - 2 / 6) < 1e-9);
check("совместимо: 5 из 6", Math.abs(s.compatible - 5 / 6) < 1e-9);
check("минор: 4 трека, точно 1", s.byMode.minor.n === 4 && Math.abs(s.byMode.minor.exact - 0.25) < 1e-9);
check("мажор: 2 трека, лад перепутан в одном", s.byMode.major.n === 2 && Math.abs(s.byMode.major.modeWrong - 0.5) < 1e-9);
check("отказ ответить не считается ошибкой лада", Math.abs(s.byMode.minor.modeWrong - 0.25) < 1e-9);
check("пары ошибок посчитаны", s.pairs.some((p) => p.pair === "8A -> 7A" && p.relation === "neighbour" && p.n === 1));
check("отсутствие ответа видно в парах", s.pairs.some((p) => p.pair === "3A -> none"));
check("шаги: минор, тот же лад, -1 — один трек", s.byStep.minor.same[-1] === 1);
check("шаги: мажор, перевёрнутый лад, 0 — один трек", s.byStep.major.flip[0] === 1);
{
  const m = confusionMatrix(rows);
  check("матрица: 8A -> 8B записан в строку 8A", m["8A"]["8B"] === 1 && m["8B"]["8A"] === 1);
  check("матрица: отказ попадает в столбец none", m["3A"].none === 1);
  const total = WHEEL.reduce((acc, t) => acc + Object.values(m[t]).reduce((a, b) => a + b, 0), 0);
  check(`матрица: всего столько, сколько размеченных треков (${total})`, total === 6);
}

/* ---------- McNemar ---------- */

const base = Array.from({ length: 40 }, (_, i) => ({ name: "t" + i, truth: "8A", ours: i < 20 ? "8A" : "7A" }));
{
  const after = base.map((r, i) => ({ ...r, ours: i < 30 ? "8A" : "7A" }));
  const t = mcnemar(base, after);
  check("10 исправлено, 0 испорчено", t.better === 10 && t.worse === 0);
  check(`p для 10:0 ≈ 0.002 (${t.p.toFixed(4)})`, Math.abs(t.p - 0.001953125) < 1e-6);
  check("z положительный при улучшении", t.z > 0);
}
{
  const after = base.map((r, i) => ({ ...r, ours: i < 10 ? "7A" : i < 20 ? "8A" : i < 30 ? "8A" : "7A" }));
  const t = mcnemar(base, after);
  check("10 за, 10 против — p = 1", t.better === 10 && t.worse === 10 && Math.abs(t.p - 1) < 1e-9);
}
{
  const big = Array.from({ length: 400 }, (_, i) => ({ name: "b" + i, truth: "8A", ours: i < 200 ? "8A" : "7A" }));
  const after = big.map((r, i) => ({ ...r, ours: i < 260 ? "8A" : "7A" }));
  const t = mcnemar(big, after);
  check(`60:0 через хи-квадрат — p очень мал (${t.p.toExponential(1)})`, t.p < 1e-10 && t.better === 60);
}
{
  // A "win" by refusing: wrong answers turned into no answer change nothing
  // in exact, but must be reported.
  const after = base.map((r, i) => ({ ...r, ours: i < 20 ? "8A" : null }));
  const t = mcnemar(base, after);
  check("отказ отвечать виден отдельно", t.newlyNone === 20 && t.better === 0 && t.worse === 0);
}
{
  const t = mcnemar(base, base.slice(0, 10));
  check("сравниваются только общие треки", t.n === 10);
}

/* ---------- report ---------- */

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

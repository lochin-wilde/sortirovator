/*
 * Checks the key network port in web/js/keycnn.js.
 *
 * The port was verified once against madmom itself: on madmom's two test
 * files (tests/data/audio/sample.wav and sample2.wav) its 24 probabilities
 * matched madmom's stored reference activations to within 3e-7, and the keys
 * agreed (Ab major, A minor). Those files are madmom's, not ours, so they are
 * not in this repository; the golden output below was recorded from the
 * verified port on a synthetic signal, and pins it from now on. The other
 * checks test the parts where a port most easily goes wrong: the kernel flip,
 * pooling of odd sizes, and the order of madmom's classes.
 *
 *   node tools/test/test_key_cnn.mjs
 */
import { readFileSync } from "node:fs";

const results = [];
const check = (label, cond) => results.push(`  ${cond ? "OK  " : "МИМО"} ${label}`);

const api = new Function(readFileSync("web/js/dsp.js", "utf8") + readFileSync("web/js/keycnn.js", "utf8")
  + `return { parseKeyCnnModel, detectKeyCnn, keyCnnForward, keyCnnFilterbank, keyCnnSpectrogram,
     keyCnnConv, keyCnnMaxPool, keyCnnPad, keyCnnClassToCamelot, KEY_CNN_HOP };`)();

const file = readFileSync("web/data/key_cnn.bin");
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const model = api.parseKeyCnnModel(buffer);

/* ---------- Model file ---------- */

check(`в модели 30 слоёв (${model.length})`, model.length === 30);
check("первый слой — дополнение, последний — среднее", model[0].type === "pad" && model[model.length - 1].type === "mean");
{
  const convs = model.filter((l) => l.type === "conv");
  const params = convs.reduce((acc, l) => acc + l.w.length, 0)
    + model.filter((l) => l.type === "bn_elu").reduce((acc, l) => acc + 2 * l.scale.length, 0);
  check(`9 свёрток, выход на 24 класса (${convs.length}, ${convs[convs.length - 1].cout})`,
    convs.length === 9 && convs[convs.length - 1].cout === 24);
  check(`число параметров совпадает с файлом (${params})`, params === 665064);
}
{
  let threw = false;
  try { api.parseKeyCnnModel(new ArrayBuffer(16)); } catch { threw = true; }
  check("чужой файл не принимается за модель", threw);
}

/* ---------- Class order ---------- */

check("класс 0 — A major -> 11B", api.keyCnnClassToCamelot(0) === "11B");
check("класс 3 — C major -> 8B", api.keyCnnClassToCamelot(3) === "8B");
check("класс 11 — Ab major -> 4B", api.keyCnnClassToCamelot(11) === "4B");
check("класс 12 — A minor -> 8A", api.keyCnnClassToCamelot(12) === "8A");
check("класс 23 — G# minor -> 1A", api.keyCnnClassToCamelot(23) === "1A");
{
  const all = new Set(Array.from({ length: 24 }, (_, k) => api.keyCnnClassToCamelot(k)));
  check(`24 класса -> 24 разных кода (${all.size})`, all.size === 24);
}

/* ---------- Layers ---------- */

{
  // madmom convolves, it does not correlate: a kernel [[1, 2]] over [[1, 0]]
  // gives 2 (flipped), not 1.
  const layer = api.parseKeyCnnModel(buffer)[1]; // shape only; replaced below
  const conv = { type: "conv", cin: 1, cout: 1, kh: 1, kw: 2, w: Float32Array.from([2, 1]) };
  // w is already in the flipped layout parseKeyCnnModel produces: [j=0] = k[1].
  const x = { t: 1, f: 2, c: 1, data: Float32Array.from([1, 0]) };
  const out = api.keyCnnConv(x, conv);
  check(`свёртка: размер valid (${out.t}x${out.f})`, out.t === 1 && out.f === 1 && layer.type === "conv");
  check(`свёртка с переворотом ядра (${out.data[0]})`, out.data[0] === 2);
}
{
  // parseKeyCnnModel must do the flip: build a one-weight-row model by hand.
  const header = JSON.stringify({ floats: 2, layers: [{ type: "conv", in: 1, out: 1, kh: 1, kw: 2, weights: 0 }] });
  const pad = (4 - ((8 + header.length) % 4)) % 4;
  const bytes = new Uint8Array(8 + header.length + pad + 8);
  bytes.set([75, 67, 78, 49]);
  new DataView(bytes.buffer).setUint32(4, header.length + pad, true);
  bytes.set(new TextEncoder().encode(header + " ".repeat(pad)), 8);
  new Float32Array(bytes.buffer, 8 + header.length + pad, 2).set([1, 2]); // kernel [[1, 2]]
  const [conv] = api.parseKeyCnnModel(bytes.buffer);
  const out = api.keyCnnConv({ t: 1, f: 2, c: 1, data: Float32Array.from([1, 0]) }, conv);
  check(`загрузка переворачивает ядро [[1, 2]] -> на [1, 0] даёт 2 (${out.data[0]})`, out.data[0] === 2);
}
{
  const x = { t: 5, f: 3, c: 1, data: Float32Array.from({ length: 15 }, (_, i) => i) };
  const out = api.keyCnnMaxPool(x);
  check(`пулинг 5x3 -> 2x1, нечётный хвост отбрасывается (${out.t}x${out.f})`, out.t === 2 && out.f === 1);
  check(`пулинг берёт максимум окна 2x2 (${Array.from(out.data)})`, out.data[0] === 4 && out.data[1] === 10);
}
{
  const x = { t: 1, f: 1, c: 2, data: Float32Array.from([3, 4]) };
  const out = api.keyCnnPad(x, 1);
  check("дополнение нулями по времени и частоте", out.t === 3 && out.f === 3
    && out.data[(1 * 3 + 1) * 2] === 3 && out.data[(1 * 3 + 1) * 2 + 1] === 4 && out.data[0] === 0);
}

/* ---------- Spectrogram ---------- */

{
  const fb = api.keyCnnFilterbank();
  check(`105 полос, 24 на октаву от 65 до 2100 Гц (${fb.length})`, fb.length === 105);
  check("каждый фильтр нормирован к сумме 1", fb.every((f) => Math.abs(f.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9));
  const spec = api.keyCnnSpectrogram(new Float32Array(44100 * 3));
  check(`кадров столько же, сколько у madmom: ceil(N / 8820) (${spec.frames})`, spec.frames === Math.ceil((44100 * 3) / api.KEY_CNN_HOP));
  check("тишина -> log10(1 + 0) = 0", spec.data.every((v) => v === 0));
}

/* ---------- Golden output ---------- */

{
  // Eight seconds of A2, A3, C4, E4, A4 with five harmonics each, 44.1 kHz.
  const sr = 44100;
  const y = new Float32Array(sr * 8);
  for (const midi of [45, 57, 60, 64, 69]) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    for (let h = 1; h <= 5; h++) {
      for (let i = 0; i < y.length; i++) y[i] += (0.1 * Math.sin((2 * Math.PI * f * h * i) / sr)) / h;
    }
  }
  const golden = [0.267174, 0.007743, 0.014955, 0.07245, 0.036626, 0.017401, 0.007664, 0.078367,
    0.040377, 0.006441, 0.044289, 0.01902, 0.180488, 0.010241, 0.050095, 0.004919, 0.028741,
    0.010388, 0.018371, 0.034032, 0.011878, 0.015522, 0.017149, 0.005669];
  const r = api.detectKeyCnn(y, model);
  const diff = Math.max(...golden.map((v, i) => Math.abs(v - r.probs[i])));
  check(`24 вероятности совпадают с записанными (расхождение ${diff.toExponential(1)})`, diff < 2e-6);
  check(`сумма вероятностей 1 (${r.probs.reduce((a, b) => a + b, 0).toFixed(6)})`, Math.abs(r.probs.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  check(`запасной ответ — второй по вероятности (${r.key}, затем ${r.second})`, r.key === "11B" && r.second === "8A");
  check("слишком короткий звук — нет ответа, а не выдумка", api.detectKeyCnn(new Float32Array(100), model).key === null);
}

/* ---------- report ---------- */

/* ---------- Convolution, several outputs per pass ---------- */
{
  // One output at a time, as the port first did it: the reference the faster
  // keyCnnConv must match bit for bit. Widths 9 and 7 leave a tail of one and
  // three outputs after the blocks of four.
  const naive = (x, { cin, cout, kh, kw, w }) => {
    const t = x.t - kh + 1, f = x.f - kw + 1, out = new Float32Array(t * f * cout), acc = new Float32Array(cout);
    for (let ti = 0; ti < t; ti++) for (let fi = 0; fi < f; fi++) {
      acc.fill(0);
      for (let i = 0; i < kh; i++) for (let j = 0; j < kw; j++) for (let c = 0; c < cin; c++) {
        const v = x.data[((ti + i) * x.f + fi + j) * cin + c];
        for (let o = 0; o < cout; o++) acc[o] += v * w[((i * kw + j) * cin + c) * cout + o];
      }
      out.set(acc, (ti * f + fi) * cout);
    }
    return out;
  };
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (const [t, f, cin, cout] of [[6, 11, 3, 5], [5, 9, 2, 4]]) {
    const layer = { cin, cout, kh: 3, kw: 3, w: Float32Array.from({ length: 9 * cin * cout }, rnd) };
    const x = { t, f, c: cin, data: Float32Array.from({ length: t * f * cin }, (_, k) => (k % 7 === 0 ? 0 : rnd())) };
    const got = api.keyCnnConv(x, layer).data, want = naive(x, layer);
    check(`свёртка блоками по четыре совпадает с поэлементной до бита (ширина выхода ${f - 2})`,
      got.length === want.length && got.every((v, k) => Object.is(v, want[k])));
  }
}

const failed = results.filter((line) => line.includes("МИМО"));
console.log(results.join("\n"));
console.log(`\nпройдено ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

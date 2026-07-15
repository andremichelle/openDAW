import fs from 'fs';
const path = process.argv[2];
const buf = fs.readFileSync(path);
const { instance } = await WebAssembly.instantiate(buf, {});
const { bench, reset_arena } = instance.exports;
function run(blocks, res) {
  reset_arena();
  bench(64, res); // warmup
  reset_arena();
  const t0 = process.hrtime.bigint();
  const r = bench(blocks, res);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const audio = blocks * 128 / 48000;
  const pct = ms / 1000 / audio * 100;
  console.log(`  resample ${(res/1000).toFixed(3)}: ${ms.toFixed(0)}ms / ${audio.toFixed(1)}s -> ${(audio/(ms/1000)).toFixed(1)}x realtime = ${pct.toFixed(1)}% of one core`);
}
console.log(process.argv[3] || '');
run(3750, 1000);  // native rate
run(3750, 919);   // 44.1k -> 48k (the drum case)

import fs from 'fs';
const buf = fs.readFileSync(process.argv[2]);
const { instance } = await WebAssembly.instantiate(buf, {});
const { setup, step, reset } = instance.exports;
const BLOCKS = 4000, budget = 128/48000*1000;
setup(BLOCKS, 919);
for (let i=0;i<200;i++) step();
// simulate a loop wrap every ~375 blocks (~1s). Measure the block right AFTER each reset.
let normalPk=0, resetPk=0;
for (let i=0;i<BLOCKS;i++){
  if (i % 375 === 0) reset();
  const a=process.hrtime.bigint(); step(); const dt=Number(process.hrtime.bigint()-a)/1e6;
  if (i % 375 === 0) resetPk=Math.max(resetPk,dt); else normalPk=Math.max(normalPk,dt);
}
console.log(`normal block PEAK ${(normalPk/budget*100).toFixed(1)}%   RESET(loop-wrap) block PEAK ${(resetPk/budget*100).toFixed(1)}% of the 2.67ms budget`);

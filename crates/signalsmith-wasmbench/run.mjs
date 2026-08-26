import fs from 'fs';
const buf = fs.readFileSync(process.argv[2]);
const { instance } = await WebAssembly.instantiate(buf, {});
const { setup, step } = instance.exports;
const BLOCKS = 4000, budget = 128/48000*1000; // 2.667ms callback budget
for (const res of [1000, 919]) {
  setup(BLOCKS, res);
  for (let i=0;i<200;i++) step(); // warm
  const t = new Float64Array(BLOCKS);
  for (let i=0;i<BLOCKS;i++){ const a=process.hrtime.bigint(); step(); t[i]=Number(process.hrtime.bigint()-a)/1e6; }
  const s=[...t].sort((a,b)=>a-b);
  const mean=t.reduce((a,b)=>a+b,0)/BLOCKS;
  const pk=s[BLOCKS-1], p99=s[Math.floor(BLOCKS*0.99)], p50=s[Math.floor(BLOCKS*0.5)];
  const heavy = t.filter(x=>x>budget*0.2).length;
  console.log(`resample ${(res/1000).toFixed(3)}: mean ${(mean/budget*100).toFixed(1)}%  median ${(p50/budget*100).toFixed(1)}%  p99 ${(p99/budget*100).toFixed(1)}%  PEAK ${(pk/budget*100).toFixed(1)}%  (${heavy} of ${BLOCKS} blocks >20% budget)`);
}

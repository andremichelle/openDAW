import {readFileSync, writeFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {TimelineBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {decodeBundle} from "../src/bundle"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"
const load=async(bypassFx:boolean)=>{const buf=readFileSync("/tmp/ambition.odb");const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength) as ArrayBuffer
  const b=await decodeBundle(ab);const tl=b.boxGraph.boxes().find((x:any)=>x instanceof TimelineBox) as any
  b.boxGraph.beginTransaction();if(tl)tl.loopArea.enabled.setValue(false)
  const vapoUnits=new Set<string>();for(const x of b.boxGraph.boxes()){if(x instanceof VaporisateurDeviceBox){const a=(x as any).host?.targetAddress?.unwrapOrNull?.();if(a)vapoUnits.add(UUID.toString(a.uuid))}}
  for(const box of b.boxGraph.boxes()){const u=UUID.toString(box.address.uuid)
    if(box.name==="AudioUnitBox"&&!vapoUnits.has(u))(box as any).mute.setValue(true)
    if(bypassFx){const ha=(box as any).host?.targetAddress?.unwrapOrNull?.();if(ha&&vapoUnits.has(UUID.toString(ha.uuid))&&Array.from(ha.fieldKeys).join(",")==="23")(box as any).enabled.setValue(false)}}
  b.boxGraph.endTransaction();return b}
const wbuf=async(bg:BoxGraph,samples:any,quanta:number):Promise<Float32Array>=>{const {engine,memory}=await loadFullEngine() as any
  const sync=connectSyncToEngine(engine,memory,bg);await sync.settle();engine.bind();await sync.settle()
  for(;;){const rp=engine.input_reserve(16);const h=engine.sample_take_request(rp);if(h<0)break
    const uuid=UUID.toString(new Uint8Array(memory.buffer.slice(rp,rp+16)) as any);const s=samples.find((x:any)=>UUID.toString(x.uuid)===uuid)
    if(!s){engine.sample_allocate(h,4);engine.sample_set_ready(h,1,1,48000);continue}
    const a=WavFile.decodeFloats(s.wav);const p=engine.sample_allocate(h,a.numberOfFrames*a.numberOfChannels*4)
    for(let c=0;c<a.numberOfChannels;c++)new Float32Array(memory.buffer,p+c*a.numberOfFrames*4,a.numberOfFrames).set(a.frames[c])
    engine.sample_set_ready(h,a.numberOfFrames,a.numberOfChannels,a.sampleRate)}
  await sync.settle();engine.set_metronome_enabled(0);const len=engine.output_len()>>>0;engine.stop();engine.play();const out=new Float32Array(quanta*len)
  for(let q=0;q<quanta;q++){engine.render();out.set(new Float32Array(memory.buffer,engine.output_ptr(),len),q*len)}
  return out}
const chars=async(bypassFx:boolean)=>{const Q=Math.ceil(40*48000/128);const b=await load(bypassFx)
  const w=await wbuf(b.boxGraph,b.samples,Q);const ts=(await renderTs(ProjectSkeleton.encode(b.boxGraph) as ArrayBuffer,buildSampleMap(b.samples),Q)).buffer
  const n=Math.min(w.length,ts.length)
  // analyze window after synth onset: quantum 12000..(end). planar per quantum 256.
  const startQ=13000;let firstDiffQ=-1,dpk=0,dsum=0,wsum=0,c=0
  for(let q=startQ;q<n/256|0;q++){for(let i=q*256;i<q*256+256;i++){const d=Math.abs(w[i]-ts[i]);if(firstDiffQ<0&&d>1e-7)firstDiffQ=q;if(d>dpk)dpk=d;dsum+=d*d;wsum+=w[i]*w[i];c++}}
  const wr=Math.sqrt(wsum/c),dr=Math.sqrt(dsum/c)
  // ratio at first few diverging samples after onset
  const base=(firstDiffQ<0?startQ:firstDiffQ)*256;const pts:string[]=[]
  for(const off of [0,10,50,200,1000,10000]){const i=base+off;if(i<n)pts.push(`+${off}: w=${w[i].toFixed(5)} ts=${ts[i].toFixed(5)} d=${(w[i]-ts[i]).toFixed(6)}`)}
  return [`bypassFx=${bypassFx}: firstDiffQ=${firstDiffQ} (~${firstDiffQ<0?'-':(firstDiffQ*128/48000).toFixed(1)+'s'}) residual=${(20*Math.log10(dr/wr)).toFixed(1)}dB peakDiff=${dpk.toFixed(5)}`,...pts]}
describe("vapo raw",()=>{it("chars",async()=>{
  const withFx=await chars(false);const noFx=await chars(true)
  writeFileSync("/tmp/vapo-raw.txt",[...withFx,"---",...noFx].join("\n")+"\n");expect(1).toBe(1)
},300000)})

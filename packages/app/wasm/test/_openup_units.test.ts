import {readFileSync, writeFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, SpielwerkDeviceBox, WerkstattDeviceBox, TimelineBox} from "@opendaw/studio-boxes"
import {decodeBundle} from "../src/bundle"
import {simplifySoundfontBytes} from "../src/soundfont-fetch"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"
const reg=(bg:any)=>{const H:any={ApparatDeviceBox:["apparat","apparatProcessors"],WerkstattDeviceBox:["werkstatt","werkstattProcessors"],SpielwerkDeviceBox:["spielwerk","spielwerkProcessors"]}
 for(const box of bg.boxes()){const h=box instanceof ApparatDeviceBox?H.ApparatDeviceBox:box instanceof WerkstattDeviceBox?H.WerkstattDeviceBox:box instanceof SpielwerkDeviceBox?H.SpielwerkDeviceBox:undefined;if(!h)continue
  const code=box.code.getValue();const m=code.match(new RegExp("^// @"+h[0]+" (\\w+) (\\d+) (\\d+)\\n"));if(m===null)continue
  new Function(ScriptCompiler.wrap({headerTag:h[0],registryName:h[1],functionName:h[0]},UUID.toString(box.address.uuid),parseInt(m[3]),code.slice(m[0].length)))()}}
const load=async()=>{const buf=readFileSync("/tmp/openup.odb");const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength) as ArrayBuffer
  const b=await decodeBundle(ab);const tl=b.boxGraph.boxes().find((x:any)=>x instanceof TimelineBox) as any
  b.boxGraph.beginTransaction();if(tl)tl.loopArea.enabled.setValue(false);b.boxGraph.endTransaction();reg(b.boxGraph);return b}
const names=(bg:BoxGraph):Map<string,string>=>{const m=new Map<string,string>();for(const x of bg.boxes()){const a=(x as any).host?.targetAddress?.unwrapOrNull?.();if(a&&Array.from(a.fieldKeys).join(",")==="22")m.set(UUID.toString(a.uuid),x.name)}return m}
const solo=(bg:BoxGraph,keep:string,nm:Map<string,string>)=>{bg.beginTransaction();for(const box of bg.boxes()){if(box.name!=="AudioUnitBox")continue;const u=UUID.toString(box.address.uuid);if(nm.has(u)&&u!==keep)(box as any).mute.setValue(true)}bg.endTransaction()}
const sfBlobs=new Map<string,ArrayBuffer>()
const wasmBuf=async(bg:BoxGraph,samples:any,soundfonts:any,quanta:number):Promise<Float32Array>=>{const {engine,memory}=await loadFullEngine() as any
  const sync=connectSyncToEngine(engine,memory,bg);await sync.settle();engine.bind();await sync.settle()
  for(;;){const rp=engine.input_reserve(16);const h=engine.sample_take_request(rp);if(h<0)break
    const uuid=UUID.toString(new Uint8Array(memory.buffer.slice(rp,rp+16)) as any);const s=samples.find((x:any)=>UUID.toString(x.uuid)===uuid)
    if(!s){engine.sample_allocate(h,4);engine.sample_set_ready(h,1,1,48000);continue}
    const a=WavFile.decodeFloats(s.wav);const p=engine.sample_allocate(h,a.numberOfFrames*a.numberOfChannels*4)
    for(let c=0;c<a.numberOfChannels;c++)new Float32Array(memory.buffer,p+c*a.numberOfFrames*4,a.numberOfFrames).set(a.frames[c])
    engine.sample_set_ready(h,a.numberOfFrames,a.numberOfChannels,a.sampleRate)}
  for(;;){const rp=engine.input_reserve(16);const h=engine.soundfont_take_request(rp);if(h<0)break
    const uuid=UUID.toString(new Uint8Array(memory.buffer.slice(rp,rp+16)) as any);const blob=new Uint8Array(sfBlobs.get(uuid)!)
    const p=engine.soundfont_allocate(h,blob.byteLength);new Uint8Array(memory.buffer,p,blob.byteLength).set(blob);engine.soundfont_set_ready(h)}
  await sync.settle();engine.set_metronome_enabled(0);const len=engine.output_len()>>>0;engine.stop();engine.play();const out=new Float32Array(quanta*len)
  for(let q=0;q<quanta;q++){engine.render();out.set(new Float32Array(memory.buffer,engine.output_ptr(),len),q*len)}
  return out}
const metrics=(w:Float32Array,ts:Float32Array)=>{const n=Math.min(w.length,ts.length);let ds=0,ws=0,tss=0,dp=0
  for(let i=0;i<n;i++){const d=w[i]-ts[i];if(Math.abs(d)>dp)dp=Math.abs(d);ds+=d*d;ws+=w[i]*w[i];tss+=ts[i]*ts[i]}
  const wr=Math.sqrt(ws/n),tr=Math.sqrt(tss/n),dr=Math.sqrt(ds/n)
  return {wr,tr,levelDb:tr>1e-9?20*Math.log10(wr/tr):NaN,resid:wr>1e-9?20*Math.log10(dr/wr):NaN,dp}}
describe("openup units",()=>{it("per-unit",async()=>{
  const Q=Math.ceil(12*48000/128)
  const probe=await load()
  for(const s of (probe.soundfonts??[]))sfBlobs.set(UUID.toString(s.uuid),await simplifySoundfontBytes(s.sf2))
  const nm=names(probe.boxGraph);const units=[...nm.keys()]
  const lines:string[]=[]
  for(const keep of units){
    const b=await load();solo(b.boxGraph,keep,nm)
    const w=await wasmBuf(b.boxGraph,b.samples,b.soundfonts,Q)
    const ts=(await renderTs(ProjectSkeleton.encode(b.boxGraph) as ArrayBuffer,buildSampleMap(b.samples),Q,b.soundfonts)).buffer
    const m=metrics(w,ts)
    lines.push(`${keep.slice(0,8)} ${(nm.get(keep)||"").padEnd(22)} wRMS=${m.wr.toExponential(2)} level=${isNaN(m.levelDb)?"n/a":(m.levelDb>=0?"+":"")+m.levelDb.toFixed(2)+"dB"} resid=${isNaN(m.resid)?"n/a":m.resid.toFixed(1)+"dB"} peakD=${m.dp.toFixed(4)}`)
    writeFileSync("/tmp/openup-units.txt",lines.join("\n")+"\n")
  }
  // sort by worst residual (most divergent), n/a last
  lines.sort((a,b)=>{const ra=parseFloat((a.match(/resid=(-?\d+\.\d)/)||[])[1]??"999");const rb=parseFloat((b.match(/resid=(-?\d+\.\d)/)||[])[1]??"999");return rb-ra})
  writeFileSync("/tmp/openup-units.txt",lines.join("\n")+"\n");expect(1).toBe(1)
},600000)})

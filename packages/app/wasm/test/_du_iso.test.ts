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
const KEEP="a7ac2606"
const reg=(bg:any)=>{const H:any={ApparatDeviceBox:["apparat","apparatProcessors"],WerkstattDeviceBox:["werkstatt","werkstattProcessors"],SpielwerkDeviceBox:["spielwerk","spielwerkProcessors"]}
 for(const box of bg.boxes()){const h=box instanceof ApparatDeviceBox?H.ApparatDeviceBox:box instanceof WerkstattDeviceBox?H.WerkstattDeviceBox:box instanceof SpielwerkDeviceBox?H.SpielwerkDeviceBox:undefined;if(!h)continue
  const code=box.code.getValue();const m=code.match(new RegExp("^// @"+h[0]+" (\\w+) (\\d+) (\\d+)\\n"));if(m===null)continue
  new Function(ScriptCompiler.wrap({headerTag:h[0],registryName:h[1],functionName:h[0]},UUID.toString(box.address.uuid),parseInt(m[3]),code.slice(m[0].length)))()}}
const sfBlobs=new Map<string,ArrayBuffer>()
const load=async(disable:string[])=>{const buf=readFileSync("/tmp/openup.odb");const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength) as ArrayBuffer
  const b=await decodeBundle(ab);const tl=b.boxGraph.boxes().find((x:any)=>x instanceof TimelineBox) as any
  b.boxGraph.beginTransaction();if(tl)tl.loopArea.enabled.setValue(false)
  const instr=new Set<string>();for(const x of b.boxGraph.boxes()){const a=(x as any).host?.targetAddress?.unwrapOrNull?.();if(a&&Array.from(a.fieldKeys).join(",")==="22")instr.add(UUID.toString(a.uuid))}
  for(const box of b.boxGraph.boxes()){const u=UUID.toString(box.address.uuid)
    if(box.name==="AudioUnitBox"&&instr.has(u)&&!u.startsWith(KEEP))(box as any).mute.setValue(true)
    const ha=(box as any).host?.targetAddress?.unwrapOrNull?.();if(ha&&UUID.toString(ha.uuid).startsWith(KEEP)&&disable.includes(box.name))(box as any).enabled.setValue(false)}
  b.boxGraph.endTransaction();reg(b.boxGraph);return b}
const wbuf=async(bg:BoxGraph,samples:any,quanta:number):Promise<Float32Array>=>{const {engine,memory}=await loadFullEngine() as any
  const sync=connectSyncToEngine(engine,memory,bg);await sync.settle();engine.bind();await sync.settle()
  for(;;){const rp=engine.input_reserve(16);const h=engine.sample_take_request(rp);if(h<0)break
    const uuid=UUID.toString(new Uint8Array(memory.buffer.slice(rp,rp+16)) as any);const s=samples.find((x:any)=>UUID.toString(x.uuid)===uuid)
    if(!s){engine.sample_allocate(h,4);engine.sample_set_ready(h,1,1,48000);continue}
    const a=WavFile.decodeFloats(s.wav);const p=engine.sample_allocate(h,a.numberOfFrames*a.numberOfChannels*4)
    for(let c=0;c<a.numberOfChannels;c++)new Float32Array(memory.buffer,p+c*a.numberOfFrames*4,a.numberOfFrames).set(a.frames[c])
    engine.sample_set_ready(h,a.numberOfFrames,a.numberOfChannels,a.sampleRate)}
  for(;;){const rp=engine.input_reserve(16);const h=engine.soundfont_take_request(rp);if(h<0)break;const uuid=UUID.toString(new Uint8Array(memory.buffer.slice(rp,rp+16)) as any);const blob=new Uint8Array(sfBlobs.get(uuid)!);const p=engine.soundfont_allocate(h,blob.byteLength);new Uint8Array(memory.buffer,p,blob.byteLength).set(blob);engine.soundfont_set_ready(h)}
  await sync.settle();engine.set_metronome_enabled(0);const len=engine.output_len()>>>0;engine.stop();engine.play();const out=new Float32Array(quanta*len)
  for(let q=0;q<quanta;q++){engine.render();out.set(new Float32Array(memory.buffer,engine.output_ptr(),len),q*len)}
  return out}
const stat=async(name:string,disable:string[])=>{const Q=Math.ceil(12*48000/128);const b=await load(disable)
  if(sfBlobs.size===0)for(const s of (b.soundfonts??[]))sfBlobs.set(UUID.toString(s.uuid),await simplifySoundfontBytes(s.sf2))
  const w=await wbuf(b.boxGraph,b.samples,Q);const ts=(await renderTs(ProjectSkeleton.encode(b.boxGraph) as ArrayBuffer,buildSampleMap(b.samples),Q,b.soundfonts)).buffer
  const n=Math.min(w.length,ts.length);let ds=0,ws=0,ts2=0;for(let i=0;i<n;i++){const d=w[i]-ts[i];ds+=d*d;ws+=w[i]*w[i];ts2+=ts[i]*ts[i]}
  const wr=Math.sqrt(ws/n),tr=Math.sqrt(ts2/n),dr=Math.sqrt(ds/n)
  return `${name.padEnd(24)} wRMS=${wr.toExponential(2)} tsRMS=${tr.toExponential(2)} level=${(20*Math.log10(wr/tr)).toFixed(2)}dB resid=${(20*Math.log10(dr/wr)).toFixed(1)}dB`}
describe("du iso",()=>{it("x",async()=>{
  const out=[]
  out.push(await stat("all effects on",[]))
  out.push(await stat("reverb off",["DattorroReverbDeviceBox"]))
  out.push(await stat("crusher off",["CrusherDeviceBox"]))
  out.push(await stat("revamp off",["RevampDeviceBox"]))
  out.push(await stat("all effects off",["DattorroReverbDeviceBox","CrusherDeviceBox","RevampDeviceBox"]))
  writeFileSync("/tmp/du-iso.txt",out.join("\n")+"\n");expect(1).toBe(1)
},300000)})

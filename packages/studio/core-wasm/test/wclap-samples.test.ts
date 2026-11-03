// A WebCLAP plugin's sample slots (opendaw.samples/1) through the real engine: a WclapSampleBox under the device's
// samples hub points at an AudioFileBox, the engine loads it like any sample and delivers its handle to the device,
// the bridge copies the frames into the plugin once they are resident. Radar (open-webclap ports/radar, MIT,
// AGPL-3.0 as built) plays its slot 0 while the transport runs, so sound means the sample arrived.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, WclapDeviceBox, WclapSampleBox} from "@opendaw/studio-boxes"
import {WclapBundle, WclapStatus} from "@opendaw/studio-adapters"
import {buildEffectProject} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const RADAR = "com.andremichelle.radar"
const bundle: WclapBundle = {files: [{path: "module.wasm", bytes: new Uint8Array(readFileSync(path.resolve(__dirname, "assets", "radar.wasm")))}]}

describe("WebCLAP sample slots", () => {
    it("hands the sample of a slot to the plugin, which plays it", async () => {
        let device: WclapDeviceBox | null = null
        let slot: WclapSampleBox | null = null
        const graph = buildEffectProject(0.0, (source, unit) => {
            device = WclapDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.url.setValue("radar")
                box.clapId.setValue(RADAR)
            })
            const file = AudioFileBox.create(source, UUID.generate(), box => {
                box.endInSeconds.setValue(0.5)
                box.fileName.setValue("tone")
            })
            slot = WclapSampleBox.create(source, UUID.generate(), box => {
                box.owner.refer(device!.samples)
                box.index.setValue(0)
                box.file.refer(file)
            })
            return device
        }, "class Processor { process() {} }")
        const statuses: Array<WclapStatus> = []
        const states: Array<Uint8Array> = []
        const {engine, memory, drainSamples} = await loadFullEngine(48000, () => {}, () => null, {
            loadBundle: () => Promise.resolve(bundle),
            sendStatus: (_uuid, status) => statuses.push(status),
            sendState: (_uuid, bytes) => states.push(new Uint8Array(bytes))
        })
        const sync = connectSyncToEngine(engine, memory, graph)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const len = engine.output_len() >>> 0
        let peak = 0
        for (let attempt = 0; attempt < 200 && peak < 0.01; attempt++) {
            drainSamples()
            for (let quantum = 0; quantum < 16; quantum++) {
                engine.render()
                const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
                for (const value of output) {peak = Math.max(peak, Math.abs(value))}
            }
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        console.log("statuses", statuses.map(({state, message}) => `${state} ${message}`), "peak", peak, "states", states.map(s => s.length))
        expect(statuses.some(({state}) => state === "ready")).toBe(true)
        expect(peak).toBeGreaterThan(0.01)
        expect(slot).not.toBeNull()
    }, 30000)

    it("hands over a sample put into a slot while the plugin runs", async () => {
        let device: WclapDeviceBox | null = null
        const graph = buildEffectProject(0.0, (source, unit) => {
            device = WclapDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.url.setValue("radar")
                box.clapId.setValue(RADAR)
            })
            return device
        }, "class Processor { process() {} }")
        const statuses: Array<WclapStatus> = []
        const {engine, memory, drainSamples} = await loadFullEngine(48000, () => {}, () => null, {
            loadBundle: () => Promise.resolve(bundle),
            sendStatus: (_uuid, status) => statuses.push(status)
        })
        const sync = connectSyncToEngine(engine, memory, graph)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const len = engine.output_len() >>> 0
        const run = async (rounds: number): Promise<number> => {
            let peak = 0
            for (let attempt = 0; attempt < rounds; attempt++) {
                drainSamples()
                for (let quantum = 0; quantum < 16; quantum++) {
                    engine.render()
                    for (const value of new Float32Array(memory.buffer, engine.output_ptr(), len)) {peak = Math.max(peak, Math.abs(value))}
                }
                await new Promise(resolve => setTimeout(resolve, 5))
            }
            return peak
        }
        expect(await run(20)).toBeLessThan(0.001) // loaded, no sample yet: silent
        expect(statuses.some(({state}) => state === "ready")).toBe(true)
        graph.beginTransaction()
        const file = AudioFileBox.create(graph, UUID.generate(), box => {
            box.endInSeconds.setValue(0.5)
            box.fileName.setValue("tone")
        })
        WclapSampleBox.create(graph, UUID.generate(), box => {
            box.owner.refer(device!.samples)
            box.index.setValue(0)
            box.file.refer(file)
        })
        graph.endTransaction()
        await sync.settle()
        expect(await run(40)).toBeGreaterThan(0.01)
    }, 30000)
})
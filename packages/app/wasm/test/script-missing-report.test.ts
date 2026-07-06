// Regression for "Open Up renders silent": a scriptable device (Apparat/Werkstatt/Spielwerk) whose user
// Processor was never registered into globalThis.openDAW renders SILENCE — and, because whole chains run through
// such devices, the entire mix goes silent. That is exactly what happened when the offline render harness forgot
// to register the project's scripts. The engine must NOT swallow this: the script bridge reports each scriptless
// device once past a short grace window. This test proves both the silence AND the diagnostic.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {ScriptBridges, ScriptEngine} from "../src/script-bridge"

const CODE = `class Processor {
    phase = 0
    process(output, block) {
        const [l, r] = output
        for (let i = block.s0; i < block.s1; i++) { const v = 0.2 * Math.sin(this.phase); l[i] += v; r[i] += v; this.phase += 0.05 }
    }
}`

describe("scriptless device reporting", () => {
    it("renders silence AND reports the anomaly when a scriptable device has no registered Processor", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + CODE)
        })
        source.endTransaction()
        const uuid = UUID.toString(apparat.address.uuid)
        // Deliberately DO NOT register the script into globalThis.openDAW.
        const messages: Array<{uuid: string, message: string}> = []
        const {engine, memory} = await loadFullEngine(48000, (id, message) => messages.push({uuid: id, message}))
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const len = engine.output_len() >>> 0
        engine.stop(); engine.play()
        // Render past the ~1 s grace window (375 quanta) so the scriptless report fires.
        let peak = 0
        for (let quantum = 0; quantum < 400; quantum++) {
            engine.render()
            const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let index = 0; index < len; index++) {peak = Math.max(peak, Math.abs(output[index]))}
        }
        expect(peak).toBe(0)
        const report = messages.find(entry => entry.uuid === uuid)
        expect(report).toBeDefined()
        expect(report!.message).toContain("No Processor registered")
    }, 30000)
})

describe("script bridge rebind dedup", () => {
    it("a create for the same uuid releases the previous bridge instead of orphaning it", () => {
        // Regression: `#create` used to hand out a fresh handle on EVERY call regardless of uuid, so a device
        // instance dying WITHOUT the engine's `terminate` reaching it yet (or an engine that never reached this
        // fix) orphaned a Bridge (its Processor + limiter + runtime) on every rebind. A `create` for a uuid that
        // already has a live bridge must release the old one first.
        const memory = new WebAssembly.Memory({initial: 1})
        const engine: ScriptEngine = {host_resolve_sample: () => 0, input_reserve: () => 0}
        const bridges = new ScriptBridges(memory, engine, 48000)
        const uuidPtr = 0
        new Uint8Array(memory.buffer, uuidPtr, 16).set(UUID.generate())
        const imports = bridges.imports()
        const first = imports.host_script_create(uuidPtr, 1, 0) as number
        expect(bridges.liveBridgeCount()).toBe(1)
        const second = imports.host_script_create(uuidPtr, 1, 0) as number
        expect(second).not.toBe(first)
        expect(bridges.liveBridgeCount()).toBe(1)
    })
})

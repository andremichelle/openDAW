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

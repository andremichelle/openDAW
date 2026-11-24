// Regression (#573): a Spielwerk script that plays long notes, followed by an Arpeggio. Stopping the transport must
// end the script's notes. Note-ends are song positions and a stopped transport counts its own, so they never come
// due: the Arpeggio kept the notes as held keys and went on arpeggiating them while stopped.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, ArpeggioDeviceBox, AudioUnitBox, SpielwerkDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const INSTRUMENT = `class Processor {
    voices = new Set()
    noteOn(pitch, velocity, cent, id) { this.voices.add(id) }
    noteOff(id) { this.voices.delete(id) }
    process(output, block) {
        const [l, r] = output
        const level = this.voices.size / 100
        for (let i = block.s0; i < block.s1; i++) { l[i] += level; r[i] += level }
    }
}`

// A chord of three notes, one bar long, on every bar while transporting (like the issue's chord script).
const CHORDS = `class Processor {
    * process(block, events) {
        if ((block.flags & 1) === 0) return
        const step = 3840
        for (let position = Math.ceil(block.from / step) * step; position < block.to; position += step) {
            for (const pitch of [60, 64, 67]) {
                yield {position, duration: step * 0.9, pitch, velocity: 0.8, cent: 0}
            }
        }
    }
}`

const run = async (withArpeggio: boolean) => {
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
        box.code.setValue("// @apparat js 1 1\n" + INSTRUMENT)
    })
    const spielwerk = SpielwerkDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.index.setValue(0)
        box.code.setValue("// @spielwerk js 1 1\n// @no-pass\n" + CHORDS)
    })
    if (withArpeggio) {
        ArpeggioDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(1)
        })
    }
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, INSTRUMENT))()
    new Function(ScriptCompiler.wrap({headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"},
        UUID.toString(spielwerk.address.uuid), 1, CHORDS))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const half = (engine.output_len() >>> 0) >>> 1
    const counts: Array<number> = []
    for (let quantum = 0; quantum < 1200; quantum++) {
        if (quantum === 200) {engine.stop()}
        engine.render()
        counts.push(Math.round(new Float32Array(memory.buffer, engine.output_ptr(), half)[half - 1] * 100))
    }
    sync.close()
    return counts
}

describe("Spielwerk stops its notes with the transport", () => {
    for (const withArpeggio of [false, true]) {
        it(`falls silent once the transport stops${withArpeggio ? " (into an Arpeggio)" : ""}`, async () => {
            const counts = await run(withArpeggio)
            expect(counts.slice(0, 200).some(count => count > 0), "the chord sounded while playing").toBe(true)
            expect(counts.slice(220).filter(count => count > 0).length, "quanta sounding after stop").toBe(0)
        }, 60000)
    }
})

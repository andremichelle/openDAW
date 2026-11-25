// Arpeggio following the chord track, stopped while (or after) live keys were held. The instrument outputs the
// number of sounding voices as DC: a step note must end when the transport stops, not when the paused clock
// later passes its song position.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, ArpeggioDeviceBox, AudioUnitBox, ChordEventBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const INSTRUMENT = `class Processor {
    voices = new Set()
    pitches = new Map()
    noteOn(pitch, velocity, cent, id) { this.voices.add(id); this.pitches.set(id, pitch) }
    noteOff(id) { this.voices.delete(id); this.pitches.delete(id) }
    process(output, block) {
        const [l, r] = output
        let level = this.voices.size / 100
        for (const pitch of this.pitches.values()) { level += pitch / 100000 }
        for (let i = block.s0; i < block.s1; i++) { l[i] += level; r[i] += level }
    }
}`

type Scenario = { liveKeys: boolean }

const run = async ({liveKeys}: Scenario) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
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
    ArpeggioDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.followChords.setValue(true)
        box.modeIndex.setValue(6)
        box.numOctaves.setValue(3)
    })
    ChordEventBox.create(source, UUID.generate(), box => {
        box.track.refer(timelineBox.chordTrack.events)
        box.position.setValue(0)
        box.duration.setValue(3840 * 8)
        box.degree.setValue(1)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, INSTRUMENT))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const half = (engine.output_len() >>> 0) >>> 1
    const live = (procedure: () => void) => {
        new Uint8Array(memory.buffer, engine.input_reserve(16), 16).set(unit.address.uuid)
        procedure()
    }
    const counts: Array<number> = []
    for (let quantum = 0; quantum < 1600; quantum++) {
        if (liveKeys && quantum === 400) {live(() => [48, 52, 55].forEach(pitch => engine.note_signal_on(pitch, 0.8)))}
        if (liveKeys && quantum === 590) {live(() => [48, 52, 55].forEach(pitch => engine.note_signal_off(pitch)))}
        if (quantum === 780) {engine.stop()}
        engine.render()
        counts.push(Math.round(new Float32Array(memory.buffer, engine.output_ptr(), half)[half - 1] * 100))
    }
    sync.close()
    return counts
}

describe("Arpeggio stops its notes with the transport", () => {
    it("falls silent once the transport stops", async () => {
        for (const liveKeys of [false, true]) {
            const counts = await run({liveKeys})
            const sounding = counts.slice(800).filter(count => count > 0).length
            console.log(`liveKeys ${liveKeys}: quanta sounding after stop ${sounding}`)
            expect(sounding).toBe(0)
        }
    }, 60000)
})

// End to end: a project-global LFO assigned to a unit's VOLUME must actually move the rendered audio, both
// while playing and while the transport is STOPPED (a modulator is a function of the free-running position,
// not of the song). The instrument outputs a constant DC while a note is held, so the output level IS the
// fader value and the LFO shows up directly as an amplitude wobble.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, LfoModulatorBox, ModulationBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const DC = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 } }
    }
}`

const SQUARE = 4 // LfoModulatorBox.shape
const ONE_BAR = 4 // LfoModulatorBox.rateSync index ("Off" leads the table)

describe("modulated strip volume", () => {
    it("an LFO on the unit volume wobbles the output, playing and stopped", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
            box.volume.setValue(-6.0) // a static, un-automated fader: the LFO rides THIS value
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + DC)
        })
        const notes = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(0)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(0)
            box.duration.setValue(200_000)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(notes.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(200_000)
            box.loopDuration.setValue(200_000)
        })
        // A one-bar SQUARE LFO at full depth: the fader alternates between its floor and its top every half
        // bar (1 s at 120 BPM), which is unmistakable in the rendered peaks.
        const lfo = LfoModulatorBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Wobble")
            box.shape.setValue(SQUARE)
            box.rateSync.setValue(ONE_BAR)
        })
        ModulationBox.create(source, UUID.generate(), box => {
            box.source.refer(lfo.assignments)
            box.target.refer(unit.volume)
            box.depth.setValue(1.0)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, DC))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const len = engine.output_len() >>> 0
        const half = len >>> 1
        const render = (quanta: number): Float32Array => {
            const captured = new Float32Array(quanta * half)
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                captured.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
            }
            return captured
        }
        const peakOf = (samples: Float32Array): number =>
            samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
        const QUARTER_SECOND = Math.ceil(0.25 * 48000 / half)
        engine.stop(); engine.play()
        const high = peakOf(render(QUARTER_SECOND)) // first half bar: the square is HIGH, the fader is up
        render(Math.ceil(0.9 * 48000 / half)) // across the half-bar boundary and past the de-click ramp
        const low = peakOf(render(QUARTER_SECOND)) // second half bar: the square is LOW, the fader is down
        console.log(`modulated volume: high peak=${high.toFixed(4)} low peak=${low.toFixed(4)}`)
        expect(high).toBeGreaterThan(0.2, "the square's high half lifts the -6 dB fader")
        expect(low).toBeLessThan(high * 0.5, "and its low half drops it well below")
        // STOPPED: the modulation keeps running off the FREE-RUNNING position. It cannot be probed through
        // the audio here, since stopping releases the held note and there is nothing left to hear, so read
        // the parameter's UI broadcast instead: `[0]` the automated unit value (NaN, this fader is not
        // automated), `[1]` the modulation sum the knob adds to its own value.
        engine.stop()
        const recordPtr = engine.input_reserve(48)
        const count = engine.broadcast_count() >>> 0
        let slot: Float32Array | null = null
        for (let index = 0; index < count; index++) {
            if (engine.broadcast_entry(index, recordPtr) !== 1) {continue}
            const record = new DataView(memory.buffer, recordPtr, 48)
            const uuid = new Uint8Array(memory.buffer, recordPtr, 16).slice()
            const keysCount = record.getUint32(28, true)
            const keys = Array.from({length: keysCount}, (_, at) => record.getUint16(32 + at * 2, true))
            if (UUID.toString(uuid as UUID.Bytes) === UUID.toString(unit.address.uuid) && keys.length === 1 && keys[0] === 12) {
                slot = new Float32Array(memory.buffer, record.getUint32(20, true), record.getUint32(24, true))
                break
            }
        }
        expect(slot).not.toBeNull()
        const sums: Array<number> = []
        for (let round = 0; round < 8; round++) {
            render(Math.ceil(0.25 * 48000 / half))
            sums.push((slot as Float32Array)[1])
        }
        console.log(`stopped modulation sums: ${sums.map(sum => sum.toFixed(3)).join(" ")}`)
        expect(Math.max(...sums) - Math.min(...sums)).toBeGreaterThan(0.5,
            "a stopped transport still moves the modulation")
    }, 60000)
})

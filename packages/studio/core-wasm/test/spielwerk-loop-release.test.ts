// Regression: a Spielwerk note whose span reaches PAST the loop end must be released when the transport wraps.
// The engine's own `NoteSequencer` drains its retainer and emits a note-off at `from` on a DISCONTINUOUS block
// (engine-env/src/note_sequencer.rs), but the script runtime only releases a retained note once its end falls
// inside a pulled range. After a loop wrap that end is never reached again, so the downstream instrument keeps
// the voice and every further cycle stacks another one — a stuck note that never stops.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, SpielwerkDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const LOOP_END = 960 // two beats at 120 bpm = 1s
const NOTE_POSITION = 900
const NOTE_DURATION = 240 // ends at 1140, BEYOND the loop end: only the wrap can release it
const VOICE_LEVEL = 0.1

// Instrument that reports its HELD VOICE COUNT as DC, so a stuck voice is directly measurable in the output.
const APPARAT = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        const dc = this.voices.length * ${VOICE_LEVEL}
        for (let i = block.s0; i < block.s1; i++) { l[i] += dc; r[i] += dc }
    }
}`

// One note per loop cycle, starting near the loop end.
const SPIELWERK = `class Processor {
    * process(block, events) {
        if (block.from <= ${NOTE_POSITION} && ${NOTE_POSITION} < block.to) {
            yield {position: ${NOTE_POSITION}, duration: ${NOTE_DURATION}, pitch: 60, velocity: 1, cent: 0}
        }
    }
}`

describe("spielwerk loop release", () => {
    it("releases notes that outlive the loop end when the transport wraps", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        timelineBox.loopArea.enabled.setValue(true)
        timelineBox.loopArea.from.setValue(0)
        timelineBox.loopArea.to.setValue(LOOP_END)
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + APPARAT)
        })
        const spielwerk = SpielwerkDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
            box.code.setValue("// @spielwerk js 1 1\n" + SPIELWERK)
        })
        source.endTransaction()

        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, APPARAT))()
        new Function(ScriptCompiler.wrap({headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"},
            UUID.toString(spielwerk.address.uuid), 1, SPIELWERK))()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const QUANTA = 1200 // ~3.2 loop cycles at 48k
        engine.stop(); engine.play()
        let sounded = false
        let peak = 0
        for (let quantum = 0; quantum < QUANTA; quantum++) {
            engine.render()
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let i = 0; i < len; i++) {peak = Math.max(peak, Math.abs(out[i]))}
            if (peak > VOICE_LEVEL / 2) {sounded = true}
        }
        expect(sounded, "the sequenced note sounded at all").toBe(true)
        // One voice at a time. A second cycle's note stacking on an unreleased first one doubles the DC.
        expect(peak, "no voice survived the loop wrap").toBeLessThan(VOICE_LEVEL * 1.5)
    }, 60000)
})

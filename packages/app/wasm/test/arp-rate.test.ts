// End-to-end proof that the ported ARP honors its rate parameter (the "1/3 plays as 1/16" bug). An Apparat
// instrument that outputs DC (0.3) only WHILE a note is held turns each arp step into a countable pulse; with
// a short gate the pulses are separated by silence, so counting rising edges counts arp steps. The arp sits on
// the unit's MIDI host, fed by a single long held note. At rate 1/3 (1280 pulses) there are far fewer steps
// per second than at 1/16 (240 pulses) — the OLD dummy device ignored rateIndex and always ran at 1/16.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, ArpeggioDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const CODE = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 } }
    }
}`

const countSteps = async (rateIndex: number): Promise<number> => {
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
    ArpeggioDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.rateIndex.setValue(rateIndex)
        box.gate.setValue(0.5) // half-step gate, so each step is a pulse with a silent gap after it
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
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
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.loopDuration.setValue(200_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, CODE))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const half = len >>> 1
    const QUANTA = Math.ceil(4 * 48000 / half) // ~4 seconds
    engine.stop(); engine.play()
    const left = new Float32Array(QUANTA * half)
    for (let quantum = 0; quantum < QUANTA; quantum++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
    }
    let steps = 0
    for (let index = 1; index < left.length; index++) {
        if (left[index - 1] <= 1e-6 && left[index] > 0.1) {steps++}
    }
    return steps
}

describe("arp rate", () => {
    it("steps far faster at 1/16 than at 1/3 (rateIndex is honored)", async () => {
        const third = await countSteps(2)   // 1/3 = 1280 pulses
        const sixteenth = await countSteps(9) // 1/16 = 240 pulses
        console.log(`arp steps over ~4s: 1/3=${third}  1/16=${sixteenth}`)
        // 1/3 is ~1.5 steps/s (~6 in 4s); 1/16 is ~8 steps/s (~32 in 4s).
        expect(third).toBeGreaterThan(2)
        expect(third).toBeLessThan(12)
        expect(sixteenth).toBeGreaterThan(third * 3)
    }, 60000)
})

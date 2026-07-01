// Wiring + behaviour: a Velocity midi-effect between a note region and a scriptable Apparat sine must rewrite the
// note's velocity in the chain. The Apparat's voice gain is velocity-scaled, so forcing the velocity to a low
// magnet target (full strength) makes the output much quieter than the passthrough (strength 0) — which only
// happens if the device is wired and its magnet params applied.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, VelocityDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

// A sine whose gain is velocity * 0.3 — so a lower note velocity means a quieter output.
const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * 0.3, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

// magnetPosition + magnetStrength drive the transform; strength 0 = passthrough of the note's velocity (1.0).
const build = (magnetPosition: number, magnetStrength: number) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let apparatUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    apparatUuid = UUID.toString(apparat.address.uuid)
    VelocityDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.index.setValue(0)
        box.magnetPosition.setValue(magnetPosition)
        box.magnetStrength.setValue(magnetStrength)
        box.randomAmount.setValue(0.0)
        box.offset.setValue(0.0)
        box.mix.setValue(1.0)
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
        box.duration.setValue(10_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0) // full velocity; the effect can pull it down
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.loopDuration.setValue(10_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparatUuid, 1, SYNTH))()
    return source
}

const renderPeak = async (source: ReturnType<typeof build>): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let peak = 0
    for (let q = 0; q < 16; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {peak = Math.max(peak, Math.abs(out[i]))}
    }
    return peak
}

describe("velocity device", () => {
    it("passes the note velocity through at zero strength", async () => {
        const peak = await renderPeak(build(0.2, 0.0)) // strength 0 -> velocity stays 1.0
        expect(peak).toBeGreaterThan(0.2) // velocity 1.0 * gain 0.3 ~ 0.3
    }, 30000)

    it("pulls the velocity down toward a low magnet target at full strength", async () => {
        const low = await renderPeak(build(0.2, 1.0))  // velocity -> 0.2
        const full = await renderPeak(build(0.2, 0.0)) // velocity -> 1.0
        expect(low).toBeGreaterThan(0.0)          // still sounds
        expect(low).toBeLessThan(full * 0.5)      // but much quieter (velocity 0.2 vs 1.0)
    }, 30000)
})

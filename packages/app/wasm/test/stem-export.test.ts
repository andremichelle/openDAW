// STEM export (TS `exportConfiguration.stems` -> per-unit `AudioUnitOptions`): each configured unit's TAP
// lands planar in the stem staging (stem i -> channels 2i / 2i+1). The options steer the wiring exactly like
// TS: includeAudioEffects=false leaves the unit fx unwired, useInstrumentOutput taps the raw instrument,
// skipChannelStrip taps post-fx/pre-fader — proven against a -24 dB StereoTool and a -12 dB fader.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, StereoToolDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const QUANTUM = 128
const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [left, right] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const value = Math.sin(voice.phase * Math.PI * 2) * 0.5
                left[i] += value; right[i] += value
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const build = () => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const units: Array<AudioUnitBox> = []
    for (let index = 0; index < 2; index++) {
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(index + 1)
            box.volume.setValue(-12) // the fader: distinguishes strip vs pre-strip taps
        })
        unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + SYNTH)
        })
        StereoToolDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(0); box.volume.setValue(-24)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0); box.target.refer(unit); box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions); box.events.refer(events.owners); box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
        })
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
        units.push(unit)
    }
    source.endTransaction()
    return {source, units}
}

const FLAGS_DEFAULT = 1 | 2 // includeAudioEffects | includeSends
const FLAGS_NO_FX = 2
const FLAGS_INSTRUMENT = 1 | 2 | 4
const FLAGS_NO_STRIP = 1 | 2 | 8

const setup = async (flags: [number, number]) => {
    const {source, units} = build()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle()
    const pointer = engine.input_reserve(2 * 20)
    const view = new DataView(memory.buffer, pointer, 2 * 20)
    units.forEach((unit, index) => {
        new Uint8Array(memory.buffer, pointer + index * 20, 16).set(unit.address.uuid)
        view.setUint32(index * 20 + 16, flags[index], true)
    })
    engine.set_stem_export(2)
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const stemPeaks = (quanta: number): [number, number] => {
        const peaks: [number, number] = [0, 0]
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            const staging = new Float32Array(memory.buffer, engine.stem_output_ptr(), 2 * 2 * QUANTUM)
            for (let stem = 0; stem < 2; stem++) {
                for (let index = 0; index < 2 * QUANTUM; index++) {
                    peaks[stem] = Math.max(peaks[stem], Math.abs(staging[stem * 2 * QUANTUM + index]))
                }
            }
        }
        return peaks
    }
    return {stemPeaks}
}

const db = (value: number): number => 20 * Math.log10(value)

describe("stem export", () => {
    it("renders per-unit taps with their options", async () => {
        // Stem 0 default (fx -24 + fader -12 = -36 from the 0.5 source), stem 1 without fx (-12 only).
        const {stemPeaks} = await setup([FLAGS_DEFAULT, FLAGS_NO_FX])
        const [full, noFx] = stemPeaks(64)
        expect(db(full / 0.5), "default: fx + fader apply").toBeCloseTo(-36, 0)
        expect(db(noFx / 0.5), "no-fx: only the fader applies").toBeCloseTo(-12, 0)
    }, 60000)

    it("taps the raw instrument and the pre-fader chain", async () => {
        // Stem 0 instrument output (raw 0.5), stem 1 skip strip (fx -24, no fader).
        const {stemPeaks} = await setup([FLAGS_INSTRUMENT, FLAGS_NO_STRIP])
        const [raw, preFader] = stemPeaks(64)
        expect(raw, "instrument output: unprocessed").toBeCloseTo(0.5, 1)
        expect(db(preFader / 0.5), "skip strip: fx only").toBeCloseTo(-24, 0)
    }, 60000)
})

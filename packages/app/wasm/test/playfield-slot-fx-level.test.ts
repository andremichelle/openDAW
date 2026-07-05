// Repro for the atstil residual: a StereoTool ON A PLAYFIELD SLOT (PlayfieldSampleBox.audioEffects) cut the
// level in TS but did NOTHING in wasm. Drives one looping pad through a slot StereoTool at -24 dB in both
// engines: the cut must match.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {Interpolation, WavFile} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, PlayfieldDeviceBox, PlayfieldSampleBox, StereoToolDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {InterpolationFieldAdapter, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"

const tone = (): ArrayBuffer => {
    const frames = 48000
    const data = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {data[i] = Math.sin(i * 220 / 48000 * Math.PI * 2) * 0.5}
    return WavFile.encodeFloats({frames: [data], numberOfFrames: frames, numberOfChannels: 1, sampleRate: 48000})
}

const build = (slotFxVolumeDb: number | null, automateToUnit?: number, duplicateIndexPad?: boolean) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const fileUuid = UUID.generate()
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const playfield = PlayfieldDeviceBox.create(source, UUID.generate(), box => {box.host.refer(unit.input)})
    const file = AudioFileBox.create(source, fileUuid, box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(1.0); box.fileName.setValue("synthetic")
    })
    const slot = PlayfieldSampleBox.create(source, UUID.generate(), box => {
        box.device.refer(playfield.samples); box.file.refer(file); box.index.setValue(60)
    })
    if (duplicateIndexPad) {
        // A SECOND pad on the SAME index: TS routes each note to exactly ONE pad (`getAdapterByIndex`), so
        // the duplicate must stay silent — an engine playing BOTH doubles the level (the atstil bass click).
        PlayfieldSampleBox.create(source, UUID.generate(), box => {
            box.device.refer(playfield.samples); box.file.refer(file); box.index.setValue(60)
        })
    }
    if (slotFxVolumeDb !== null) {
        const stereoTool = StereoToolDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(slot.audioEffects); box.index.setValue(0); box.volume.setValue(slotFxVolumeDb)
        })
        if (automateToUnit !== undefined) {
            // The atstil shape: the SLOT fx volume is AUTOMATED by a region far BEYOND the render window whose
            // curve STACKS two events at local 0 (index 0 = the low value, index 1 = a decoy). Before the first
            // region both engines must resolve the region's INCOMING value = the stack's FIRST event —
            // flooring picks the decoy instead (the atstil pad-StereoTool bug).
            const valueTrack = TrackBox.create(source, UUID.generate(), box => {
                box.type.setValue(TrackType.Value); box.enabled.setValue(true); box.index.setValue(1)
                box.target.refer(stereoTool.volume); box.tracks.refer(unit.tracks)
            })
            const valueEvents = ValueEventCollectionBox.create(source, UUID.generate())
            ValueEventBox.create(source, UUID.generate(), box => {
                box.position.setValue(0); box.value.setValue(automateToUnit); box.index.setValue(0)
                box.slope.setValue(NaN); box.events.refer(valueEvents.events)
                InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
            })
            ValueEventBox.create(source, UUID.generate(), box => {
                box.position.setValue(0); box.value.setValue(0.833); box.index.setValue(1)
                box.slope.setValue(NaN); box.events.refer(valueEvents.events)
                InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
            })
            ValueRegionBox.create(source, UUID.generate(), box => {
                box.position.setValue(122880); box.duration.setValue(3840); box.loopDuration.setValue(3840)
                box.regions.refer(valueTrack.regions); box.events.refer(valueEvents.owners)
            })
        }
    }
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
    source.endTransaction()
    return {source, fileUuid}
}

const wasmRms = async (source: BoxGraph, fileUuid: UUID.Bytes, quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const reserve = engine.input_reserve(16)
        const handle = engine.sample_take_request(reserve)
        if (handle < 0) {break}
        const audio = WavFile.decodeFloats(tone())
        const ptr = engine.sample_allocate(handle, audio.numberOfFrames * audio.numberOfChannels * 4)
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            new Float32Array(memory.buffer, ptr + channel * audio.numberOfFrames * 4, audio.numberOfFrames).set(audio.frames[channel])
        }
        engine.sample_set_ready(handle, audio.numberOfFrames, audio.numberOfChannels, audio.sampleRate)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 2) {continue}
        const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += output[i] * output[i]; count++}
    }
    return Math.sqrt(sum / count)
}

const tsRms = async (source: BoxGraph, fileUuid: UUID.Bytes, quanta: number): Promise<number> => {
    const render = await renderTs(ProjectSkeleton.encode(source), buildSampleMap([{uuid: fileUuid, wav: tone()}]), quanta)
    let sum = 0, count = 0
    for (let q = Math.floor(quanta / 2); q < quanta; q++) {
        for (let i = 0; i < 256; i++) {const value = render.buffer[q * 256 + i]; sum += value * value; count++}
    }
    return Math.sqrt(sum / count)
}

describe("playfield slot fx level", () => {
    it("a slot StereoTool at -24 dB cuts the pad the same in TS and wasm", async () => {
        const QUANTA = 100
        const dry = build(null)
        const dryTs = await tsRms(dry.source, dry.fileUuid, QUANTA)
        const dryWasm = await wasmRms(dry.source, dry.fileUuid, QUANTA)
        const wet = build(-24)
        const wetTs = await tsRms(wet.source, wet.fileUuid, QUANTA)
        const wetWasm = await wasmRms(wet.source, wet.fileUuid, QUANTA)
        const cutTs = 20 * Math.log10(wetTs / dryTs)
        const cutWasm = 20 * Math.log10(wetWasm / dryWasm)
        console.log(`dry: ts ${dryTs.toExponential(3)} wasm ${dryWasm.toExponential(3)} | cut: ts ${cutTs.toFixed(2)} dB wasm ${cutWasm.toFixed(2)} dB`)
        expect(dryWasm).toBeGreaterThan(0.01)
        expect(cutTs).toBeLessThan(-20)
        expect(cutWasm, "the slot fx must cut in wasm like in TS").toBeLessThan(-20)
    }, 120000)

    it("an AUTOMATED slot StereoTool volume follows the curve in wasm like TS (atstil residual)", async () => {
        const QUANTA = 100
        const dry = build(null)
        const dryTs = await tsRms(dry.source, dry.fileUuid, QUANTA)
        const dryWasm = await wasmRms(dry.source, dry.fileUuid, QUANTA)
        // Static volume 0 dB (transparent), automated DOWN to unit ~0.238 = -24 dB in Decibel(-72, 0, 12).
        const lowUnit = 0.238
        const wet = build(0, lowUnit)
        const wetTs = await tsRms(wet.source, wet.fileUuid, QUANTA)
        const wetWasm = await wasmRms(wet.source, wet.fileUuid, QUANTA)
        const cutTs = 20 * Math.log10(wetTs / dryTs)
        const cutWasm = 20 * Math.log10(wetWasm / dryWasm)
        console.log(`automated cut: ts ${cutTs.toFixed(2)} dB wasm ${cutWasm.toFixed(2)} dB`)
        expect(cutTs).toBeLessThan(-15)
        expect(cutWasm, "the automated slot fx volume must apply in wasm like TS").toBeLessThan(-15)
    }, 120000)

    it("two pads on the SAME index play as ONE (TS routes a note to a single pad)", async () => {
        const QUANTA = 100
        const single = build(null)
        const singleWasm = await wasmRms(single.source, single.fileUuid, QUANTA)
        const doubled = build(null, undefined, true)
        const doubledTs = await tsRms(doubled.source, doubled.fileUuid, QUANTA)
        const doubledWasm = await wasmRms(doubled.source, doubled.fileUuid, QUANTA)
        console.log(`single wasm ${singleWasm.toExponential(3)} | duplicate-index: ts ${doubledTs.toExponential(3)} wasm ${doubledWasm.toExponential(3)}`)
        expect(doubledWasm, "wasm must match TS with a duplicate-index pad").toBeCloseTo(doubledTs, 4)
        expect(doubledWasm, "the duplicate pad must not double the level").toBeCloseTo(singleWasm, 4)
    }, 120000)
})

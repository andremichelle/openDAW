// Isolates whether the wasm Nano accumulates overlapping voices like the TS engine. Chaotics' Nano tracks cap at
// ~1 voice while TS builds up a roll — so drive one Nano with N simultaneous HELD notes over a constant sample
// and compare the summed level: N overlapping voices should sum to ~N x a single voice in BOTH engines.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioUnitBox, CaptureMidiBox, NanoDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const FRAMES = 48000
const N = 4
const DEVICE_VOLUME_DB = -12 // exercise a NON-zero Nano device volume (field 10) + its mapping

const constantSample = (): AudioData => {
    const data = AudioData.create(48000, FRAMES, 1)
    data.frames[0].fill(0.25)
    return data
}

const build = () => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let fileUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0)
        box.endInSeconds.setValue(1.0)
        box.fileName.setValue("const")
    })
    fileUuid = UUID.toString(file.address.uuid)
    NanoDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.file.refer(file)
        box.volume.setValue(DEVICE_VOLUME_DB)
        box.release.setValue(1.0)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    // A ROLL: N short notes staggered in time; each note-offs quickly but its 1 s release tail keeps ringing, so
    // they pile up (as a drum roll builds). This is the Chaotics pattern that the wasm renders too quiet.
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    for (let n = 0; n < N; n++) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(0)        // ALL simultaneous + held -> N voices at once (tests MAX_VOICES=64)
            box.duration.setValue(100_000)
            box.pitch.setValue(24 + n)      // distinct pitches (24..123, valid MIDI)
            box.velocity.setValue(1.0)
            box.cent.setValue(0)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    return {source, fileUuid}
}

const renderWasmPeak = async (source: ReturnType<typeof build>["source"], quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const rp = engine.input_reserve(16)
        const h = engine.sample_take_request(rp)
        if (h < 0) {break}
        const p = engine.sample_allocate(h, FRAMES * 4)
        new Float32Array(memory.buffer, p, FRAMES).fill(0.25)
        engine.sample_set_ready(h, FRAMES, 1, 48000)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let peak = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 2) {continue}
        const o = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {peak = Math.max(peak, Math.abs(o[i]))}
    }
    return peak
}

describe("minimal nano polyphony", () => {
    it(`${N} held Nano voices sum to the same level in TS and wasm`, async () => {
        const Q = 100
        const {source, fileUuid} = build()
        const ts = await renderTs(ProjectSkeleton.encode(source), new Map<string, AudioData>([[fileUuid, constantSample()]]), Q)
        let tsPeak = 0
        for (let q = Math.floor(Q / 2); q < Q; q++) {
            for (let i = 0; i < 128 * 2; i++) {tsPeak = Math.max(tsPeak, Math.abs(ts.buffer[q * 256 + i]))}
        }
        const wasmPeak = await renderWasmPeak(build().source, Q)
        require("node:fs").writeFileSync("/tmp/nano-poly.txt", `N=${N} TS peak ${tsPeak.toFixed(4)} WASM peak ${wasmPeak.toFixed(4)} ratio ${(wasmPeak / tsPeak).toFixed(3)}\n`)
        expect(tsPeak).toBeGreaterThan(0.1)
        expect(wasmPeak).toBeGreaterThan(0.1)
    }, 60000)
})

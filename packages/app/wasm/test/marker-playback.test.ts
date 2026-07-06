// Marker-track playback through the REAL engine (TS BlockRenderer's `--- MARKER ---` action): a marker
// with plays=N repeats its section N times (a position jump back, the post-jump block discontinuous)
// before falling through to the next marker, every state move queues a switchMarkerState record
// ([uuid 16][count u32 LE][flag u32 LE], the clip-changes pattern), a seek into another section resets
// the play count, and a disabled marker track never jumps.
import {describe, expect, it} from "vitest"
import {Nullable, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {MarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BPM = 120.0
const SAMPLE_RATE = 48000.0

// An empty project (nothing audible; the transport positions are the subject) with marker A at 0
// playing its section twice and marker B at pulse 960 (one beat) closing it.
const build = (enabled: boolean) => {
    const {boxGraph: source, mandatoryBoxes: {timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const uuidA = UUID.generate()
    const uuidB = UUID.generate()
    source.beginTransaction()
    timelineBox.markerTrack.enabled.setValue(enabled)
    const markerA = MarkerBox.create(source, uuidA, box => {
        box.track.refer(timelineBox.markerTrack.markers)
        box.position.setValue(0)
        box.plays.setValue(2)
    })
    MarkerBox.create(source, uuidB, box => {
        box.track.refer(timelineBox.markerTrack.markers)
        box.position.setValue(960)
        box.plays.setValue(1)
    })
    source.endTransaction()
    return {source, timelineBox, markerA, uuidA: UUID.toString(uuidA), uuidB: UUID.toString(uuidB)}
}

type MarkerRecord = Nullable<[string, number]>

const drainMarkerRecords = (engine: any, memory: WebAssembly.Memory): Array<MarkerRecord> => {
    const count = engine.marker_changes_count() >>> 0
    if (count === 0) {return []}
    const pointer = engine.input_reserve(count * 24)
    const taken = engine.marker_changes_take(pointer) >>> 0
    const view = new DataView(memory.buffer, pointer, taken * 24)
    const records: Array<MarkerRecord> = []
    for (let index = 0; index < taken; index++) {
        const active = view.getUint32(index * 24 + 20, true) === 1
        records.push(active
            ? [UUID.toString(new Uint8Array(memory.buffer, pointer + index * 24, 16).slice() as UUID.Bytes),
                view.getUint32(index * 24 + 16, true)]
            : null)
    }
    return records
}

// Render `quanta` quanta, reading the transport position after each and draining the marker records.
const renderRun = (engine: any, memory: WebAssembly.Memory, quanta: number) => {
    const positions: Array<number> = []
    const records: Array<MarkerRecord> = []
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        const view = new DataView(memory.buffer, engine.engine_state_ptr(), engine.engine_state_len())
        positions.push(view.getFloat32(0))
        records.push(...drainMarkerRecords(engine, memory))
    }
    return {positions, records}
}

const jumpsOf = (positions: Array<number>): Array<number> =>
    positions.flatMap((position, index) => index > 0 && position < positions[index - 1] ? [index] : [])

const quantaFor = (pulses: number): number => Math.ceil(PPQN.pulsesToSamples(pulses, BPM, SAMPLE_RATE) / 128)

describe("marker-track playback", () => {
    it("a plays=2 marker repeats its section twice, then falls through; states notify", async () => {
        const {source, uuidA, uuidB} = build(true)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.play()
        // 3072 pulses of rendering: the 960-pulse section plays twice (one jump back), then B's section
        const {positions, records} = renderRun(engine, memory, quantaFor(3072))
        const jumps = jumpsOf(positions)
        expect(jumps.length, `exactly one jump back, got positions around ${JSON.stringify(jumps)}`).toBe(1)
        expect(positions[jumps[0] - 1], "the pre-jump quantum ran up to the section end").toBeGreaterThan(955)
        expect(positions[jumps[0]], "the post-jump quantum resumed at the section start").toBeLessThan(10)
        const finalPosition = positions[positions.length - 1]
        expect(finalPosition, "playback fell through past the boundary").toBeGreaterThan(960)
        expect(finalPosition, "one extra section pass consumed 960 pulses").toBeLessThan(3072 - 960 + 6)
        expect(records, "entered A, repeated A, fell through to B").toEqual([[uuidA, 0], [uuidA, 1], [uuidB, 0]])
        // a seek into ANOTHER section resets the play count and notifies
        engine.set_position(240)
        engine.render()
        expect(drainMarkerRecords(engine, memory)).toEqual([[uuidA, 0]])
    }, 60000)

    it("a disabled marker track never jumps and never notifies", async () => {
        const {source} = build(false)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.play()
        const {positions, records} = renderRun(engine, memory, quantaFor(2000))
        expect(jumpsOf(positions)).toEqual([])
        expect(positions[positions.length - 1]).toBeGreaterThan(1990)
        expect(records).toEqual([])
    }, 60000)

    it("marker edits rebind live: raising plays mid-run extends the repeats", async () => {
        const {source, markerA, uuidA, uuidB} = build(true)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.play()
        // consume the first pass + the start of the first repeat
        const first = renderRun(engine, memory, quantaFor(960 + 480))
        expect(jumpsOf(first.positions).length).toBe(1)
        expect(first.records).toEqual([[uuidA, 0], [uuidA, 1]])
        // now raise A's plays 2 -> 4 (a live transaction): the re-resolve keeps the running count (same
        // section), so TWO more repeats happen before falling through to B
        source.beginTransaction()
        markerA.plays.setValue(4)
        source.endTransaction()
        await sync.settle()
        const second = renderRun(engine, memory, quantaFor(3 * 960))
        expect(jumpsOf(second.positions).length, "two more repeats after the edit").toBe(2)
        expect(second.records).toEqual([[uuidA, 2], [uuidA, 3], [uuidB, 0]])
    }, 60000)
})

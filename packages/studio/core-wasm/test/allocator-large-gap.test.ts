// Live errors 1220, 1239, 1265, 1266, 1271 ("memory access out of bounds" inside talc's deallocate): talc
// 5.0.3 kept a chunk's tag in one byte that, on wasm32, is also the high byte of a free gap's size, so a free
// gap of 16 MiB or more read as an allocated chunk and the next free beside it corrupted the heap. Samples of
// 16 to 24 MiB and small ones are loaded and deleted at random, so small samples land in and next to the freed
// large chunks; every live sample must keep its frames.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type Live = { file: AudioFileBox, region: AudioRegionBox, events: ValueEventCollectionBox, pointer: number, frames: number, mark: number }

describe("free gaps of 16 MiB and more (1220-1271)", () => {
    it("keep every live sample intact while samples come and go", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
            box.target.refer(unit); box.tracks.refer(unit.tracks)
        })
        source.endTransaction()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        let seed = 12345
        const random = (): number => {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
            return (seed >>> 0) / 4294967296
        }
        const live: Array<Live> = []
        const intact = (entry: Live): boolean => {
            const frames = new Float32Array(memory.buffer, entry.pointer, entry.frames)
            return frames[0] === entry.mark && frames[entry.frames >> 1] === entry.mark && frames[entry.frames - 1] === entry.mark
        }
        for (let step = 0; step < 300; step++) {
            if (live.length > 0 && random() < 0.5) {
                const [entry] = live.splice(Math.floor(random() * live.length), 1)
                expect(intact(entry)).toBe(true)
                source.beginTransaction(); entry.region.delete(); entry.events.delete(); entry.file.delete(); source.endTransaction()
                await sync.settle()
            } else {
                source.beginTransaction()
                const file = AudioFileBox.create(source, UUID.generate(), box => {
                    box.endInSeconds.setValue(1.0); box.fileName.setValue(`sample-${step}`)
                })
                const events = ValueEventCollectionBox.create(source, UUID.generate())
                const region = AudioRegionBox.create(source, UUID.generate(), box => {
                    box.position.setValue(step * 3840); box.duration.setValue(3840); box.loopDuration.setValue(3840)
                    box.regions.refer(track.regions); box.file.refer(file); box.events.refer(events.owners)
                })
                source.endTransaction()
                await sync.settle()
                const handle = engine.sample_take_request(engine.input_reserve(16))
                expect(handle).toBeGreaterThanOrEqual(0)
                const frames = random() < 0.25 ? Math.floor((4 + random() * 2) * 1048576) : Math.floor((0.02 + random()) * 262144)
                const pointer = engine.sample_allocate(handle, frames * 4)
                expect(pointer).toBeGreaterThan(0)
                const mark = step + 1
                new Float32Array(memory.buffer, pointer, frames).fill(mark)
                engine.sample_set_ready(handle, frames, 1, 48000)
                live.push({file, region, events, pointer, frames, mark})
            }
            expect(live.every(intact)).toBe(true)
        }
    }, 120000)
})

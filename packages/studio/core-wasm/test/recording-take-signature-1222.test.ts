// Live error 1222: `signature_track.rs:203 RefCell already mutably borrowed` in render, ~2 s after a looped
// audio recording stopped and its finished take (804840 frames, 2 ch) was delivered. Replays that session on the
// heap-guard engine (`sh build-guard-engine.sh`, OPENDAW_HEAP_GUARD=1): signature track with an event, a Tape unit
// with EFFECTS monitoring, RecordAudio's take churn (region + file per take, duration/endInSeconds edits at ~60 Hz,
// a new take at every loop wrap), stop, then the delivery. `heap_guard_check` runs after every render and edit,
// and every render reads the signature track, so a stuck borrow flag or an overrun fails right where it starts.
import {describe, expect, it} from "vitest"
import {existsSync} from "node:fs"
import {tryCatch, UUID} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {TimeBase} from "@opendaw/lib-dsp"
import {
    AudioFileBox, AudioRegionBox, AudioTimeStretchBox, AudioUnitBox, CaptureAudioBox, CompressorDeviceBox, GateDeviceBox, MaximizerDeviceBox,
    RevampDeviceBox, SignatureEventBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox, WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType, TransferAudioUnits} from "@opendaw/studio-adapters"
import {GUARD_ENGINE_WASM, loadFullEngine, useEngineWasm} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const RATE = 48000
const QUANTUM = 128
const LOOP_PULSES = 3840 * 4
const LOOP_SECONDS = 8.0
const QUANTA_PER_FRAME = 6

const decodePanic = (engine: any, memory: WebAssembly.Memory): string => {
    const length = engine.panic_message_len() >>> 0
    return new TextDecoder().decode(new Uint8Array(memory.buffer, engine.panic_message_ptr(), length))
}

const build = () => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} = skeleton
    source.beginTransaction()
    SignatureEventBox.create(source, UUID.generate(), box => {
        box.events.refer(timelineBox.signatureTrack.events)
        box.index.setValue(0); box.relativePosition.setValue(2); box.nominator.setValue(3); box.denominator.setValue(4)
    })
    const {loopArea} = timelineBox
    loopArea.enabled.setValue(true); loopArea.from.setValue(0); loopArea.to.setValue(LOOP_PULSES)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureAudioBox.create(source, UUID.generate()))
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const existingFile = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(1.0); box.fileName.setValue("existing")
    })
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    const existing = AudioRegionBox.create(source, UUID.generate(), box => {
        box.file.refer(existingFile); box.events.refer(collection.owners); box.regions.refer(track.regions)
        box.position.setValue(3840); box.timeBase.setValue(TimeBase.Seconds); box.duration.setValue(1.0); box.loopDuration.setValue(1.0)
    })
    source.endTransaction()
    return {skeleton, source, unit, existing, existingFile}
}

describe.skipIf(!existsSync(GUARD_ENGINE_WASM))("live error 1222: looped take recording + take delivery", () => {
    it("keeps the signature track readable and the heap intact", async () => {
        useEngineWasm(GUARD_ENGINE_WASM)
        const {skeleton, source, unit, existing, existingFile} = build()
        const {engine, memory} = await loadFullEngine(RATE)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        const guarded = <T>(run: () => T): T => {
            const result = tryCatch(run)
            if (result.status === "success") {return result.value}
            const {error} = result
            if (error instanceof WebAssembly.RuntimeError) {throw new Error(`engine trap: ${decodePanic(engine, memory) || error.message}`)}
            throw error
        }
        const check = (): number => guarded(() => engine.heap_guard_check(1) >>> 0)
        const edit = async (mutate: () => void): Promise<void> => {
            source.beginTransaction(); mutate(); source.endTransaction()
            await sync.settle(); check()
        }
        const monitor = (target: AudioUnitBox): void => {
            const pointer = engine.input_reserve(24)
            new Uint8Array(memory.buffer, pointer, 16).set(target.address.uuid)
            const map = new DataView(memory.buffer, pointer, 24)
            map.setInt32(16, 0, true); map.setInt32(20, 1, true)
            guarded(() => engine.set_monitoring_map(1))
        }
        let phase = 0
        const render = (): void => {
            const staging = new Float32Array(memory.buffer, engine.monitor_input_ptr(), 8 * QUANTUM)
            staging.fill(0.0)
            for (let index = 0; index < QUANTUM * 2; index++) {staging[index] = Math.sin(phase++ * 0.05) * 0.3}
            guarded(() => engine.render())
            check()
        }
        const requested: Array<{handle: number, uuid: string}> = []
        const collectRequests = (): void => {
            for (; ;) {
                const outPtr = engine.input_reserve(16)
                const handle = guarded(() => engine.sample_take_request(outPtr))
                if (handle < 0) {break}
                requested.push({handle, uuid: UUID.toString(new Uint8Array(memory.buffer, outPtr, 16).slice() as UUID.Bytes)})
            }
        }
        const deliver = (handle: number, planes: ReadonlyArray<Float32Array>): boolean => guarded(() => {
            const frames = planes[0].length
            const bytesPerChannel = frames * Float32Array.BYTES_PER_ELEMENT
            const target = engine.sample_allocate(handle, planes.length * bytesPerChannel)
            if (target === 0) {return false}
            planes.forEach((plane, channel) => new Float32Array(memory.buffer, target + channel * bytesPerChannel, frames).set(plane))
            engine.sample_set_ready(handle, frames, planes.length, RATE)
            check()
            return true
        })
        const tone = (frames: number): Array<Float32Array> => [0, 1].map(channel => {
            const plane = new Float32Array(frames)
            for (let index = 0; index < frames; index++) {plane[index] = Math.sin(index * 0.01 + channel) * 0.25}
            return plane
        })
        engine.set_metronome_enabled(1)
        collectRequests()
        requested.splice(0).forEach(({handle}) => deliver(handle, tone(RATE)))
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < 200; quantum++) {render()}
        const editing = new BoxEditing(source)
        let seed = 1222
        const random = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
        const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]
        const stretches: Array<AudioTimeStretchBox> = []
        const chaosTracks: Array<TrackBox> = []
        let trackIndex = 1
        const addStretchedTrack = (): void => {editing.modify(() => {
            const chaosTrack = TrackBox.create(source, UUID.generate(), box => {
                box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(trackIndex++)
                box.target.refer(unit); box.tracks.refer(unit.tracks)
            })
            const stretch = AudioTimeStretchBox.create(source, UUID.generate())
            for (let marker = 0; marker < 5; marker++) {
                WarpMarkerBox.create(source, UUID.generate(), box => {
                    box.owner.refer(stretch.warpMarkers); box.position.setValue(marker * 1920); box.seconds.setValue(marker * 0.25)
                })
            }
            const collection = ValueEventCollectionBox.create(source, UUID.generate())
            AudioRegionBox.create(source, UUID.generate(), box => {
                box.file.refer(existingFile); box.events.refer(collection.owners); box.regions.refer(chaosTrack.regions)
                box.position.setValue(0); box.timeBase.setValue(TimeBase.Musical); box.duration.setValue(7680); box.loopDuration.setValue(7680)
                box.playMode.refer(stretch)
            })
            stretches.push(stretch)
            chaosTracks.push(chaosTrack)
        })}
        const markersOf = (stretch: AudioTimeStretchBox): Array<WarpMarkerBox> =>
            stretch.warpMarkers.pointerHub.incoming().map(pointer => pointer.box as WarpMarkerBox)
        const regionsOf = (chaosTrack: TrackBox): Array<AudioRegionBox> =>
            chaosTrack.regions.pointerHub.incoming().map(pointer => pointer.box as AudioRegionBox)
        type Effect = MaximizerDeviceBox | CompressorDeviceBox | GateDeviceBox | RevampDeviceBox
        const effects: Array<Effect> = []
        const liveEffects = (): Array<Effect> => effects.filter(effect => effect.isAttached())
        const reindexEffects = (): void => {
            unit.audioEffects.pointerHub.incoming().map(pointer => pointer.box as Effect)
                .sort((left, right) => left.index.getValue() - right.index.getValue())
                .forEach((effect, index) => effect.index.setValue(index))
        }
        const insertEffect = (): void => {editing.modify(() => {
            const index = unit.audioEffects.pointerHub.incoming().length
            const factory = pick([MaximizerDeviceBox, CompressorDeviceBox, GateDeviceBox, RevampDeviceBox])
            effects.push(factory.create(source, UUID.generate(), (box: Effect) => {box.host.refer(unit.audioEffects); box.index.setValue(index)}))
        })}
        const counts = {add: 0, warp: 0, deleteTrack: 0, mute: 0, undo: 0, redo: 0, insertFx: 0, deleteFx: 0, moveFx: 0, toggleFx: 0}
        for (let step = 0; step < 400; step++) {
            const roll = random()
            const liveTracks = chaosTracks.filter(chaosTrack => chaosTrack.isAttached())
            const warpable = stretches.filter(stretch => stretch.isAttached() && markersOf(stretch).length > 2)
            const fxRoll = random()
            if (fxRoll < 0.15 && liveEffects().length < 6) {
                insertEffect(); counts.insertFx++
            } else if (fxRoll < 0.25 && liveEffects().length > 0) {
                const victim = pick(liveEffects())
                editing.modify(() => {victim.delete(); reindexEffects()}); counts.deleteFx++
            } else if (fxRoll < 0.32 && liveEffects().length > 1) {
                const [first, second] = [pick(liveEffects()), pick(liveEffects())]
                if (first !== second) {
                    editing.modify(() => {
                        const index = first.index.getValue()
                        first.index.setValue(second.index.getValue()); second.index.setValue(index)
                    }); counts.moveFx++
                }
            } else if (fxRoll < 0.4 && liveEffects().length > 0) {
                const target = pick(liveEffects())
                editing.modify(() => target.enabled.setValue(!target.enabled.getValue())); counts.toggleFx++
            }
            await sync.settle(); check()
            if (roll < 0.2 && liveTracks.length < 6) {
                addStretchedTrack(); counts.add++
            } else if (roll < 0.45 && warpable.length > 0) {
                const markers = markersOf(pick(warpable))
                const inner = markers.sort((left, right) => left.position.getValue() - right.position.getValue()).slice(1, -1)
                editing.modify(() => pick(inner).delete()); counts.warp++
            } else if (roll < 0.6 && liveTracks.length > 0) {
                const victim = pick(liveTracks)
                editing.modify(() => {regionsOf(victim).forEach(region => region.delete()); victim.delete()}); counts.deleteTrack++
            } else if (roll < 0.7 && liveTracks.length > 0) {
                const regions = regionsOf(pick(liveTracks))
                if (regions.length > 0) {
                    const region = regions[0]
                    editing.modify(() => region.mute.setValue(!region.mute.getValue())); counts.mute++
                }
            } else if (roll < 0.88) {
                if (editing.undo()) {counts.undo++}
            } else if (editing.redo()) {counts.redo++}
            await sync.settle(); check()
            collectRequests()
            requested.splice(0).forEach(({handle}) => deliver(handle, tone(RATE)))
            for (let quantum = 0; quantum < 4; quantum++) {render()}
        }
        console.debug("[1222 chaos]", JSON.stringify(counts))
        await edit(() => existing.mute.setValue(true))
        for (let quantum = 0; quantum < 50; quantum++) {render()}
        let copy: AudioUnitBox | null = null
        await edit(() => {copy = TransferAudioUnits.transfer([unit], skeleton, {insertIndex: 2})[0]})
        const copyUnit = copy as unknown as AudioUnitBox
        collectRequests()
        requested.splice(0).forEach(({handle}) => deliver(handle, tone(RATE)))
        for (let quantum = 0; quantum < 50; quantum++) {render()}
        const copyTrack = copyUnit.tracks.pointerHub.incoming().map(pointer => pointer.box as TrackBox)
            .find(candidate => candidate.index.getValue() === 0) as TrackBox
        const copiedRegion = copyTrack.regions.pointerHub.incoming()[0].box as AudioRegionBox
        await edit(() => copiedRegion.position.setValue(copiedRegion.position.getValue()))
        await edit(() => copiedRegion.delete())
        for (let quantum = 0; quantum < 50; quantum++) {render()}
        engine.stop()
        for (let quantum = 0; quantum < 50; quantum++) {render()}
        monitor(copyUnit)
        for (let quantum = 0; quantum < 50; quantum++) {render()}
        guarded(() => engine.prepare_recording_state(0, 1.0))
        source.beginTransaction()
        const recordFile = AudioFileBox.create(source, UUID.generate(), box => box.fileName.setValue("take"))
        const takeQuanta = Math.round(LOOP_SECONDS * RATE / QUANTUM)
        let totalQuanta = 0
        for (let take = 0; take < 2; take++) {
            if (take > 0) {source.beginTransaction()}
            const collection = ValueEventCollectionBox.create(source, UUID.generate())
            const takeRegion = AudioRegionBox.create(source, UUID.generate(), box => {
                box.file.refer(recordFile); box.events.refer(collection.owners); box.regions.refer(copyTrack.regions)
                box.position.setValue(0); box.timeBase.setValue(TimeBase.Seconds); box.label.setValue(`Take ${take + 1}`)
                box.waveformOffset.setValue(take * LOOP_SECONDS); box.duration.setValue(0.01); box.loopDuration.setValue(0.01)
            })
            source.endTransaction()
            await sync.settle(); check()
            collectRequests()
            for (let quantum = 0; quantum < takeQuanta; quantum++) {
                render()
                totalQuanta++
                if (quantum % QUANTA_PER_FRAME === 0) {
                    const seconds = (quantum * QUANTUM) / RATE
                    await edit(() => {
                        takeRegion.duration.setValue(Math.max(0.01, seconds)); takeRegion.loopDuration.setValue(Math.max(0.01, seconds))
                        recordFile.endInSeconds.setValue((totalQuanta * QUANTUM) / RATE)
                    })
                    collectRequests()
                }
            }
            await edit(() => {takeRegion.duration.setValue(LOOP_SECONDS); takeRegion.loopDuration.setValue(LOOP_SECONDS)})
        }
        guarded(() => engine.stop_recording())
        const frames = 804840
        await edit(() => recordFile.endInSeconds.setValue(frames / RATE))
        collectRequests()
        for (let quantum = 0; quantum < 8; quantum++) {render()}
        const takeHandles = requested.filter(({uuid}) => uuid === UUID.toString(recordFile.address.uuid))
        expect(takeHandles.length, "the take's file was requested").toBeGreaterThan(0)
        const planes = tone(frames)
        const delivered = takeHandles.filter(({handle}) => deliver(handle, planes)).length
        expect(delivered, "the live handle took the delivery").toBe(1)
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < Math.round(4 * RATE / QUANTUM); quantum++) {render()}
        engine.stop()
    }, 600000)
})

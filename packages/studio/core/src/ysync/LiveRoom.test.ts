import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {asInstanceOf, Notifier, Option, UUID} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {AudioUnitBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, InstrumentFactories, NoteSignal} from "@opendaw/studio-adapters"
import type {Capture} from "../capture/Capture"
import type {RecordingSink} from "../io"
import {LiveRoom, RoomPeer} from "./testing/LiveRoom"

const unitsOf = ({project}: RoomPeer): ReadonlyArray<AudioUnitBox> =>
    IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits, AudioUnitBox)
const unitAt = (peer: RoomPeer, uuid: UUID.Bytes): AudioUnitBox => peer.graph.findBox<AudioUnitBox>(uuid).unwrap("no unit")
const addInstrument = ({project}: RoomPeer): AudioUnitBox => project.editing.modify(() =>
    project.api.createInstrument(InstrumentFactories.Vaporisateur).audioUnitBox).unwrap() as AudioUnitBox
const tracksOf = (unit: AudioUnitBox): ReadonlyArray<TrackBox> => unit.tracks.pointerHub.incoming()
    .map(({box}) => asInstanceOf(box, TrackBox)).toSorted((left, right) => left.index.getValue() - right.index.getValue())
const regionsOf = (unit: AudioUnitBox) => tracksOf(unit).flatMap(track => track.regions.pointerHub.incoming().map(({box}) => box))
const uniqueUnitIndices = (peer: RoomPeer): boolean => {
    const indices = unitsOf(peer).map(unit => unit.index.getValue())
    return new Set(indices).size === indices.length
}

// the real RecordingSession and RecordMidi, a fake capture only stands in for the MIDI device
const armMidi = async (peer: RoomPeer, unit: AudioUnitBox, clock: {now: number}) => {
    const {RecordMidi} = await import("../capture/RecordMidi")
    const notifier = new Notifier<NoteSignal>()
    const recorded: Array<NoteRegionBox> = []
    const capture = {
        audioUnitBox: unit, prepareRecording: async () => {},
        clearRecordedRegions: () => {recorded.length = 0},
        addRecordedRegion: (region: NoteRegionBox) => recorded.push(region), recordedRegions: () => recorded,
        startRecording: () => RecordMidi.start({
            notifier, project: peer.project, capture: capture as unknown as Capture,
            clock: {audibleTimeAt: (time: number) => time / 1000.0}
        })
    }
    vi.spyOn(peer.project.captureDevices, "filterArmed").mockReturnValue([capture as unknown as Capture])
    return {
        capture,
        start: async () => {
            await peer.project.recordingSession.start(false)
            peer.worklet.recordingStart.wrap({contextTime: clock.now / 1000.0, position: 0})
            peer.worklet.isRecording.setValue(true)
        },
        note: (pitch: number) => notifier.notify({...NoteSignal.on(UUID.generate(), pitch, 1.0), timeStamp: clock.now}),
        advance: (seconds: number) => {
            clock.now += seconds * 1000.0
            peer.worklet.position.setValue(peer.worklet.position.getValue() + 1)
        },
        stop: () => peer.worklet.isRecording.setValue(false)
    }
}

describe("LiveRoom", () => {
    let room: LiveRoom
    let A: RoomPeer
    let B: RoomPeer
    let C: RoomPeer
    const clock = {now: 0}

    beforeEach(async () => {
        vi.spyOn(console, "debug").mockImplementation(() => {})
        vi.spyOn(performance, "now").mockImplementation(() => clock.now)
        clock.now = 0
        room = await LiveRoom.create(["A", "B", "C"])
        ;[A, B, C] = room.peers
        room.flush()
    })

    afterEach(() => {
        room.terminate()
        vi.restoreAllMocks()
    })

    const healthy = async () => {
        expect(room.violations()).toEqual([])
        expect(await room.lateJoinerDiffers()).toBe(false)
    }

    describe("network", () => {
        it("starts healthy", healthy)

        it("converges with every message delivered in reverse", async () => {
            addInstrument(A)
            addInstrument(A)
            addInstrument(B)
            room.peers.forEach(peer => peer.inbox.reverse())
            await healthy()
            expect(unitsOf(C).length).toBe(unitsOf(A).length)
        })

        it("a client back from a disconnect merges its edits", async () => {
            room.disconnect(B)
            addInstrument(A)
            addInstrument(B)
            await healthy()
            expect(unitsOf(A).length).toBe(unitsOf(B).length)
        })

        it("a late joiner sees the room", async () => {
            addInstrument(A)
            room.flush()
            const D = await room.join("D")
            room.flush()
            expect(unitsOf(D).length).toBe(unitsOf(A).length)
            await healthy()
        })
    })

    describe("preview", () => {
        const effectsOf = (peer: RoomPeer, unit: AudioUnitBox) => {
            const host = peer.project.boxAdapters.adapterFor(unit, Devices.isHost)
            return IndexedBox.collectIndexedBoxes(DeviceHost.chainFieldOf(host, "audio").unwrap())
        }
        const preview = async (peer: RoomPeer, unit: AudioUnitBox) => {
            const {EffectFactories} = await import("../EffectFactories")
            const layer = peer.sync.createLayer("preview")
            const host = peer.project.boxAdapters.adapterFor(unit, Devices.isHost)
            const field = DeviceHost.chainFieldOf(host, "audio").unwrap()
            const insert = () => peer.project.editing.modify(() =>
                peer.project.api.insertEffect(field, EffectFactories.AudioNamed.Compressor, 0))
            return {layer, pick: () => {layer.revert(); layer.run(insert)}, apply: () => {layer.revert(); insert()}}
        }
        let unit: AudioUnitBox
        beforeEach(() => {
            unit = addInstrument(A)
            room.flush()
        })

        it("twenty picks send nothing", async () => {
            const {pick} = await preview(A, unit)
            const before = A.sent
            for (let index = 0; index < 20; index++) {pick()}
            expect(A.sent).toBe(before)
            expect(effectsOf(A, unit).length).toBe(1)
            expect(effectsOf(B, unitAt(B, unit.address.uuid)).length).toBe(0)
        })

        it("cancel leaves the room untouched", async () => {
            const {layer, pick} = await preview(A, unit)
            pick()
            layer.revert()
            expect(effectsOf(A, unit).length).toBe(0)
            await healthy()
        })

        it("apply reaches every peer as one message", async () => {
            const {pick, apply} = await preview(A, unit)
            pick()
            const before = A.sent
            apply()
            expect(A.sent).toBe(before + 1)
            await healthy()
            expect(effectsOf(C, unitAt(C, unit.address.uuid)).length).toBe(1)
        })

        it("a peer's edit elsewhere does not disturb it", async () => {
            const {layer, pick} = await preview(A, unit)
            const invalid = vi.fn()
            layer.subscribeInvalid(invalid)
            pick()
            addInstrument(B)
            room.flush()
            expect(invalid).not.toHaveBeenCalled()
            expect(effectsOf(A, unit).length).toBe(1)
            layer.revert()
            await healthy()
        })

        it("a peer deleting the unit invalidates it", async () => {
            const {layer, pick} = await preview(A, unit)
            const invalid = vi.fn()
            layer.subscribeInvalid(invalid)
            pick()
            B.project.editing.modify(() => B.project.api.deleteAudioUnit(unitAt(B, unit.address.uuid)))
            room.flush()
            expect(invalid).toHaveBeenCalledTimes(1)
            expect(layer.hasChanges).toBe(false)
            await healthy()
        })

        it("a new unit applied after a peer inserted gets a free index", async () => {
            const layer = A.sync.createLayer("preview")
            const create = () => A.project.editing.modify(() => A.project.api.createInstrument(InstrumentFactories.Nano))
            layer.run(create)
            addInstrument(B)
            room.flush()
            layer.revert()
            create()
            await healthy()
            expect(uniqueUnitIndices(A)).toBe(true)
        })

        it("a preview may share its index with a peer's new unit, the room hears nothing until apply", async () => {
            const layer = A.sync.createLayer("preview")
            const create = () => A.project.editing.modify(() => A.project.api.createInstrument(InstrumentFactories.Nano), false)
            layer.run(create)
            const before = A.sent
            addInstrument(B)
            room.flush()
            expect(uniqueUnitIndices(A)).toBe(false)
            expect(A.sent).toBe(before)
            expect(unitsOf(B).length).toBe(unitsOf(A).length - 1)
            layer.revert()
            create()
            await healthy()
            expect(uniqueUnitIndices(A)).toBe(true)
        })

        it("a peer moving units while a unit is previewed leaves the room healthy", () => {
            const second = addInstrument(A)
            room.flush()
            const layer = A.sync.createLayer("preview")
            layer.run(() => A.project.editing.modify(() => A.project.api.createInstrument(InstrumentFactories.Nano), false))
            const remote = unitAt(B, second.address.uuid)
            B.project.editing.modify(() => remote.index.setValue(unitsOf(B).length))
            room.flush()
            layer.revert()
            expect(room.violations()).toEqual([])
        })

        // reported: a peer clicks a unit while the dialog swaps the previewed instrument, the engine diverged
        it("a peer clicking units while another previews keeps every engine in step", async () => {
            const layer = A.sync.createLayer("preview")
            const pick = (nano: boolean) => {
                layer.revert()
                layer.run(() => A.project.editing.modify(() => nano
                    ? A.project.api.createInstrument(InstrumentFactories.Nano)
                    : A.project.api.createInstrument(InstrumentFactories.Vaporisateur), false))
            }
            pick(true)
            unitsOf(B).forEach(remote => B.project.userEditingManager.audioUnit.edit(remote.editing))
            room.flush()
            pick(false)
            unitsOf(B).forEach(remote => B.project.userEditingManager.audioUnit.edit(remote.editing))
            room.flush()
            pick(true)
            layer.revert()
            A.project.editing.modify(() => A.project.api.createInstrument(InstrumentFactories.Nano))
            await healthy()
        })

        it("undo of a unit a peer is editing keeps every engine in step", async () => {
            const created = addInstrument(A)
            room.flush()
            B.project.userEditingManager.audioUnit.edit(unitAt(B, created.address.uuid).editing)
            room.flush()
            A.project.editing.undo()
            await healthy()
        })

        it("a preview and a running take do not revert each other", async () => {
            const take = A.sync.createLayer("take")
            const tracks = tracksOf(unit).length
            take.run(() => A.project.editing.modify(() => {
                A.project.api.createNoteTrack(unit)
            }, false))
            const {layer, pick} = await preview(A, unit)
            pick()
            layer.revert()
            expect(tracksOf(unit).length).toBe(tracks + 1)
            take.publish()
            await healthy()
            expect(tracksOf(unitAt(B, unit.address.uuid)).length).toBe(tracks + 1)
        })
    })

    describe("recording", () => {
        let unit: AudioUnitBox
        beforeEach(() => {
            unit = addInstrument(A)
            room.flush()
        })

        it("sends nothing until the take stops", async () => {
            const take = await armMidi(A, unit, clock)
            const before = A.sent
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(1.0)
            expect(regionsOf(unit).length).toBe(1)
            expect(A.sent).toBe(before)
            expect(regionsOf(unitAt(B, unit.address.uuid)).length).toBe(0)
        })

        it("one take is one message and every peer gets it whole", async () => {
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(0.5)
            take.note(64)
            take.advance(1.0)
            const before = A.sent
            take.stop()
            expect(A.sent).toBe(before + 1)
            await healthy()
            const remote = regionsOf(unitAt(C, unit.address.uuid))
            expect(remote.length).toBe(1)
            expect(asInstanceOf(remote[0], NoteRegionBox).events.targetVertex.unwrap().box.pointerHub.incoming().length).toBeGreaterThan(0)
        })

        it("peers keep editing during a take", async () => {
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            const other = addInstrument(B)
            room.flush()
            expect(A.graph.findBox(other.address.uuid).nonEmpty()).toBe(true)
            take.advance(1.0)
            take.stop()
            await healthy()
        })

        it("the recording user can edit elsewhere and it publishes right away", async () => {
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            const before = A.sent
            addInstrument(A)
            expect(A.sent).toBe(before + 1)
            take.stop()
            await healthy()
        })

        it("two peers record the same unit and both takes survive", async () => {
            const takeA = await armMidi(A, unit, clock)
            const takeB = await armMidi(B, unitAt(B, unit.address.uuid), clock)
            await takeA.start()
            await takeB.start()
            takeA.advance(0.1)
            takeB.advance(0.1)
            takeA.note(60)
            takeB.note(62)
            takeA.advance(1.0)
            takeB.advance(1.0)
            takeA.stop()
            takeB.stop()
            await healthy()
            expect(regionsOf(unitAt(C, unit.address.uuid)).length).toBe(2)
            const tracks = tracksOf(unitAt(C, unit.address.uuid))
            expect(tracks.filter(track => track.regions.pointerHub.nonEmpty()).length).toBe(2)
        })

        it("a take lands on its own track, a peer's region on the empty one cannot overlap it", async () => {
            const track = A.project.editing.modify(() => A.project.api.createNoteTrack(unit)).unwrap()
            room.flush()
            const tracks = tracksOf(unit).length
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(2.0)
            B.project.editing.modify(() => B.project.api.createTrackRegion(
                B.graph.findBox<TrackBox>(track.address.uuid).unwrap(), 0, 960))
            room.flush()
            take.stop()
            await healthy()
            expect(tracksOf(unitAt(C, unit.address.uuid)).length).toBe(tracks + 1)
            expect(regionsOf(unitAt(C, unit.address.uuid)).length).toBe(2)
        })

        it("a take survives a peer deleting another track of the unit", async () => {
            const track = A.project.editing.modify(() => A.project.api.createNoteTrack(unit)).unwrap()
            room.flush()
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(1.0)
            B.project.editing.modify(() => B.graph.findBox<TrackBox>(track.address.uuid).unwrap().delete())
            room.flush()
            expect(regionsOf(unit).length).toBe(1)
            take.advance(1.0)
            take.stop()
            await healthy()
            expect(regionsOf(unitAt(C, unit.address.uuid)).length).toBe(1)
        })

        it("a peer deleting the whole unit ends the take and leaves the room healthy", async () => {
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(1.0)
            B.project.editing.modify(() => B.project.api.deleteAudioUnit(unitAt(B, unit.address.uuid)))
            room.flush()
            expect(A.graph.findBox(unit.address.uuid).isEmpty()).toBe(true)
            take.advance(1.0)
            take.stop()
            await healthy()
        })

        it("a disconnected recorder publishes when it is back", async () => {
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(1.0)
            room.disconnect(A)
            take.stop()
            room.flush()
            expect(regionsOf(unitAt(B, unit.address.uuid)).length).toBe(0)
            await healthy()
            expect(regionsOf(unitAt(B, unit.address.uuid)).length).toBe(1)
        })

        it("undo after the take removes it for everyone", async () => {
            const take = await armMidi(A, unit, clock)
            await take.start()
            take.advance(0.1)
            take.note(60)
            take.advance(1.0)
            take.stop()
            A.project.editing.mark()
            room.flush()
            A.project.editing.undo()
            await healthy()
            expect(regionsOf(unitAt(B, unit.address.uuid)).length).toBe(0)
        })

        it("each take is its own undo step", async () => {
            const count = () => regionsOf(unitAt(B, unit.address.uuid)).length
            for (let index = 0; index < 2; index++) {
                const take = await armMidi(A, unit, clock)
                await take.start()
                take.advance(0.1)
                take.note(60)
                take.advance(1.0)
                take.stop()
                A.worklet.recordingStart.clear()
            }
            room.flush()
            expect(count()).toBe(2)
            A.project.editing.undo()
            room.flush()
            expect(count()).toBe(1)
            A.project.editing.undo()
            room.flush()
            expect(count()).toBe(0)
            A.project.editing.redo()
            await healthy()
            expect(count()).toBe(1)
        })

        it("waits for the audio to be saved before peers get an audio take", async () => {
            const {RecordAudio} = await import("../capture/RecordAudio")
            const saved = {run: () => {}}
            const sink = {
                uuid: UUID.generate(), firstQuantumTime: Option.wrap(0), numberOfFrames: 48_000, limit: () => {}, terminate: () => {},
                setFillLength: () => {}, disconnect: () => {}, set onSaved(callback: () => void) {saved.run = callback}
            } as unknown as RecordingSink
            const recorded: Array<unknown> = []
            const capture = {
                audioUnitBox: unit, prepareRecording: async () => {}, clearRecordedRegions: () => {},
                addRecordedRegion: (region: unknown) => recorded.push(region), recordedRegions: () => recorded,
                startRecording: () => RecordAudio.start({
                    sink, project: A.project, capture: capture as unknown as Capture,
                    sampleManager: {remove: () => {}} as never,
                    readLatency: () => ({outputLatency: 0, inputLatency: 0})
                })
            }
            vi.spyOn(A.project.captureDevices, "filterArmed").mockReturnValue([capture as unknown as Capture])
            await A.project.recordingSession.start(false)
            A.worklet.recordingStart.wrap({contextTime: 0, position: 0})
            A.worklet.isRecording.setValue(true)
            A.worklet.position.setValue(1)
            const before = A.sent
            A.worklet.isRecording.setValue(false)
            room.flush()
            expect(A.sent).toBe(before)
            expect(regionsOf(unitAt(B, unit.address.uuid)).length).toBe(0)
            saved.run()
            expect(A.sent).toBe(before + 1)
            await healthy()
            expect(regionsOf(unitAt(B, unit.address.uuid)).length).toBe(1)
        })
    })

})

describe("LiveRoom repairs", () => {
    let room: LiveRoom
    let A: RoomPeer
    let B: RoomPeer

    beforeEach(async () => {
        vi.spyOn(console, "debug").mockImplementation(() => {})
        room = await LiveRoom.create(["A", "B"])
        ;[A, B] = room.peers
        room.flush()
    })
    afterEach(() => {
        room.terminate()
        vi.restoreAllMocks()
    })

    it("two peers adding an instrument at once share an index without a rejection", async () => {
        addInstrument(A)
        addInstrument(B)
        room.flush()
        expect(room.violations()).toEqual([])
        expect(uniqueUnitIndices(A)).toBe(false)
        expect(await room.lateJoinerDiffers()).toBe(false)
    })

    it("undo of a delete after a peer brought the box back keeps every edge", async () => {
        const unit = addInstrument(A)
        room.flush()
        room.disconnect(B)
        A.project.editing.undo()
        A.project.editing.redo()
        B.project.editing.modify(() => B.project.api.deleteAudioUnit(unitAt(B, unit.address.uuid)))
        room.reconnect(B)
        room.flush()
        expect(B.graph.findBox(unit.address.uuid).nonEmpty()).toBe(true)
        B.project.editing.undo()
        expect(room.violations()).toEqual([])
        expect(await room.lateJoinerDiffers()).toBe(false)
    })

    it("concurrent writes to one field converge on one winner", () => {
        const unit = addInstrument(A)
        room.flush()
        const remote = unitAt(B, unit.address.uuid)
        A.project.editing.modify(() => unit.volume.setValue(-3))
        B.project.editing.modify(() => remote.volume.setValue(-6))
        expect(room.violations()).toEqual([])
        expect(unit.volume.getValue()).toBe(remote.volume.getValue())
    })

    it("a write crossing a delete of its box leaves no trace", () => {
        const unit = addInstrument(A)
        room.flush()
        const remote = unitAt(B, unit.address.uuid)
        A.project.editing.modify(() => A.project.api.deleteAudioUnit(unit))
        B.project.editing.modify(() => remote.volume.setValue(-6))
        expect(room.violations()).toEqual([])
    })

    it("undo crossing a peer's edit on the created box does not split the room", () => {
        const unit = addInstrument(A)
        room.flush()
        const remote = unitAt(B, unit.address.uuid)
        const track = B.project.editing.modify(() => B.project.api.createNoteTrack(remote)).unwrap()
        room.flush()
        A.project.editing.undo()
        expect(room.violations()).toEqual([])
        expect(A.graph.findBox(track.address.uuid).nonEmpty() === B.graph.findBox(track.address.uuid).nonEmpty()).toBe(true)
    })
})

describe("LiveRoom recreated boxes", () => {
    it("a box recreated under its key brings its new values to everyone", async () => {
        vi.spyOn(console, "debug").mockImplementation(() => {})
        const room = await LiveRoom.create(["A", "B"])
        const [A, B] = room.peers
        room.flush()
        const unit = addInstrument(A)
        room.flush()
        A.project.editing.modify(() => unit.volume.setValue(-9))
        A.project.editing.undo()
        A.project.editing.undo()
        room.flush()
        B.project.editing.modify(() => B.project.api.createInstrument(InstrumentFactories.Nano))
        A.project.editing.redo()
        expect(room.violations()).toEqual([])
        room.terminate()
        vi.restoreAllMocks()
    })
})

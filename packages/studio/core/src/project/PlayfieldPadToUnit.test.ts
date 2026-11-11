import {describe, expect, it} from "vitest"
import {asInstanceOf, isDefined, isInstanceOf, Option, Terminable, UUID} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    CompressorDeviceBox,
    DelayDeviceBox,
    InstrumentCompositeBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    PlayfieldDeviceBox,
    TrackBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, soundfontManager: undefined, sampleService: undefined,
    soundfontService: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    }
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project} = await import("./Project")
    const project: Project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const {boxGraph, api, editing} = project
    const built = editing.modify(() => {
        const {audioUnitBox, instrumentBox, trackBox} = api.createInstrument(InstrumentFactories.Playfield)
        const playfield = asInstanceOf(instrumentBox, PlayfieldDeviceBox)
        const {cellBox} = api.createPlayfieldPad(playfield, 38, InstrumentFactories.Vaporisateur).result()
        cellBox.key.setValue(62)
        cellBox.gain.setValue(-6)
        cellBox.pan.setValue(0.25)
        cellBox.mute.setValue(true)
        const delay = DelayDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(cellBox.audioEffects))
        const gainLane = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(cellBox.gain)
            box.type.setValue(TrackType.Value)
            box.index.setValue(1)
        })
        const delayLane = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(delay.feedback)
            box.type.setValue(TrackType.Value)
            box.index.setValue(2)
        })
        const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        const note = (pitch: number, position: number) => NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.events.refer(collection.events)
            box.position.setValue(position)
            box.duration.setValue(240)
            box.pitch.setValue(pitch)
        })
        note(36, 0)
        note(38, 480)
        note(38, 960)
        const region = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(trackBox.regions)
            box.events.refer(collection.owners)
            box.position.setValue(3840)
            box.duration.setValue(3840)
            box.loopDuration.setValue(1920)
        })
        const compressor = CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(audioUnitBox.audioEffects)
            box.sideChain.refer(cellBox)
        })
        return {audioUnitBox, playfield, cellBox, delay, gainLane, delayLane, collection, region, compressor}
    }).unwrap()
    return {project, ...built}
}

const units = (project: Project): ReadonlyArray<AudioUnitBox> => IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits)
    .filter((box): box is AudioUnitBox => isInstanceOf(box, AudioUnitBox))

describe("PlayfieldPadToUnit", () => {
    it("moves a pad with its chain, mix, automation, sidechain and notes to a unit next to the Playfield", async () => {
        const {project, audioUnitBox, playfield, cellBox, delay, gainLane, delayLane, collection, region, compressor} = await setup()
        const before = units(project).length
        const unit = project.editing.modify(() => project.api.movePadToUnit(cellBox).result()).unwrap()
        expect(units(project)).toHaveLength(before + 1)
        expect(units(project).indexOf(unit)).toBe(units(project).indexOf(audioUnitBox) + 1)
        expect(cellBox.isAttached()).toBe(false)
        expect(playfield.pads.pointerHub.incoming()).toHaveLength(0)
        expect(isInstanceOf(unit.input.pointerHub.incoming()[0].box, VaporisateurDeviceBox)).toBe(true)
        expect(delay.host.targetVertex.unwrap().address.toString()).toBe(unit.audioEffects.address.toString())
        expect([unit.volume.getValue(), unit.panning.getValue(), unit.mute.getValue()]).toEqual([-6, 0.25, true])
        expect(gainLane.tracks.targetVertex.unwrap().box).toBe(unit)
        expect(gainLane.target.targetVertex.unwrap().address.toString()).toBe(unit.volume.address.toString())
        expect(delayLane.tracks.targetVertex.unwrap().box).toBe(unit)
        expect(compressor.sideChain.targetVertex.unwrap().box).toBe(unit)
        const pitches = (owner: NoteEventCollectionBox) => owner.events.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, NoteEventBox).pitch.getValue())
        expect(pitches(collection)).toEqual([36])
        const noteTrack = IndexedBox.collectIndexedBoxes(unit.tracks)
            .map(box => asInstanceOf(box, TrackBox)).find(track => track.type.getValue() === TrackType.Notes)
        const moved = asInstanceOf(noteTrack?.regions.pointerHub.incoming()[0].box, NoteRegionBox)
        expect([moved.position.getValue(), moved.duration.getValue(), moved.loopDuration.getValue()])
            .toEqual([region.position.getValue(), region.duration.getValue(), region.loopDuration.getValue()])
        const movedCollection = asInstanceOf(moved.events.targetVertex.unwrap().box, NoteEventCollectionBox)
        expect(pitches(movedCollection)).toEqual([62, 62])
    })

    it("places the new unit where a drop names it", async () => {
        const {project, cellBox} = await setup()
        const {api, editing} = project
        const first = units(project)[0]
        const unit = editing.modify(() =>
            api.movePadToUnit(cellBox, Option.wrap(api.insertionBefore(Option.wrap(first.address.uuid)))).result()).unwrap()
        expect(units(project).indexOf(unit)).toBe(units(project).indexOf(first) - 1)
        expect(cellBox.isAttached()).toBe(false)
    })

    it("refuses a cell that is no pad or holds no instrument", async () => {
        const {project, cellBox} = await setup()
        project.editing.modify(() => cellBox.instrument.pointerHub.incoming().forEach(({box}) => box.delete()))
        const attempt = project.editing.modify(() => project.api.movePadToUnit(cellBox)).unwrap()
        expect(attempt.isFailure()).toBe(true)
        expect(cellBox.isAttached()).toBe(true)
        const layer = project.editing.modify(() => {
            const composite = asInstanceOf(project.api.createInstrument(InstrumentFactories.InstrumentComposite).instrumentBox, InstrumentCompositeBox)
            return project.api.createCompositeLayer(composite, InstrumentFactories.Nano).result().cellBox
        }).unwrap()
        expect(project.editing.modify(() => project.api.movePadToUnit(layer)).unwrap().isFailure()).toBe(true)
    })
})

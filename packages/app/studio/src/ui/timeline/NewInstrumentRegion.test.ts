import {describe, expect, it, vi} from "vitest"
import {asDefined, DefaultObservableValue, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioUnitGroups, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {StudioPreferences, TimelineRange} from "@opendaw/studio-core"
import {NewInstrumentRegion} from "./NewInstrumentRegion"
import {Snapping} from "./Snapping"
import {DefaultInstrumentFactory} from "@/ui/defaults/DefaultInstrumentFactory"
import type {StudioService} from "@/service/StudioService"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const setup = async (position: number = 0, playing: boolean = false) => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project: Project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
    vi.spyOn(project.engine, "position", "get").mockReturnValue(new DefaultObservableValue(position))
    vi.spyOn(project.engine, "isPlaying", "get").mockReturnValue(new DefaultObservableValue(playing))
    return project
}

const regionsOf = (audioUnitBox: AudioUnitBox): ReadonlyArray<NoteRegionBox> =>
    audioUnitBox.tracks.pointerHub.incoming()
        .flatMap(({box}) => (box as TrackBox).regions.pointerHub.incoming().map(pointer => pointer.box))
        .filter((box): box is NoteRegionBox => box instanceof NoteRegionBox)

const barSnapping = (project: Project): Snapping => {
    const snapping = new Snapping(new TimelineRange({padding: 0}))
    snapping.registerSignatureTrackAdapter(project.timelineBoxAdapter.signatureTrack)
    snapping.index = snapping.units.findIndex(unit => unit.name === "Bar")
    return snapping
}

const createWithRegion = (project: Project, snapping: Snapping = barSnapping(project)): AudioUnitBox =>
    project.editing.modify(() => {
        const {audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
        NewInstrumentRegion.create(project, snapping, audioUnitBox)
        return audioUnitBox
    }).unwrap()

describe("NewInstrumentRegion", () => {
    it("creates one bar at the song position, selected and in edit mode", async () => {
        const project = await setup(PPQN.Bar * 2)
        const audioUnitBox = createWithRegion(project)
        const regions = regionsOf(audioUnitBox)
        expect(regions.length).toBe(1)
        const [region] = regions
        expect(region.position.getValue()).toBe(PPQN.Bar * 2)
        expect(region.duration.getValue()).toBe(PPQN.Bar)
        expect(project.selection.isSelected(region)).true
        expect(project.userEditingManager.timeline.isEditing(region)).true
    })

    it("keeps group-aware instrument insertion and upstream automatic regions in one undo step", async () => {
        const project = await setup(PPQN.Bar)
        const first = project.editing.modify(() => project.api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox).unwrap()
        const group = asDefined(project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap())
        project.trackSelection.set([first])
        const service = {project, timeline: {snapping: barSnapping(project)}} as StudioService
        project.editing.modify(() => DefaultInstrumentFactory.create(service, InstrumentFactories.Neon))
        const [added] = project.trackSelection.selected
        expect(AudioUnitGroups.children(project.rootBox, group)).toEqual([first, added])
        expect(added.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(group).unwrapOrUndefined())
        expect(regionsOf(added).map(region => region.position.getValue())).toEqual([PPQN.Bar])
        expect(project.editing.undo()).true
        expect(added.isAttached()).false
        expect(AudioUnitGroups.children(project.rootBox, group)).toEqual([first])
        project.boxGraph.verifyPointers()
        project.terminate()
    })

    it("floors the song position to the snap unit", async () => {
        const project = await setup(PPQN.Bar * 2 + PPQN.Quarter * 3 + 17)
        const [atBar] = regionsOf(createWithRegion(project))
        expect(atBar.position.getValue()).toBe(PPQN.Bar * 2)
        const quarter = barSnapping(project)
        quarter.index = quarter.units.findIndex(unit => unit.name === "1/4")
        const [atQuarter] = regionsOf(createWithRegion(project, quarter))
        expect(atQuarter.position.getValue()).toBe(PPQN.Bar * 2 + PPQN.Quarter * 3)
    })

    it("deselects the regions selected before", async () => {
        const project = await setup()
        const first = regionsOf(createWithRegion(project))[0]
        const second = regionsOf(createWithRegion(project))[0]
        expect(project.selection.isSelected(first)).false
        expect(project.selection.isSelected(second)).true
    })

    it("is one undo step with the instrument", async () => {
        const project = await setup()
        const audioUnitBox = createWithRegion(project)
        project.editing.undo()
        expect(audioUnitBox.isAttached()).false
    })

    it("does nothing while the transport is running", async () => {
        const project = await setup(0, true)
        expect(regionsOf(createWithRegion(project)).length).toBe(0)
    })

    it("does nothing when the preference is off", async () => {
        const project = await setup()
        StudioPreferences.settings.editing["new-instrument-note-region"] = false
        const audioUnitBox = createWithRegion(project)
        StudioPreferences.settings.editing["new-instrument-note-region"] = true
        expect(regionsOf(audioUnitBox).length).toBe(0)
    })

    it("does nothing when the unit already has a region", async () => {
        const project = await setup()
        const audioUnitBox = createWithRegion(project)
        project.editing.modify(() => NewInstrumentRegion.create(project, barSnapping(project), audioUnitBox))
        expect(regionsOf(audioUnitBox).length).toBe(1)
    })
})

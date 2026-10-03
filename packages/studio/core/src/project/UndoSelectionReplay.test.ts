import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {PPQN} from "@opendaw/lib-dsp"
import {
    AudioUnitBoxAdapter,
    InstrumentFactories,
    InstrumentFactory,
    ProjectSkeleton,
    TrackBoxAdapter,
    TrackType
} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {AudioContentFactory} from "./audio/AudioContentFactory"
import type {ProjectEnv} from "./ProjectEnv"

// Live error 1159: "SelectionBox <uuid> could not be found to unstage" from a rubber-band deselect after a chain of
// 9 undos. VertexSelection only goes stale when a transaction that deleted a selected SelectionBox rolls back, and a
// failed undo step rolls back silently (toast only). These tests replay the session's operations with a selection in
// place and require every undo and redo to succeed, so the step that rolls back shows up as a failing assertion.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    project.follow(skeleton.mandatoryBoxes.userInterfaceBoxes[0])
    const {editing, boxGraph, boxAdapters, api, selection} = project
    const history: Array<string> = []
    const failures: Array<string> = []
    const step = (label: string, procedure: () => void): void => {
        history.push(label)
        editing.modify(procedure)
    }
    const undo = (): void => {
        if (editing.canUndo() && !editing.undo()) {failures.push(`undo after [${history.join(", ")}]`)}
    }
    const redo = (): void => {
        if (editing.canRedo() && !editing.redo()) {failures.push(`redo after [${history.join(", ")}]`)}
    }
    const live = <B extends Box>(box: B): B => boxGraph.findBox<B>(box.address.uuid).unwrap("box is gone")
    const unitAdapter = (box: AudioUnitBox) => boxAdapters.adapterFor(live(box), AudioUnitBoxAdapter)
    const trackAdapter = (box: TrackBox) => boxAdapters.adapterFor(live(box), TrackBoxAdapter)
    const addTape = (): {audioUnitBox: AudioUnitBox, trackBox: TrackBox} => {
        const {audioUnitBox, trackBox} = editing.modify(() => api.createInstrument(InstrumentFactories.Tape)).unwrap()
        editing.modify(() => {
            const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
                box.fileName.setValue("sample.mp3")
                box.endInSeconds.setValue(4.0)
            })
            AudioContentFactory.createNotStretchedRegion({
                boxGraph, targetTrack: trackBox, audioFileBox, position: 0,
                sample: {
                    uuid: UUID.toString(audioFileBox.address.uuid), name: "sample.mp3",
                    duration: 4.0, bpm: 0.0, sample_rate: 48000, origin: "import"
                }
            })
        })
        return {audioUnitBox, trackBox}
    }
    const addInstrument = (factory: InstrumentFactory<any, any>): {audioUnitBox: AudioUnitBox, trackBox: TrackBox} => {
        const {audioUnitBox, trackBox} = editing.modify(() => api.createInstrument(factory)).unwrap()
        editing.modify(() => api.createNoteRegion({trackBox, position: 0, duration: PPQN.Bar}))
        return {audioUnitBox, trackBox}
    }
    const addAutomation = (audioUnitBox: AudioUnitBox): TrackBox => {
        const trackBox = editing.modify(() => api.createAutomationTrack(audioUnitBox, audioUnitBox.volume as any)).unwrap()
        editing.modify(() => api.createTrackRegion(trackBox, 0, PPQN.Bar))
        return trackBox
    }
    const selectRegions = (trackBox: TrackBox): void => {
        const track = trackAdapter(trackBox)
        selection.select(...track.regions.collection.asArray().map(region => region.box))
    }
    const selectAllRegions = (): void => {
        project.rootBoxAdapter.audioUnits.adapters().forEach(unit => unit.tracks.collection.adapters()
            .forEach(track => selection.select(...track.regions.collection.asArray().map(region => region.box))))
    }
    const stale = (): ReadonlyArray<string> => selection.selected()
        .filter(selectable => !selectable.isAttached()).map(selectable => selectable.address.toString())
    return {
        project, editing, api, selection, history, failures, step, undo, redo,
        unitAdapter, trackAdapter, live, addTape, addInstrument, addAutomation, selectRegions, selectAllRegions, stale
    }
}

describe("undo chains with a selection (live 1159)", () => {
    it("delete a Tape unit with a selected audio region and automation, undo, redo", async () => {
        const ctx = await setup()
        const tape = ctx.addTape()
        const automation = ctx.addAutomation(tape.audioUnitBox)
        ctx.selectRegions(tape.trackBox)
        ctx.selectRegions(automation)
        ctx.step("delete tape", () => ctx.api.deleteAudioUnit(tape.audioUnitBox))
        ctx.undo()
        ctx.redo()
        ctx.undo()
        expect(ctx.failures).toEqual([])
        expect(ctx.stale()).toEqual([])
        expect(() => ctx.selection.deselectAll()).not.toThrow()
    })

    it("delete an automation track with a selected region, undo, redo", async () => {
        const ctx = await setup()
        const tape = ctx.addTape()
        const automation = ctx.addAutomation(tape.audioUnitBox)
        ctx.selectRegions(automation)
        ctx.step("delete automation track", () => {
            const unit = ctx.unitAdapter(tape.audioUnitBox)
            unit.deleteTrack(ctx.trackAdapter(automation))
        })
        ctx.undo()
        ctx.redo()
        ctx.undo()
        expect(ctx.failures).toEqual([])
        expect(ctx.stale()).toEqual([])
        expect(() => ctx.selection.deselectAll()).not.toThrow()
    })

    it.each([
        ["Tape", InstrumentFactories.Tape],
        ["Composite", InstrumentFactories.InstrumentComposite],
        ["Soundfont", InstrumentFactories.Soundfont],
        ["Playfield", InstrumentFactories.Playfield],
        ["Apparat", InstrumentFactories.Apparat],
        ["Vaporisateur", InstrumentFactories.Vaporisateur]
    ] as const)("delete a %s unit with a selected region, undo, redo", async (_name, factory) => {
        const ctx = await setup()
        const unit = factory === InstrumentFactories.Tape ? ctx.addTape() : ctx.addInstrument(factory)
        ctx.addAutomation(unit.audioUnitBox)
        ctx.selectAllRegions()
        ctx.step("delete unit", () => ctx.api.deleteAudioUnit(unit.audioUnitBox))
        ctx.undo()
        ctx.redo()
        ctx.undo()
        expect(ctx.failures).toEqual([])
        expect(ctx.stale()).toEqual([])
        expect(() => ctx.selection.deselectAll()).not.toThrow()
    })

    it("replays the 1159 session: units, automation, deletes, undo chains, rubber-band deselect", async () => {
        const ctx = await setup()
        const tapeA = ctx.addTape()
        const tapeB = ctx.addTape()
        ctx.selectRegions(tapeA.trackBox)
        const automationB = ctx.addAutomation(tapeB.audioUnitBox)
        ctx.selectRegions(automationB)
        ctx.step("delete tape A", () => ctx.api.deleteAudioUnit(ctx.live(tapeA.audioUnitBox)))
        ctx.undo()
        ctx.selectAllRegions()
        ctx.step("delete automation B", () => ctx.unitAdapter(tapeB.audioUnitBox)
            .deleteTrack(ctx.trackAdapter(automationB)))
        for (let index = 0; index < 8; index++) {ctx.undo()}
        const units = [
            ctx.addTape(),
            ctx.addInstrument(InstrumentFactories.InstrumentComposite),
            ctx.addInstrument(InstrumentFactories.Soundfont),
            ctx.addInstrument(InstrumentFactories.Playfield),
            ctx.addInstrument(InstrumentFactories.Apparat)
        ]
        ctx.selectAllRegions()
        units.slice(1).forEach((unit, index) =>
            ctx.step(`delete unit ${index + 1}`, () => ctx.api.deleteAudioUnit(ctx.live(unit.audioUnitBox))))
        const automation = ctx.addAutomation(ctx.live(units[0].audioUnitBox))
        ctx.selectRegions(automation)
        const audioTrack = ctx.editing.modify(() => ctx.api.createAudioTrack(ctx.live(units[0].audioUnitBox))).unwrap()
        ctx.step("delete tape", () => ctx.api.deleteAudioUnit(ctx.live(units[0].audioUnitBox)))
        ctx.undo()
        ctx.step("delete audio track", () => ctx.unitAdapter(units[0].audioUnitBox)
            .deleteTrack(ctx.trackAdapter(audioTrack)))
        for (let index = 0; index < 3; index++) {ctx.undo()}
        ctx.selectAllRegions()
        for (let index = 0; index < 9; index++) {ctx.undo()}
        expect(ctx.failures).toEqual([])
        expect(ctx.stale()).toEqual([])
        expect(() => ctx.selection.deselectAll()).not.toThrow()
    })
})

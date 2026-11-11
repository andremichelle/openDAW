import {describe, expect, it} from "vitest"
import {asInstanceOf, isDefined, isInstanceOf, Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, PlayfieldPads, ProjectSkeleton} from "@opendaw/studio-adapters"
import {DelayDeviceBox, PlayfieldDeviceBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../../../project/ProjectEnv"
import type {Project} from "../../../project/Project"
import {PadsClipboard} from "./PadsClipboard"

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

const createProject = async (): Promise<Project> => {
    const {Project} = await import("../../../project/Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const createPlayfield = (project: Project): PlayfieldDeviceBox => project.editing.modify(() =>
    asInstanceOf(project.api.createInstrument(InstrumentFactories.Playfield).instrumentBox, PlayfieldDeviceBox)).unwrap()

describe("PadsClipboard", () => {
    it("copies a pad as an audio unit that pastes onto another pad, replacing it", async () => {
        const project = await createProject()
        const {editing, api, boxGraph} = project
        const {playfield, unit} = editing.modify(() => {
            const {instrumentBox, audioUnitBox} = api.createInstrument(InstrumentFactories.Playfield)
            return {playfield: asInstanceOf(instrumentBox, PlayfieldDeviceBox), unit: audioUnitBox}
        }).unwrap()
        const source = editing.modify(() => {
            const {cellBox} = api.createPlayfieldPad(playfield, 38, InstrumentFactories.Vaporisateur).result()
            cellBox.gain.setValue(-6)
            cellBox.pan.setValue(0.25)
            DelayDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(cellBox.audioEffects))
            api.createPlayfieldPad(playfield, 40, InstrumentFactories.Nano)
            return cellBox
        }).unwrap()
        const before = boxGraph.boxes().length
        const entry = PadsClipboard.copyEntry(source, unit).unwrap()
        expect(entry.type).toBe("audio-units")
        expect(boxGraph.boxes().length, "copying leaves the project untouched").toBe(before)
        const pasted = editing.modify(() => api.pasteAudioUnitAsPad(playfield, 40, entry.data).result().cellBox).unwrap()
        expect(PlayfieldPads.padsOf(playfield)).toHaveLength(2)
        expect([pasted.index.getValue(), pasted.gain.getValue(), pasted.pan.getValue()]).toEqual([40, -6, 0.25])
        expect(isInstanceOf(pasted.instrument.pointerHub.incoming()[0].box, VaporisateurDeviceBox)).toBe(true)
        expect(pasted.audioEffects.pointerHub.incoming()).toHaveLength(1)
        expect(source.audioEffects.pointerHub.incoming()).toHaveLength(1)
    })

    it("pastes a copied pad onto a pad in another project", async () => {
        const sourceProject = await createProject()
        const {unit, cell} = sourceProject.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = sourceProject.api.createInstrument(InstrumentFactories.Playfield)
            const playfield = asInstanceOf(instrumentBox, PlayfieldDeviceBox)
            return {unit: audioUnitBox, cell: sourceProject.api.createPlayfieldPad(playfield, 36, InstrumentFactories.Nano).result().cellBox}
        }).unwrap()
        const entry = PadsClipboard.copyEntry(cell, unit).unwrap()
        const target = await createProject()
        const playfield = createPlayfield(target)
        const pasted = target.editing.modify(() => target.api.pasteAudioUnitAsPad(playfield, 48, entry.data).result().cellBox).unwrap()
        expect(pasted.index.getValue()).toBe(48)
        expect(PlayfieldPads.nanoBoxOf(pasted).nonEmpty()).toBe(true)
    })

    it("copies nothing from an empty pad", async () => {
        const project = await createProject()
        const {unit, cell} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createInstrument(InstrumentFactories.Playfield)
            return {unit: audioUnitBox, cell: PlayfieldPads.createCell(project.boxGraph, asInstanceOf(instrumentBox, PlayfieldDeviceBox), 36)}
        }).unwrap()
        expect(PadsClipboard.copyEntry(cell, unit).isEmpty()).toBe(true)
    })
})

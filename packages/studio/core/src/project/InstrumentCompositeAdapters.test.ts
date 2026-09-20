import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    AudioEffectCompositeCellBoxAdapter, AudioUnitBoxAdapter, DeviceHost, Devices,
    InstrumentCompositeBoxAdapter, InstrumentCompositeCellBoxAdapter, InstrumentFactories, ProjectSkeleton, TrackType
} from "@opendaw/studio-adapters"
import {
    AudioEffectCompositeBox, AudioEffectCompositeCellBox, AudioUnitBox, DelayDeviceBox, InstrumentCompositeBox,
    InstrumentCompositeCellBox, NanoDeviceBox, NoteClipBox, NoteEventCollectionBox, PitchDeviceBox, TrackBox
} from "@opendaw/studio-boxes"
import {Box} from "@opendaw/lib-box"
import {DevicesClipboard} from "../ui/clipboard/types/DevicesClipboardHandler"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const lane = (project: Project, audioUnitBox: AudioUnitBox, nano: NanoDeviceBox): TrackBox =>
    TrackBox.create(project.boxGraph, UUID.generate(), box => {
        box.tracks.refer(audioUnitBox.tracks)
        box.target.refer(nano.volume)
        box.type.setValue(TrackType.Value)
        box.index.setValue(1)
    })

const firstLayer = (project: Project, composite: InstrumentCompositeBox): InstrumentCompositeCellBoxAdapter =>
    project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).cells.adapters()[0]

// A LAYER of an Instrument Composite is a full DeviceHost: it hosts an instrument plus both effect chains, the way
// an audio unit does, and leads back to the unit the composite lives in.
describe("Instrument Composite adapters", () => {
    it("the factory creates an empty composite, a layer is always created with its instrument", async () => {
        const project = await createProject()
        const {instrumentBox, audioUnitBox} = project.editing.modify(() =>
            project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)).unwrap()
        const composite = project.boxAdapters.adapterFor(instrumentBox, InstrumentCompositeBoxAdapter)
        expect(Devices.isInstrument(composite)).toBe(true)
        expect(composite.cells.adapters().length, "layers are added with their instrument").toBe(0)
        expect(composite.deviceHost().address.toString()).toStrictEqual(audioUnitBox.address.toString())
        const {cellBox, instrumentBox: synth} = project.editing.modify(() =>
            project.api.createCompositeLayer(composite.box, InstrumentFactories.Vaporisateur).result()).unwrap()
        const layer = composite.cells.adapters()[0]
        expect(layer.address.toString()).toStrictEqual(cellBox.address.toString())
        expect(layer.label).toBe("Vaporisateur")
        expect(layer.hostsInstrument).toBe(true)
        expect(layer.inputAdapter.unwrap("layer instrument").address.toString()).toStrictEqual(synth.address.toString())
        expect(layer.isAudioUnit).toBe(false)
        expect(layer.compositeDevice().address.toString()).toStrictEqual(composite.address.toString())
        project.editing.modify(() => project.api.createCompositeLayer(composite.box, InstrumentFactories.Nano).result())
        expect(composite.cells.adapters().map(cell => [cell.label, cell.indexField.getValue()]))
            .toStrictEqual([["Vaporisateur", 0], ["Nano", 1]])
        project.terminate()
    })

    it("only note instruments the engine can build in a layer are accepted", async () => {
        const project = await createProject()
        const {instrumentBox} = project.editing.modify(() =>
            project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)).unwrap()
        const composite = instrumentBox as InstrumentCompositeBox
        project.editing.modify(() => {
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.Tape).isFailure()).toBe(true)
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.MIDIOutput).isFailure()).toBe(true)
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.Playfield).isSuccess()).toBe(true)
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.InstrumentComposite).isSuccess()).toBe(true)
        })
        expect(composite.cells.pointerHub.incoming().length, "a rejected factory creates nothing").toBe(2)
        project.terminate()
    })

    it("replacing a layer's instrument keeps the layer and its effects", async () => {
        const project = await createProject()
        const {composite, cellBox, delay} = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            const {cellBox} = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const delay = DelayDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cellBox.audioEffects)
                box.index.setValue(0)
            })
            return {composite, cellBox, delay}
        }).unwrap()
        const layer = firstLayer(project, composite)
        const before = layer.inputAdapter.unwrap("before").address.toString()
        const replaced = project.editing.modify(() =>
            project.api.setLayerInstrument(cellBox, InstrumentFactories.Nano).result()).unwrap()
        expect(firstLayer(project, composite).address.toString(), "the layer survives").toStrictEqual(cellBox.address.toString())
        expect(layer.inputAdapter.unwrap("after").address.toString()).toStrictEqual(replaced.address.toString())
        expect(layer.inputAdapter.unwrap("after").address.toString()).not.toStrictEqual(before)
        expect(layer.audioEffects.unwrap("audio").adapters().map(effect => effect.uuid)).toStrictEqual([delay.address.uuid])
        // Like an audio unit, a layer survives losing its instrument. It then takes no midi effect (no note consumer).
        project.editing.modify(() => replaced.delete())
        expect(firstLayer(project, composite).address.toString()).toStrictEqual(cellBox.address.toString())
        expect(layer.inputAdapter.isEmpty()).toBe(true)
        expect(DeviceHost.takesEffect(layer, "midi")).toBe(false)
        expect(DeviceHost.takesEffect(layer, "audio")).toBe(true)
        const refilled = project.editing.modify(() =>
            project.api.setLayerInstrument(cellBox, InstrumentFactories.Vaporisateur).result()).unwrap()
        expect(layer.inputAdapter.unwrap("refilled").address.toString(), "an emptied layer takes a new instrument")
            .toBe(refilled.address.toString())
        project.editing.modify(() =>
            expect(project.api.setLayerInstrument(cellBox, InstrumentFactories.Tape).isFailure()).toBe(true))
        expect(layer.inputAdapter.unwrap("kept").address.toString(), "a rejected factory changes nothing")
            .toBe(refilled.address.toString())
        project.terminate()
    })

    it("deleting a layer removes its devices and closes the gap in the order", async () => {
        const project = await createProject()
        const {composite, first, delay} = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            const first = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            project.api.createCompositeLayer(composite, InstrumentFactories.Nano).result()
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const delay = DelayDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(first.cellBox.audioEffects)
                box.index.setValue(0)
            })
            return {composite, first, delay}
        }).unwrap()
        project.editing.modify(() => project.api.deleteCompositeLayer(first.cellBox))
        const layers = project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).cells.adapters()
        expect(layers.map(layer => [layer.label, layer.indexField.getValue()])).toStrictEqual([["Nano", 0], ["Vaporisateur", 1]])
        expect(first.instrumentBox.isAttached(), "the layer's synth goes with it").toBe(false)
        expect(delay.isAttached(), "and so do its effects").toBe(false)
        expect(composite.isAttached()).toBe(true)
        project.terminate()
    })

    it("a deleted layer's sibling observer still reads the remaining layers", async () => {
        const project = await createProject()
        const composite = project.editing.modify(() => {
            const {instrumentBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur)
            project.api.createCompositeLayer(composite, InstrumentFactories.Nano)
            return composite
        }).unwrap()
        const layer = firstLayer(project, composite)
        const seen: Array<number> = []
        const subscription = layer.subscribeSiblings(siblings => seen.push(siblings.length))
        project.editing.modify(() => project.api.deleteCompositeLayer(layer.box))
        // the removal and the survivor's re-index both notify
        expect(seen).toStrictEqual([1, 1])
        subscription.terminate()
        project.terminate()
    })

    it("a layer deleted from under the editing pointer leaves to the nearest surviving parent", async () => {
        const project = await createProject()
        const {audioUnitBox, outer, inner} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const outer = project.api.createCompositeLayer(composite, InstrumentFactories.InstrumentComposite).result()
            project.api.createCompositeLayer(composite, InstrumentFactories.Nano)
            const inner = project.api.createCompositeLayer(outer.instrumentBox as InstrumentCompositeBox, InstrumentFactories.Vaporisateur).result()
            return {audioUnitBox, outer: outer.cellBox, inner: inner.cellBox}
        }).unwrap()
        const editing = project.userEditingManager.audioUnit
        const editedBox = () => editing.get().map(vertex => vertex.address.toString()).unwrapOrNull()
        editing.edit(inner)
        project.editing.modify(() => project.api.deleteCompositeLayer(inner))
        await Promise.resolve()
        expect(editedBox(), "the parent layer").toBe(outer.address.toString())
        editing.edit(outer)
        project.editing.modify(() => project.api.deleteCompositeLayer(outer))
        await Promise.resolve()
        expect(editedBox(), "the audio unit").toBe(audioUnitBox.editing.address.toString())
        project.terminate()
    })

    it("deleting the whole unit from inside a nested layer leaves nothing to edit", async () => {
        const project = await createProject()
        const {audioUnitBox, cellBox} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const {cellBox} = project.api.createCompositeLayer(instrumentBox as InstrumentCompositeBox, InstrumentFactories.Nano).result()
            return {audioUnitBox, cellBox}
        }).unwrap()
        const editing = project.userEditingManager.audioUnit
        editing.edit(cellBox)
        project.editing.modify(() => audioUnitBox.delete())
        await Promise.resolve()
        expect(editing.get().isEmpty()).toBe(true)
        project.terminate()
    })

    it("pasting an instrument over a layer's instrument leaves the unit's timeline alone (#390)", async () => {
        const project = await createProject()
        const {audioUnitBox, source, target} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const source = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const target = project.api.createCompositeLayer(composite, InstrumentFactories.Apparat).result()
            return {audioUnitBox, source, target}
        }).unwrap()
        const trackBox = audioUnitBox.tracks.pointerHub.incoming()
            .map(pointer => pointer.box).find(box => box instanceof TrackBox) as TrackBox
        const clip = project.editing.modify(() => {
            const events = NoteEventCollectionBox.create(project.boxGraph, UUID.generate())
            return NoteClipBox.create(project.boxGraph, UUID.generate(), box => {
                box.clips.refer(trackBox.clips)
                box.events.refer(events.owners)
                box.duration.setValue(3840)
            })
        }).unwrap()
        const {boxAdapters, deviceSelection} = project
        const handlerIn = (cellBox: InstrumentCompositeCellBox) => DevicesClipboard.createHandler({
            getEnabled: () => true,
            editing: project.editing,
            selection: deviceSelection,
            boxGraph: project.boxGraph,
            boxAdapters,
            getHost: () => Option.wrap(boxAdapters.adapterFor(cellBox, InstrumentCompositeCellBoxAdapter))
        })
        deviceSelection.select(boxAdapters.adapterFor(source.instrumentBox, Devices.isInstrument))
        const entry = handlerIn(source.cellBox).copy().unwrap("copy")
        deviceSelection.deselectAll()
        deviceSelection.select(boxAdapters.adapterFor(target.instrumentBox, Devices.isInstrument))
        handlerIn(target.cellBox).paste(entry)
        expect(clip.isAttached(), "the unit's note clip").toBe(true)
        expect(trackBox.isAttached(), "the unit's note track").toBe(true)
        const pasted = target.cellBox.instrument.pointerHub.incoming().map(pointer => pointer.box.name)
        expect(pasted).toStrictEqual(["VaporisateurDeviceBox"])
        expect(source.instrumentBox.isAttached(), "the copied instrument stays").toBe(true)
        project.terminate()
    })

    it("an instrument copied from a plain track pastes into a layer without its timeline (#390)", async () => {
        const project = await createProject()
        const {plain, composed, target} = project.editing.modify(() => {
            const plain = project.api.createAnyInstrument(InstrumentFactories.Nano)
            lane(project, plain.audioUnitBox, plain.instrumentBox as NanoDeviceBox)
            const composed = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const target = project.api.createCompositeLayer(composed.instrumentBox as InstrumentCompositeBox, InstrumentFactories.Nano).result()
            lane(project, composed.audioUnitBox, target.instrumentBox as NanoDeviceBox)
            return {plain, composed, target}
        }).unwrap()
        const tracksOf = (audioUnitBox: AudioUnitBox) => audioUnitBox.tracks.pointerHub.incoming()
            .map(pointer => pointer.box).filter(box => box instanceof TrackBox)
        const noteTrack = tracksOf(composed.audioUnitBox).find(track => track.type.getValue() === TrackType.Notes) as TrackBox
        const clip = project.editing.modify(() => project.api.createNoteClip(noteTrack, 0)).unwrap()
        expect(tracksOf(composed.audioUnitBox).length, "note track and the Nano's lane").toBe(2)
        const {boxAdapters, deviceSelection} = project
        const handlerIn = (box: Box) => DevicesClipboard.createHandler({
            getEnabled: () => true,
            editing: project.editing,
            selection: deviceSelection,
            boxGraph: project.boxGraph,
            boxAdapters,
            getHost: () => Option.wrap(boxAdapters.adapterFor(box, Devices.isHost))
        })
        deviceSelection.select(boxAdapters.adapterFor(plain.instrumentBox, Devices.isInstrument))
        const entry = handlerIn(plain.audioUnitBox).copy().unwrap("copy")
        deviceSelection.deselectAll()
        deviceSelection.select(boxAdapters.adapterFor(target.instrumentBox, Devices.isInstrument))
        handlerIn(target.cellBox).paste(entry)
        expect(clip.isAttached(), "the unit's note clip").toBe(true)
        expect(tracksOf(composed.audioUnitBox), "the replaced Nano's lane went with it, nothing came in").toStrictEqual([noteTrack])
        expect(tracksOf(plain.audioUnitBox).length, "the source keeps its tracks").toBe(2)
        const hosted = target.cellBox.instrument.pointerHub.incoming().map(pointer => pointer.box)
        expect(hosted.map(box => box.name)).toStrictEqual(["NanoDeviceBox"])
        expect(target.instrumentBox.isAttached(), "the old Nano is replaced").toBe(false)
        expect(plain.instrumentBox.isAttached(), "the copied Nano stays").toBe(true)
        project.terminate()
    })

    it("a layer can be inserted at a position and moved, the order stays gapless", async () => {
        const project = await createProject()
        const composite = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            project.api.createCompositeLayer(composite, InstrumentFactories.Nano).result()
            return composite
        }).unwrap()
        const order = () => project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).cells.adapters()
            .map(layer => [layer.label, layer.indexField.getValue()])
        project.editing.modify(() => project.api.createCompositeLayer(composite, InstrumentFactories.Playfield, undefined, 1).result())
        expect(order()).toStrictEqual([["Vaporisateur", 0], ["Playfield", 1], ["Nano", 2]])
        project.editing.modify(() => project.api.createCompositeLayer(composite, InstrumentFactories.Neon, undefined, 0).result())
        expect(order()).toStrictEqual([["Neon", 0], ["Vaporisateur", 1], ["Playfield", 2], ["Nano", 3]])
        project.editing.modify(() => project.api.createCompositeLayer(composite, InstrumentFactories.Cubed, undefined, 99).result())
        expect(order().at(-1), "an index past the end appends").toStrictEqual(["Cubed", 4])
        project.editing.modify(() => project.api.moveCompositeLayer(composite, 0, 3))
        expect(order()).toStrictEqual([["Vaporisateur", 0], ["Playfield", 1], ["Nano", 2], ["Neon", 3], ["Cubed", 4]])
        project.editing.modify(() => project.api.moveCompositeLayer(composite, 4, 0))
        expect(order()).toStrictEqual([["Cubed", 0], ["Vaporisateur", 1], ["Playfield", 2], ["Nano", 3], ["Neon", 4]])
        project.editing.modify(() => {
            project.api.moveCompositeLayer(composite, 2, 2)
            project.api.moveCompositeLayer(composite, 7, 0)
            project.api.moveCompositeLayer(composite, 0, -1)
        })
        expect(order(), "a no-op or an index out of range changes nothing")
            .toStrictEqual([["Cubed", 0], ["Vaporisateur", 1], ["Playfield", 2], ["Nano", 3], ["Neon", 4]])
        project.terminate()
    })

    it("duplicating a layer copies its synth, its effects and a nested composite right behind it", async () => {
        const project = await createProject()
        const {composite, first} = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            const first = project.api.createCompositeLayer(composite, InstrumentFactories.InstrumentComposite).result()
            first.instrumentBox.label.setValue("Stack")
            first.cellBox.gain.setValue(-9.0)
            project.api.createCompositeLayer(first.instrumentBox, InstrumentFactories.Nano).result()
            DelayDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(first.cellBox.audioEffects)
                box.index.setValue(0)
            })
            PitchDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(first.cellBox.midiEffects)
                box.index.setValue(0)
            })
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            return {composite, first}
        }).unwrap()
        const copy = project.editing.modify(() => project.api.duplicateCompositeLayer(first.cellBox)).unwrap()
        const layers = project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).cells.adapters()
        expect(layers.map(layer => [layer.label, layer.indexField.getValue()]))
            .toStrictEqual([["Stack", 0], ["Stack", 1], ["Vaporisateur", 2]])
        const duplicate = layers[1]
        expect(duplicate.address.toString()).toBe(copy.address.toString())
        expect(duplicate.address.toString()).not.toBe(first.cellBox.address.toString())
        expect(duplicate.box.gain.getValue()).toBe(-9.0)
        const original = layers[0]
        const nestedOf = (layer: InstrumentCompositeCellBoxAdapter) =>
            project.boxAdapters.adapterFor(layer.inputAdapter.unwrap("nested").box, InstrumentCompositeBoxAdapter)
        expect(nestedOf(duplicate).address.toString(), "the nested composite is a COPY").not.toBe(nestedOf(original).address.toString())
        expect(nestedOf(duplicate).cells.adapters().map(cell => cell.label)).toStrictEqual(["Nano"])
        expect(nestedOf(duplicate).cells.adapters()[0].inputAdapter.unwrap("deep").address.toString())
            .not.toBe(nestedOf(original).cells.adapters()[0].inputAdapter.unwrap("deep").address.toString())
        expect(duplicate.audioEffects.unwrap("audio").adapters().length).toBe(1)
        expect(duplicate.midiEffects.unwrap("midi").adapters().length).toBe(1)
        expect(original.audioEffects.unwrap("audio").adapters().length, "the original keeps its own effect").toBe(1)
        expect(project.rootBoxAdapter.audioUnits.adapters().filter(unit => !unit.isOutput).length, "no unit is copied").toBe(1)
        project.terminate()
    })

    it("a layer hosts an instrument plus both effect chains", async () => {
        const project = await createProject()
        const {composite, synth, pitch, delay, audioUnitBox} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const {cellBox: cell, instrumentBox: synth} = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const pitch = PitchDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cell.midiEffects)
                box.index.setValue(0)
            })
            const delay = DelayDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cell.audioEffects)
                box.index.setValue(0)
            })
            return {composite, synth, pitch, delay, audioUnitBox}
        }).unwrap()
        const layer = firstLayer(project, composite)
        expect(layer.inputAdapter.unwrap("layer instrument").address.toString()).toStrictEqual(synth.address.toString())
        expect(layer.midiEffects.unwrap("midi").adapters().map(effect => effect.uuid)).toStrictEqual([pitch.address.uuid])
        expect(layer.audioEffects.unwrap("audio").adapters().map(effect => effect.uuid)).toStrictEqual([delay.address.uuid])
        expect(DeviceHost.takesEffect(layer, "audio")).toBe(true)
        expect(DeviceHost.takesEffect(layer, "midi")).toBe(true)
        expect(layer.inputField.address.toString()).toStrictEqual(layer.box.instrument.address.toString())
        const synthAdapter = project.boxAdapters.adapterFor(synth, Devices.isInstrument)
        expect(synthAdapter.deviceHost().address.toString(), "the synth's host is the LAYER, not the unit").toStrictEqual(layer.address.toString())
        expect(synthAdapter.audioUnitBoxAdapter().address.toString()).toStrictEqual(audioUnitBox.address.toString())
        expect(project.boxAdapters.adapterFor(delay, Devices.isEffect).deviceHost().address.toString()).toStrictEqual(layer.address.toString())
        expect(layer.deviceHost().address.toString(), "leaving a layer returns to the unit the composite sits in")
            .toStrictEqual(audioUnitBox.address.toString())
        expect(layer.tracksField.address.toString()).toStrictEqual(audioUnitBox.tracks.address.toString())
        project.terminate()
    })

    it("layer parameters write the box fields", async () => {
        const project = await createProject()
        const composite = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            return composite
        }).unwrap()
        const layer = firstLayer(project, composite)
        project.editing.modify(() => {
            layer.namedParameter.mute.setValue(true)
            layer.namedParameter.solo.setValue(true)
            layer.namedParameter.pan.setValue(-1.0)
            layer.namedParameter.gain.setValue(-6.0)
        })
        expect([layer.box.mute.getValue(), layer.box.solo.getValue(), layer.box.pan.getValue(), layer.box.gain.getValue()])
            .toStrictEqual([true, true, -1.0, -6.0])
        project.terminate()
    })

    it("a composite nested inside a layer still resolves its unit", async () => {
        const project = await createProject()
        const {inner, innerSynth, audioUnitBox, outerCell} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const {cellBox: outerCell, instrumentBox: inner} = project.api
                .createCompositeLayer(instrumentBox as InstrumentCompositeBox, InstrumentFactories.InstrumentComposite).result()
            const {instrumentBox: innerSynth} = project.api.createCompositeLayer(inner, InstrumentFactories.Nano).result()
            return {inner, innerSynth, audioUnitBox, outerCell}
        }).unwrap()
        const innerComposite = project.boxAdapters.adapterFor(inner, InstrumentCompositeBoxAdapter)
        expect(innerComposite.deviceHost().address.toString(), "the inner composite sits in the OUTER layer").toStrictEqual(outerCell.address.toString())
        const innerLayer = innerComposite.cells.adapters()[0]
        expect(innerLayer.deviceHost().address.toString()).toStrictEqual(outerCell.address.toString())
        expect(innerLayer.audioUnitBoxAdapter().address.toString()).toStrictEqual(audioUnitBox.address.toString())
        expect(project.boxAdapters.adapterFor(innerSynth, Devices.isInstrument).audioUnitBoxAdapter().address.toString())
            .toStrictEqual(audioUnitBox.address.toString())
        project.terminate()
    })

    it("every layer and its devices are offered as audio outputs", async () => {
        const project = await createProject()
        const {composite} = project.editing.modify(() => {
            const {instrumentBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const {cellBox, instrumentBox: synth} = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            synth.label.setValue("Bass")
            return {composite}
        }).unwrap()
        const outputs = Array.from(project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).labeledAudioOutputs())
        expect(outputs.map(output => output.label)).toStrictEqual(["Composite", "Bass"])
        const children = Array.from(outputs[1].children().unwrap("layer children"))
        expect(children.map(output => output.label), "the layer goes by its instrument").toContain("Bass")
        project.terminate()
    })

    it("both kinds of composite cell answer the shared cell contract, other hosts do not", async () => {
        const project = await createProject()
        const {composite, audioUnitBox, entry} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const {cellBox} = project.api.createCompositeLayer(composite, InstrumentFactories.Nano).result()
            const stack = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cellBox.audioEffects)
                box.index.setValue(0)
            })
            const entry = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(stack.entries)
                box.index.setValue(0)
            })
            return {composite, audioUnitBox, entry}
        }).unwrap()
        const compositeAdapter = project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter)
        const [layerA, layerB] = compositeAdapter.cells.adapters()
        const cell = layerB.asCompositeCell().unwrap("a layer is a composite cell")
        expect(cell.cellKind).toBe("instrument")
        expect(cell.compositeDevice().address.toString()).toBe(compositeAdapter.address.toString())
        expect(cell.siblings().map(sibling => sibling.address.toString()))
            .toStrictEqual([layerA.address.toString(), layerB.address.toString()])
        const entryCell = project.boxAdapters.adapterFor(entry, AudioEffectCompositeCellBoxAdapter).asCompositeCell().unwrap("entry")
        expect(entryCell.cellKind).toBe("audio-effect")
        expect(entryCell.siblings().length).toBe(1)
        expect(entryCell.deviceHost().address.toString(), "an FX entry inside a layer leads back to that layer")
            .toBe(layerB.address.toString())
        expect(project.boxAdapters.adapterFor(audioUnitBox, AudioUnitBoxAdapter).asCompositeCell().isEmpty()).toBe(true)
        let notified = 0
        const subscription = cell.subscribeSiblings(() => notified++)
        project.editing.modify(() => project.api.createCompositeLayer(composite, InstrumentFactories.Nano).result())
        expect(notified).toBe(1)
        subscription.terminate()
        project.terminate()
    })
})

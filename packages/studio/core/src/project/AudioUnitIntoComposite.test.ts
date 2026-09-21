import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentCompositeBoxAdapter, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {EffectFactories} from "../EffectFactories"
import {
    AudioUnitBox, DelayDeviceBox, InstrumentCompositeBox, NanoDeviceBox, NoteClipBox, NoteEventCollectionBox,
    NoteRegionBox, PitchDeviceBox, TrackBox, VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitsClipboard} from "../ui/clipboard/types/AudioUnitsClipboardHandler"
import {AudioUnitAsLayer} from "./AudioUnitAsLayer"
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
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

describe("wrap an instrument into a Composite", () => {
    it("moves the instrument and both chains into layer 1, keeps every box, index and automation lane", async () => {
        const project = await createProject()
        const {api, boxGraph, boxAdapters} = project
        const {audioUnitBox, synth, pitch, delayA, delayB, lane} = project.editing.modify(() => {
            const {audioUnitBox, instrumentBox} = api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const synth = instrumentBox as VaporisateurDeviceBox
            const pitch = api.insertEffect(audioUnitBox.midiEffects, EffectFactories.MidiNamed.Pitch) as PitchDeviceBox
            const delayA = api.insertEffect(audioUnitBox.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            const delayB = api.insertEffect(audioUnitBox.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            const lane = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.tracks.refer(audioUnitBox.tracks)
                box.type.setValue(TrackType.Value)
                box.target.refer(delayB.feedback)
                box.index.setValue(1)
            })
            return {audioUnitBox, synth, pitch, delayA, delayB, lane}
        }).unwrap()
        const product = project.editing.modify(() => api.wrapInstrumentIntoComposite(synth).result()).unwrap()
        const {cellBox} = product
        const composite = audioUnitBox.input.pointerHub.incoming().map(pointer => pointer.box)
        expect(composite.map(box => box.name), "the unit now holds the Composite").toStrictEqual(["InstrumentCompositeBox"])
        expect(product.instrumentBox.address.toString()).toBe(synth.address.toString())
        expect(cellBox.composite.targetVertex.unwrap().box.address.toString()).toBe(composite[0].address.toString())
        expect(synth.host.targetAddress.unwrap().toString(), "same synth, re-hosted").toBe(cellBox.instrument.address.toString())
        expect(pitch.host.targetAddress.unwrap().toString()).toBe(cellBox.midiEffects.address.toString())
        expect(delayA.host.targetAddress.unwrap().toString()).toBe(cellBox.audioEffects.address.toString())
        expect(delayB.host.targetAddress.unwrap().toString()).toBe(cellBox.audioEffects.address.toString())
        expect([delayA.index.getValue(), delayB.index.getValue()], "chain order kept").toStrictEqual([0, 1])
        expect(audioUnitBox.midiEffects.pointerHub.incoming().length, "the unit's chains are empty").toBe(0)
        expect(audioUnitBox.audioEffects.pointerHub.incoming().length).toBe(0)
        expect(lane.target.targetAddress.unwrap().toString(), "the lane still targets the moved delay").toBe(delayB.feedback.address.toString())
        expect(lane.tracks.targetAddress.unwrap().toString(), "the lane stays on the unit").toBe(audioUnitBox.tracks.address.toString())
        const layers = boxAdapters.adapterFor(composite[0], InstrumentCompositeBoxAdapter).cells.adapters()
        expect(layers.length).toBe(1)
        expect(layers[0].label).toBe("Vaporisateur")
        project.terminate()
    })

    it("wrapping a Composite nests it, Tape and MIDI Output are refused", async () => {
        const project = await createProject()
        const {api} = project
        const {outer, tape, midiOut} = project.editing.modify(() => ({
            outer: api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox,
            tape: api.createAnyInstrument(InstrumentFactories.Tape).instrumentBox,
            midiOut: api.createAnyInstrument(InstrumentFactories.MIDIOutput).instrumentBox
        })).unwrap()
        const product = project.editing.modify(() => api.wrapInstrumentIntoComposite(outer).result()).unwrap()
        expect(outer.host.targetAddress.unwrap().toString()).toBe(product.cellBox.instrument.address.toString())
        expect(project.editing.modify(() => api.wrapInstrumentIntoComposite(tape).isFailure()).unwrap()).toBe(true)
        expect(project.editing.modify(() => api.wrapInstrumentIntoComposite(midiOut).isFailure()).unwrap()).toBe(true)
        expect(tape.host.targetVertex.unwrap().box.name, "untouched").toBe("AudioUnitBox")
        project.terminate()
    })
})

describe("paste an audio unit as a layer", () => {
    const tracksOf = (unit: AudioUnitBox): ReadonlyArray<TrackBox> => unit.tracks.pointerHub.incoming()
        .map(pointer => pointer.box).filter((box): box is TrackBox => box instanceof TrackBox)
        .sort((left, right) => left.index.getValue() - right.index.getValue())

    it("clones instrument, chains, strip and every track onto the Composite, the source stays", async () => {
        const project = await createProject()
        const {api, boxGraph, boxAdapters} = project
        const {source, sourceUnit, composite, compositeUnit, noteTrack} = project.editing.modify(() => {
            const source = api.createAnyInstrument(InstrumentFactories.Nano)
            const sourceUnit = source.audioUnitBox
            const nano = source.instrumentBox as NanoDeviceBox
            api.insertEffect(sourceUnit.midiEffects, EffectFactories.MidiNamed.Pitch)
            const delay = api.insertEffect(sourceUnit.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            sourceUnit.volume.setValue(-6.0)
            sourceUnit.panning.setValue(0.25)
            sourceUnit.mute.setValue(true)
            const noteTrack = tracksOf(sourceUnit)[0]
            api.createNoteRegion({trackBox: noteTrack, position: 0, duration: 3840})
            api.createNoteClip(noteTrack, 0)
            TrackBox.create(boxGraph, UUID.generate(), box => {
                box.tracks.refer(sourceUnit.tracks)
                box.type.setValue(TrackType.Value)
                box.target.refer(nano.volume)
                box.index.setValue(1)
            })
            TrackBox.create(boxGraph, UUID.generate(), box => {
                box.tracks.refer(sourceUnit.tracks)
                box.type.setValue(TrackType.Value)
                box.target.refer(delay.feedback)
                box.index.setValue(2)
            })
            TrackBox.create(boxGraph, UUID.generate(), box => {
                box.tracks.refer(sourceUnit.tracks)
                box.type.setValue(TrackType.Value)
                box.target.refer(sourceUnit.volume)
                box.index.setValue(3)
            })
            const target = api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = target.instrumentBox as InstrumentCompositeBox
            api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur)
            return {source, sourceUnit, composite, compositeUnit: target.audioUnitBox, noteTrack}
        }).unwrap()
        const entry = AudioUnitsClipboard.copyEntry(boxAdapters.adapterFor(sourceUnit, AudioUnitBoxAdapter)).unwrap("copy")
        const boxCount = boxGraph.boxes().length
        const {cellBox, instrumentBox} = project.editing.modify(() => api.pasteAudioUnitAsLayer(composite, entry.data).result()).unwrap()
        expect(cellBox.index.getValue(), "appended as layer 2").toBe(1)
        expect(instrumentBox.name).toBe("NanoDeviceBox")
        expect(instrumentBox.address.toString()).not.toBe(source.instrumentBox.address.toString())
        expect(instrumentBox.host.targetAddress.unwrap().toString()).toBe(cellBox.instrument.address.toString())
        expect(cellBox.midiEffects.pointerHub.incoming().map(pointer => pointer.box.name)).toStrictEqual(["PitchDeviceBox"])
        expect(cellBox.audioEffects.pointerHub.incoming().map(pointer => pointer.box.name)).toStrictEqual(["DelayDeviceBox"])
        expect([cellBox.gain.getValue(), cellBox.pan.getValue(), cellBox.mute.getValue(), cellBox.solo.getValue()], "the strip travels")
            .toStrictEqual([-6.0, 0.25, true, false])
        const pasted = tracksOf(compositeUnit)
        expect(pasted.length, "the composite's own note track plus the four pasted lanes").toBe(5)
        expect(pasted.map(track => track.index.getValue())).toStrictEqual([0, 1, 2, 3, 4])
        expect(pasted[1].type.getValue()).toBe(TrackType.Notes)
        expect(pasted[1].target.targetAddress.unwrap().toString(), "the lane targets its own unit, not the source unit").toBe(compositeUnit.address.toString())
        expect(pasted[1].regions.pointerHub.incoming().map(pointer => pointer.box.name)).toStrictEqual(["NoteRegionBox"])
        expect(pasted[1].clips.pointerHub.incoming().map(pointer => pointer.box.name)).toStrictEqual(["NoteClipBox"])
        expect(pasted[2].target.targetAddress.unwrap().toString(), "the lane follows the cloned Nano")
            .toBe((instrumentBox as NanoDeviceBox).volume.address.toString())
        const delayCopy = cellBox.audioEffects.pointerHub.incoming()[0].box as DelayDeviceBox
        expect(pasted[3].target.targetAddress.unwrap().toString()).toBe(delayCopy.feedback.address.toString())
        expect(pasted[4].target.targetAddress.unwrap().toString(), "the unit's volume lane becomes the layer's gain lane")
            .toBe(cellBox.gain.address.toString())
        expect(tracksOf(sourceUnit).length, "the source is untouched").toBe(4)
        expect(noteTrack.isAttached()).toBe(true)
        expect(boxGraph.boxes().filter(box => box instanceof NoteRegionBox).length).toBe(2)
        expect(boxGraph.boxes().filter(box => box instanceof NoteClipBox).length).toBe(2)
        expect(boxGraph.boxes().filter(box => box instanceof AudioUnitBox).length, "no unit box came in").toBe(3)
        expect(boxGraph.boxes().length).toBeGreaterThan(boxCount)
        project.terminate()
    })

    const withNotes = async () => {
        const project = await createProject()
        const {api, boxAdapters} = project
        const {sourceUnit, composite, compositeUnit} = project.editing.modify(() => {
            const source = api.createAnyInstrument(InstrumentFactories.Nano)
            const sourceTrack = tracksOf(source.audioUnitBox)[0]
            api.createNoteRegion({trackBox: sourceTrack, position: 0, duration: 3840})
            api.createNoteClip(sourceTrack, 0)
            const target = api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const targetTrack = tracksOf(target.audioUnitBox)[0]
            api.createNoteRegion({trackBox: targetTrack, position: 3840, duration: 3840})
            return {sourceUnit: source.audioUnitBox, composite: target.instrumentBox as InstrumentCompositeBox, compositeUnit: target.audioUnitBox}
        }).unwrap()
        const entry = AudioUnitsClipboard.copyEntry(boxAdapters.adapterFor(sourceUnit, AudioUnitBoxAdapter)).unwrap("copy")
        const regions = () => project.boxGraph.boxes().filter(box => box instanceof NoteRegionBox).length
        const clips = () => project.boxGraph.boxes().filter(box => box instanceof NoteClipBox).length
        const collections = () => project.boxGraph.boxes().filter(box => box instanceof NoteEventCollectionBox).length
        return {project, entry, composite, compositeUnit, regions, clips, collections}
    }

    it("both sides have notes: keep drops the clipboard's notes, its lanes and orphaned collections", async () => {
        const {project, entry, composite, compositeUnit, regions, clips, collections} = await withNotes()
        expect(AudioUnitAsLayer.clipboardHasNotes(entry.data)).toBe(true)
        expect(AudioUnitAsLayer.hasNotes(compositeUnit)).toBe(true)
        const before = {regions: regions(), clips: clips(), collections: collections()}
        project.editing.modify(() => project.api.pasteAudioUnitAsLayer(composite, entry.data, "keep").result()).unwrap()
        expect(tracksOf(compositeUnit).length, "only the composite's own track").toBe(1)
        expect({regions: regions(), clips: clips(), collections: collections()}).toStrictEqual(before)
        expect(composite.cells.pointerHub.incoming().length, "the layer still arrives").toBe(1)
        project.terminate()
    })

    it("both sides have notes: replace swaps the composite's notes for the clipboard's", async () => {
        const {project, entry, composite, compositeUnit, regions, clips} = await withNotes()
        project.editing.modify(() => project.api.pasteAudioUnitAsLayer(composite, entry.data, "replace").result()).unwrap()
        const tracks = tracksOf(compositeUnit)
        expect(tracks.length).toBe(1)
        expect(tracks[0].regions.pointerHub.incoming().map(pointer => (pointer.box as NoteRegionBox).position.getValue())).toStrictEqual([0])
        expect(tracks[0].clips.pointerHub.incoming().length).toBe(1)
        expect(regions(), "source region + pasted region").toBe(2)
        expect(clips()).toBe(2)
        project.terminate()
    })

    it("both sides have notes: append keeps both", async () => {
        const {project, entry, composite, compositeUnit, regions} = await withNotes()
        project.editing.modify(() => project.api.pasteAudioUnitAsLayer(composite, entry.data, "append").result()).unwrap()
        expect(tracksOf(compositeUnit).length).toBe(2)
        expect(regions()).toBe(3)
        project.terminate()
    })

    it("an empty note track is not appended", async () => {
        const project = await createProject()
        const {api, boxAdapters} = project
        const {sourceUnit, composite, compositeUnit} = project.editing.modify(() => {
            const source = api.createAnyInstrument(InstrumentFactories.Nano)
            const target = api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            return {sourceUnit: source.audioUnitBox, composite: target.instrumentBox as InstrumentCompositeBox, compositeUnit: target.audioUnitBox}
        }).unwrap()
        const entry = AudioUnitsClipboard.copyEntry(boxAdapters.adapterFor(sourceUnit, AudioUnitBoxAdapter)).unwrap("copy")
        project.editing.modify(() => api.pasteAudioUnitAsLayer(composite, entry.data).result()).unwrap()
        expect(tracksOf(compositeUnit).length).toBe(1)
        expect(composite.cells.pointerHub.incoming().length).toBe(1)
        project.terminate()
    })

    it("a Tape unit is refused", async () => {
        const project = await createProject()
        const {api, boxAdapters} = project
        const {tapeUnit, composite} = project.editing.modify(() => ({
            tapeUnit: api.createAnyInstrument(InstrumentFactories.Tape).audioUnitBox,
            composite: api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
        })).unwrap()
        const entry = AudioUnitsClipboard.copyEntry(boxAdapters.adapterFor(tapeUnit, AudioUnitBoxAdapter)).unwrap("copy")
        const attempt = project.editing.modify(() => api.pasteAudioUnitAsLayer(composite, entry.data)).unwrap()
        expect(attempt.isFailure()).toBe(true)
        expect(composite.cells.pointerHub.incoming().length).toBe(0)
        project.terminate()
    })
})

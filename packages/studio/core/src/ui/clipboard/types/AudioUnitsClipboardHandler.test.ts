import {beforeEach, describe, expect, it} from "vitest"
import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {Box, BoxEditing, Vertex} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    AuxSendBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    MIDIOutputDeviceBox,
    MIDIOutputParameterBox,
    ModulationBox,
    RootBox,
    StepsModulatorBox,
    TrackBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {ClipboardUtils} from "../ClipboardUtils"
import {AudioUnitsClipboard} from "./AudioUnitsClipboardHandler"

describe("AudioUnitsClipboardHandler", () => {
    let source: ProjectSkeleton
    let target: ProjectSkeleton

    beforeEach(() => {
        source = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        target = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    })

    const createAudioUnit = (skeleton: ProjectSkeleton, index: number = 1): AudioUnitBox => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
        let audioUnitBox!: AudioUnitBox
        boxGraph.beginTransaction()
        audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(index)
        })
        boxGraph.endTransaction()
        return audioUnitBox
    }

    // Builds a MIDI-Output instrument with one CC parameter and its Value automation lane,
    // mirroring AddParameterButton.tsx (the parameter box and its track are born as a pair).
    const addMidiOutputWithCC = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox): {
        device: MIDIOutputDeviceBox, parameter: MIDIOutputParameterBox, instrumentTrack: TrackBox, ccTrack: TrackBox
    } => {
        const {boxGraph} = skeleton
        let device!: MIDIOutputDeviceBox
        let parameter!: MIDIOutputParameterBox
        let instrumentTrack!: TrackBox
        let ccTrack!: TrackBox
        boxGraph.beginTransaction()
        device = MIDIOutputDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("MIDI Output")
            box.host.refer(audioUnit.input)
        })
        instrumentTrack = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(audioUnit.tracks)
            box.target.refer(audioUnit)
            box.index.setValue(0)
        })
        parameter = MIDIOutputParameterBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("CC")
            box.owner.refer(device.parameters)
            box.controller.setValue(64)
        })
        ccTrack = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(audioUnit.tracks)
            box.target.refer(parameter.value)
            box.index.setValue(1)
        })
        boxGraph.endTransaction()
        return {device, parameter, instrumentTrack, ccTrack}
    }

    // Use the real copyAudioUnit dependency collection so tests exercise its exclusion logic.
    const collectAudioUnitDependencies = (audioUnitBox: AudioUnitBox): ReadonlyArray<Box> =>
        AudioUnitsClipboard.collectDependencies(audioUnitBox, false)

    // The real pasteNewAudioUnit options, so the tests cannot drift from the handler.
    const makePasteMapper = (rootBox: RootBox, primaryBusUuid: UUID.Bytes) =>
        AudioUnitsClipboard.newAudioUnitPasteOptions(rootBox, primaryBusUuid)

    it("includes the MIDIOutputParameterBox when copying a MIDI-output unit with a CC automation lane", () => {
        const audioUnit = createAudioUnit(source)
        const {parameter, ccTrack} = addMidiOutputWithCC(source, audioUnit)
        const deps = collectAudioUnitDependencies(audioUnit)
        expect(deps).toContain(parameter)
        expect(deps).toContain(ccTrack)
    })

    it("round-trip paste of a MIDI-output unit with a CC automation lane does not throw", () => {
        const sourceAU = createAudioUnit(source)
        addMidiOutputWithCC(source, sourceAU)
        const data = ClipboardUtils.serializeBoxes([sourceAU, ...collectAudioUnitDependencies(sourceAU)])
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        const editing = new BoxEditing(boxGraph)
        expect(() => {
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, boxGraph,
                    makePasteMapper(rootBox, primaryAudioBusBox.address.uuid))
            })
        }).not.toThrow()
    })

    it("rewires the pasted automation lane to the pasted parameter and keeps its value edge", () => {
        const sourceAU = createAudioUnit(source)
        addMidiOutputWithCC(source, sourceAU)
        const data = ClipboardUtils.serializeBoxes([sourceAU, ...collectAudioUnitDependencies(sourceAU)])
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        const editing = new BoxEditing(boxGraph)
        editing.modify(() => {
            ClipboardUtils.deserializeBoxes(data, boxGraph,
                makePasteMapper(rootBox, primaryAudioBusBox.address.uuid))
        })
        const pastedParameter = boxGraph.boxes().find(box => isInstanceOf(box, MIDIOutputParameterBox)) as MIDIOutputParameterBox
        expect(pastedParameter).toBeDefined()
        const pastedCCTrack = boxGraph.boxes()
            .filter((box): box is TrackBox => isInstanceOf(box, TrackBox))
            .find(track => track.type.getValue() === TrackType.Value)
        expect(pastedCCTrack).toBeDefined()
        expect(pastedCCTrack!.target.targetVertex.unwrap().box).toBe(pastedParameter)
        expect(pastedParameter.value.pointerHub.incoming().length).toBe(1)
    })

    // Reproduces error #983: an automation (Value) lane targets an aux-send level (`AuxSendBox.sendGain`).
    // `AuxSendBox` is in copyAudioUnit's excludeBox list, so the aux-send is NOT copied even though the
    // lane's mandatory `target` reaches it — leaving the pasted TrackBox.target unwired. Paste then
    // panics at endTransaction with "Pointer {…TrackBox… (target) …/2 requires an edge." This asserts
    // the paste should succeed (RED until the copy/paste preserves or rewires the lane's target).
    it("round-trip paste of a unit whose automation lane targets an aux-send level does not throw (#983)", () => {
        const sourceAU = createAudioUnit(source)
        const {boxGraph: sg, mandatoryBoxes: {primaryAudioBusBox: srcBus}} = source
        sg.beginTransaction()
        const auxSend = AuxSendBox.create(sg, UUID.generate(), box => {
            box.index.setValue(0)
            box.audioUnit.refer(sourceAU.auxSends)
            box.targetBus.refer(srcBus.input)
        })
        const autoTrack = TrackBox.create(sg, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(sourceAU.tracks)
            box.target.refer(auxSend.sendGain)
            box.index.setValue(0)
        })
        const events = ValueEventCollectionBox.create(sg, UUID.generate())
        ValueRegionBox.create(sg, UUID.generate(), box => {
            box.regions.refer(autoTrack.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(15600)
        })
        sg.endTransaction()
        const data = ClipboardUtils.serializeBoxes([sourceAU, ...collectAudioUnitDependencies(sourceAU)])
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        const editing = new BoxEditing(boxGraph)
        expect(() => {
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, boxGraph,
                    makePasteMapper(rootBox, primaryAudioBusBox.address.uuid))
            })
        }).not.toThrow()
        // Behaviour: the unit pastes (target now has its own output unit + the pasted one), but the
        // aux-send-targeting automation lane and its region are dropped, since the aux-send it
        // automated is not copied.
        expect(boxGraph.boxes().filter(box => isInstanceOf(box, AudioUnitBox)).length).toBe(2)
        expect(boxGraph.boxes().filter(box => isInstanceOf(box, TrackBox)).length).toBe(0)
        expect(boxGraph.boxes().filter(box => isInstanceOf(box, ValueRegionBox)).length).toBe(0)
    })

    // Only the orphan (excluded-target) lane is dropped: a local automation lane that targets an
    // in-unit device parameter must survive paste and have its target rewired to the pasted device.
    it("keeps a device-parameter automation lane while dropping the aux-send lane (#983)", () => {
        const sourceAU = createAudioUnit(source)
        const {boxGraph: sg, mandatoryBoxes: {primaryAudioBusBox: srcBus}} = source
        sg.beginTransaction()
        const effect = CompressorDeviceBox.create(sg, UUID.generate(), box => {
            box.label.setValue("Comp")
            box.host.refer(sourceAU.audioEffects)
            box.index.setValue(0)
        })
        TrackBox.create(sg, UUID.generate(), box => { // local lane -> device parameter (must survive)
            box.type.setValue(TrackType.Value)
            box.tracks.refer(sourceAU.tracks)
            box.target.refer(effect.threshold)
            box.index.setValue(0)
        })
        const auxSend = AuxSendBox.create(sg, UUID.generate(), box => {
            box.index.setValue(0)
            box.audioUnit.refer(sourceAU.auxSends)
            box.targetBus.refer(srcBus.input)
        })
        TrackBox.create(sg, UUID.generate(), box => { // orphan lane -> aux-send level (must be dropped)
            box.type.setValue(TrackType.Value)
            box.tracks.refer(sourceAU.tracks)
            box.target.refer(auxSend.sendGain)
            box.index.setValue(1)
        })
        sg.endTransaction()
        const data = ClipboardUtils.serializeBoxes([sourceAU, ...collectAudioUnitDependencies(sourceAU)])
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        const editing = new BoxEditing(boxGraph)
        editing.modify(() => {
            ClipboardUtils.deserializeBoxes(data, boxGraph,
                makePasteMapper(rootBox, primaryAudioBusBox.address.uuid))
        })
        const pastedTracks = boxGraph.boxes().filter((box): box is TrackBox => isInstanceOf(box, TrackBox))
        const pastedCompressor = boxGraph.boxes()
            .find((box): box is CompressorDeviceBox => isInstanceOf(box, CompressorDeviceBox))
        expect(pastedCompressor).toBeDefined()
        expect(pastedTracks.length).toBe(1) // local lane kept, aux-send lane dropped
        expect(pastedTracks[0].target.targetVertex.unwrap().box).toBe(pastedCompressor) // target rewired
    })
    // #385: a device parameter modulated by a project-level modulator (rootBox.modulators). The ModulationBox
    // rides along through its mandatory `target`, but its mandatory `source` points OUTSIDE the unit, at the
    // modulator. Pasting into another project (or even the same one, the mapper answered None) then panics
    // "Pointer {ModulationBox (source) …/1 requires an edge".
    describe("modulated parameters (#385)", () => {
        const addCrusher = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox): CrusherDeviceBox => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const crusher = CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Crusher")
                box.host.refer(audioUnit.audioEffects)
                box.index.setValue(0)
            })
            boxGraph.endTransaction()
            return crusher
        }
        const addModulator = (skeleton: ProjectSkeleton): StepsModulatorBox => {
            const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
            boxGraph.beginTransaction()
            const modulator = StepsModulatorBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.modulators)
                box.label.setValue("Steps")
                box.index.setValue(0)
            })
            boxGraph.endTransaction()
            return modulator
        }
        const assign = (skeleton: ProjectSkeleton, modulator: StepsModulatorBox, target: Vertex): ModulationBox => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const modulation = ModulationBox.create(boxGraph, UUID.generate(), box => {
                box.source.refer(modulator.assignments)
                box.target.refer(target)
                box.depth.setValue(0.25)
                box.index.setValue(0)
            })
            boxGraph.endTransaction()
            return modulation
        }
        const modulatorsOf = (skeleton: ProjectSkeleton): ReadonlyArray<Box> =>
            skeleton.mandatoryBoxes.rootBox.modulators.pointerHub.incoming().map(({box}) => box)
        const modulationsOf = (skeleton: ProjectSkeleton): ReadonlyArray<ModulationBox> =>
            skeleton.boxGraph.boxes().filter((box): box is ModulationBox => isInstanceOf(box, ModulationBox))
        const pasteInto = (skeleton: ProjectSkeleton, data: ArrayBufferLike): void => {
            const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
            new BoxEditing(boxGraph).modify(() =>
                ClipboardUtils.deserializeBoxes(data, boxGraph, makePasteMapper(rootBox, primaryAudioBusBox.address.uuid)))
        }
        const modulatedUnitBundle = (): {audioUnit: AudioUnitBox, modulator: StepsModulatorBox, data: ArrayBufferLike} => {
            const audioUnit = createAudioUnit(source)
            const crusher = addCrusher(source, audioUnit)
            const modulator = addModulator(source)
            assign(source, modulator, crusher.crush)
            const data = ClipboardUtils.serializeBoxes([audioUnit, ...collectAudioUnitDependencies(audioUnit)])
            return {audioUnit, modulator, data}
        }

        it("collects the modulator the assignment points at", () => {
            const audioUnit = createAudioUnit(source)
            const crusher = addCrusher(source, audioUnit)
            const modulator = addModulator(source)
            const modulation = assign(source, modulator, crusher.crush)
            const deps = collectAudioUnitDependencies(audioUnit)
            expect(deps).toContain(modulation)
            expect(deps).toContain(modulator)
        })

        it("paste into another project carries the modulator and rewires the assignment to it", () => {
            const {modulator, data} = modulatedUnitBundle()
            expect(() => pasteInto(target, data)).not.toThrow()
            const pastedModulators = modulatorsOf(target)
            expect(pastedModulators.length).toBe(1)
            expect(UUID.equals(pastedModulators[0].address.uuid, modulator.address.uuid)).toBe(true)
            const [modulation] = modulationsOf(target)
            expect(modulation).toBeDefined()
            expect(modulation.source.targetVertex.unwrap().box).toBe(pastedModulators[0])
            const pastedCrusher = target.boxGraph.boxes().find(box => isInstanceOf(box, CrusherDeviceBox)) as CrusherDeviceBox
            expect(modulation.target.targetVertex.unwrap()).toBe(pastedCrusher.crush)
        })

        it("pasting the same bundle twice into another project shares one modulator", () => {
            const {data} = modulatedUnitBundle()
            pasteInto(target, data)
            pasteInto(target, data)
            expect(modulatorsOf(target).length).toBe(1)
            expect(modulationsOf(target).length).toBe(2)
            modulationsOf(target).forEach(modulation =>
                expect(modulation.source.targetVertex.unwrap().box).toBe(modulatorsOf(target)[0]))
        })

        it("paste into the same project shares the existing modulator", () => {
            const {modulator, data} = modulatedUnitBundle()
            expect(() => pasteInto(source, data)).not.toThrow()
            expect(modulatorsOf(source)).toEqual([modulator])
            const modulations = modulationsOf(source)
            expect(modulations.length).toBe(2)
            modulations.forEach(modulation => expect(modulation.source.targetVertex.unwrap().box).toBe(modulator))
        })
    })
})

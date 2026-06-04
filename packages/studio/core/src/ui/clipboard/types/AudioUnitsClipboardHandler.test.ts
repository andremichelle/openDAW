import {beforeEach, describe, expect, it} from "vitest"
import {isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxEditing, PointerField} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    AuxSendBox,
    CompressorDeviceBox,
    MIDIOutputDeviceBox,
    MIDIOutputParameterBox,
    RootBox,
    TrackBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
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

    // Mirrors AudioUnitsClipboard.pasteNewAudioUnit pointer remapping.
    const makePasteMapper = (rootBox: RootBox, primaryBusUuid: UUID.Bytes) => ({
        mapPointer: (pointer: PointerField, address: Option<Address>): Option<Address> => {
            if (address.isEmpty()) {return Option.None}
            if (pointer.pointerType === Pointers.AudioUnits) {return Option.wrap(rootBox.audioUnits.address)}
            if (pointer.pointerType === Pointers.AudioOutput) {return address.map(addr => addr.moveTo(primaryBusUuid))}
            if (pointer.pointerType === Pointers.MIDIDevice) {return Option.wrap(rootBox.outputMidiDevices.address)}
            return Option.None
        }
    })

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
})

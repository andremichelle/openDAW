import {describe, expect, it, beforeEach} from "vitest"
import {isDefined, isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxEditing, BoxGraph, Field, PointerField, type Vertex} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioFileBox,
    AudioUnitBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    MIDIOutputBox,
    MIDIOutputDeviceBox,
    ModulationBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    RootBox,
    StepsModulatorBox,
    TapeDeviceBox,
    TrackBox,
    VaporisateurDeviceBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    WerkstattParameterBox,
    WerkstattSampleBox
} from "@opendaw/studio-boxes"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {DeviceBoxUtils, isModulatorBox, ProjectSkeleton, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"
import {AudioEffectCompositeBox, AudioEffectCompositeCellBox, StereoToolDeviceBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import {ClipboardUtils} from "../ClipboardUtils"
import {DevicesClipboard} from "./DevicesClipboardHandler"

describe("DevicesClipboardHandler", () => {
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

    const addTapeInstrument = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox, label: string): TapeDeviceBox => {
        const {boxGraph} = skeleton
        let device!: TapeDeviceBox
        boxGraph.beginTransaction()
        device = TapeDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.host.refer(audioUnit.input)
        })
        boxGraph.endTransaction()
        return device
    }

    const addApparatInstrument = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox, label: string): ApparatDeviceBox => {
        const {boxGraph} = skeleton
        let device!: ApparatDeviceBox
        boxGraph.beginTransaction()
        device = ApparatDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.host.refer(audioUnit.input)
        })
        boxGraph.endTransaction()
        return device
    }

    const addVaporisateur = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox, label: string): VaporisateurDeviceBox => {
        const {boxGraph} = skeleton
        let device!: VaporisateurDeviceBox
        boxGraph.beginTransaction()
        device = VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.host.refer(audioUnit.input)
        })
        boxGraph.endTransaction()
        return device
    }

    const addAutomationTrack = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox,
                                automationTarget: Vertex, index: number): TrackBox => {
        const {boxGraph} = skeleton
        let trackBox!: TrackBox
        boxGraph.beginTransaction()
        trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(audioUnit.tracks)
            box.target.refer(automationTarget)
            box.index.setValue(index)
        })
        boxGraph.endTransaction()
        return trackBox
    }

    const addPlayfieldInstrument = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox, label: string): PlayfieldDeviceBox => {
        const {boxGraph} = skeleton
        let device!: PlayfieldDeviceBox
        boxGraph.beginTransaction()
        device = PlayfieldDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.host.refer(audioUnit.input)
        })
        boxGraph.endTransaction()
        return device
    }

    const addPlayfieldSample = (skeleton: ProjectSkeleton, playfield: PlayfieldDeviceBox,
                                fileName: string, midiNote: number): {sample: PlayfieldSampleBox, audioFile: AudioFileBox} => {
        const {boxGraph} = skeleton
        let sample!: PlayfieldSampleBox
        let audioFile!: AudioFileBox
        boxGraph.beginTransaction()
        audioFile = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.fileName.setValue(fileName)
            box.startInSeconds.setValue(0)
            box.endInSeconds.setValue(1)
        })
        sample = PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
            box.device.refer(playfield.samples)
            box.file.refer(audioFile)
            box.icon.setValue("drum")
            box.index.setValue(midiNote)
        })
        boxGraph.endTransaction()
        return {sample, audioFile}
    }

    const addTrack = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox,
                      trackType: TrackType, index: number = 0): TrackBox => {
        const {boxGraph} = skeleton
        let trackBox!: TrackBox
        boxGraph.beginTransaction()
        trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(trackType)
            box.tracks.refer(audioUnit.tracks)
            box.target.refer(audioUnit)
            box.index.setValue(index)
        })
        boxGraph.endTransaction()
        return trackBox
    }

    const addNoteRegion = (skeleton: ProjectSkeleton, trackBox: TrackBox,
                           position: number, duration: number): NoteRegionBox => {
        const {boxGraph} = skeleton
        let region!: NoteRegionBox
        boxGraph.beginTransaction()
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        region = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
            box.position.setValue(position)
            box.duration.setValue(duration)
        })
        boxGraph.endTransaction()
        return region
    }

    const addValueRegion = (skeleton: ProjectSkeleton, trackBox: TrackBox,
                            position: number, duration: number): ValueRegionBox => {
        const {boxGraph} = skeleton
        let region!: ValueRegionBox
        boxGraph.beginTransaction()
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        region = ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
            box.position.setValue(position)
            box.duration.setValue(duration)
        })
        boxGraph.endTransaction()
        return region
    }

    const addAudioEffect = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox,
                            label: string, index: number): CompressorDeviceBox => {
        const {boxGraph} = skeleton
        let effect!: CompressorDeviceBox
        boxGraph.beginTransaction()
        effect = CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.host.refer(audioUnit.audioEffects)
            box.index.setValue(index)
        })
        boxGraph.endTransaction()
        return effect
    }

    const addComposite = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox): {
        composite: AudioEffectCompositeBox, entry: AudioEffectCompositeCellBox, nested: StereoToolDeviceBox
    } => {
        const {boxGraph} = skeleton
        let composite!: AudioEffectCompositeBox
        let entry!: AudioEffectCompositeCellBox
        let nested!: StereoToolDeviceBox
        boxGraph.beginTransaction()
        composite = AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(audioUnit.audioEffects)
            box.index.setValue(0)
        })
        entry = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.entries)
            box.index.setValue(0)
            box.label.setValue("Branch")
        })
        nested = StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(entry.audioEffects)
            box.index.setValue(0)
        })
        boxGraph.endTransaction()
        return {composite, entry, nested}
    }

    const addWerkstattParam = (skeleton: ProjectSkeleton, paramsField: Field<Pointers.Parameter>,
                               label: string, value: number, index: number): WerkstattParameterBox => {
        const {boxGraph} = skeleton
        let param!: WerkstattParameterBox
        boxGraph.beginTransaction()
        param = WerkstattParameterBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(paramsField)
            box.label.setValue(label)
            box.index.setValue(index)
            box.value.setValue(value)
            box.defaultValue.setValue(value)
        })
        boxGraph.endTransaction()
        return param
    }

    const addWerkstattSample = (skeleton: ProjectSkeleton, samplesField: Field<Pointers.Sample>,
                                label: string, fileName: string, index: number): {
        sampleBox: WerkstattSampleBox, audioFile: AudioFileBox
    } => {
        const {boxGraph} = skeleton
        let sampleBox!: WerkstattSampleBox
        let audioFile!: AudioFileBox
        boxGraph.beginTransaction()
        audioFile = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.fileName.setValue(fileName)
            box.startInSeconds.setValue(0)
            box.endInSeconds.setValue(1)
        })
        sampleBox = WerkstattSampleBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(samplesField)
            box.label.setValue(label)
            box.index.setValue(index)
            box.file.refer(audioFile)
        })
        boxGraph.endTransaction()
        return {sampleBox, audioFile}
    }

    // The device dependencies come from the REAL production function (no drift). Only the audio-unit timeline,
    // which copyDevices bundles separately alongside an instrument, is mirrored here.
    const collectDeviceDependencies = (deviceBox: Box, boxGraph: BoxGraph,
                                       audioUnit?: AudioUnitBox): Box[] => {
        const deviceDeps = DevicesClipboard.collectDeviceDependencies([deviceBox], boxGraph)
        const trackContent: Box[] = []
        if (audioUnit !== undefined) {
            const trackPointers = audioUnit.tracks.pointerHub.incoming()
            const tracks = trackPointers
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => pointer.box as TrackBox)
            for (const track of tracks) {
                trackContent.push(track)
                const regionPointers = track.regions.pointerHub.incoming()
                for (const regionPointer of regionPointers) {
                    trackContent.push(regionPointer.box)
                    const regionDeps = Array.from(boxGraph.dependenciesOf(regionPointer.box, {
                        alwaysFollowMandatory: true,
                        stopAtResources: true,
                        excludeBox: (dep: Box) => dep.ephemeral
                            || isInstanceOf(dep, TrackBox)
                            || DeviceBoxUtils.isDeviceBox(dep)
                    }).boxes)
                    trackContent.push(...regionDeps)
                }
            }
        }
        const seen = new Set<string>()
        return [...deviceDeps, ...trackContent].filter(box => {
            const uuid = UUID.toString(box.address.uuid)
            if (seen.has(uuid)) return false
            seen.add(uuid)
            return true
        })
    }

    const makePasteMapper = (targetAudioUnit: AudioUnitBox, replaceInstrument: boolean,
                             hasInstrument: boolean = true) => ({
        mapPointer: (pointer: PointerField, address: Option<Address>) => {
            if (pointer.pointerType === Pointers.InstrumentHost && replaceInstrument) {
                return Option.wrap(targetAudioUnit.input.address)
            }
            if (pointer.pointerType === Pointers.AudioEffectHost) {
                return Option.wrap(targetAudioUnit.audioEffects.address)
            }
            if (pointer.pointerType === Pointers.MIDIEffectHost) {
                return Option.wrap(targetAudioUnit.midiEffects.address)
            }
            if (pointer.pointerType === Pointers.TrackCollection) {
                return Option.wrap(targetAudioUnit.tracks.address)
            }
            if (pointer.pointerType === Pointers.Automation && replaceInstrument) {
                return Option.wrap(targetAudioUnit.address)
            }
            return DevicesClipboard.mapModulationPointer(pointer, address, targetAudioUnit.graph)
        },
        keepUuid: isModulatorBox,
        excludeBox: (box: Box) => {
            if (DevicesClipboard.excludeExistingModulator(box, targetAudioUnit.graph)) {return true}
            if (replaceInstrument) {return false}
            if (DeviceBoxUtils.isInstrumentDeviceBox(box)) {return true}
            // Mirrors DevicesClipboardHandler paste: when an instrument is bundled but not replaced, drop the
            // whole timeline subtree so a region can't dangle its mandatory `regions` pointer (#1049-#1051).
            if (hasInstrument
                && (isInstanceOf(box, TrackBox)
                    || UnionBoxTypes.isRegionBox(box)
                    || UnionBoxTypes.isClipBox(box)
                    || isInstanceOf(box, NoteEventCollectionBox)
                    || isInstanceOf(box, ValueEventCollectionBox))) {return true}
            return false
        }
    })

    // ─────────────────────────────────────────────────────────
    // Audio effect paste
    // ─────────────────────────────────────────────────────────

    describe("paste audio effects", () => {
        it("deserializes a single audio effect", () => {
            const sourceAU = createAudioUnit(source)
            const effect = addAudioEffect(source, sourceAU, "Compressor", 0)
            const data = ClipboardUtils.serializeBoxes([effect])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false))
            })
            const pasted = targetAU.audioEffects.pointerHub.incoming()
            expect(pasted.length).toBe(1)
            expect(isInstanceOf(pasted[0].box, CompressorDeviceBox)).toBe(true)
        })
        it("deserializes multiple audio effects", () => {
            const sourceAU = createAudioUnit(source)
            const effectA = addAudioEffect(source, sourceAU, "Comp A", 0)
            const effectB = addAudioEffect(source, sourceAU, "Comp B", 1)
            const data = ClipboardUtils.serializeBoxes([effectA, effectB])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false))
            })
            expect(targetAU.audioEffects.pointerHub.incoming().length).toBe(2)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Composite: nested effects survive copy + paste (not flattened)
    // ─────────────────────────────────────────────────────────

    describe("composite copy/paste preserves nested effects", () => {
        it("collects a composite's entry cells AND the effects nested in them", () => {
            const audioUnit = createAudioUnit(source)
            const {composite, entry, nested} = addComposite(source, audioUnit)
            const deps = collectDeviceDependencies(composite, source.boxGraph)
            expect(deps).toContain(entry)
            expect(deps).toContain(nested)
            expect(deps.filter(box => isInstanceOf(box, AudioEffectCompositeCellBox)).length).toBe(1)
            expect(deps.filter(box => isInstanceOf(box, StereoToolDeviceBox)).length).toBe(1)
        })
        it("round-trips: the pasted entry hosts the pasted effect, not the top host", () => {
            const sourceAU = createAudioUnit(source)
            const {composite} = addComposite(source, sourceAU)
            const deps = collectDeviceDependencies(composite, source.boxGraph)
            const data = ClipboardUtils.serializeBoxes([composite, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph, makePasteMapper(targetAU, false, false))
            })
            const pastedComposites = targetAU.audioEffects.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, AudioEffectCompositeBox))
                .map(pointer => pointer.box as AudioEffectCompositeBox)
            expect(pastedComposites.length).toBe(1)
            const pastedEntries = pastedComposites[0].entries.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, AudioEffectCompositeCellBox))
                .map(pointer => pointer.box as AudioEffectCompositeCellBox)
            expect(pastedEntries.length).toBe(1)
            expect(pastedEntries[0].audioEffects.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, StereoToolDeviceBox)).length,
            "the nested effect came along, hosted by the entry").toBe(1)
            expect(targetAU.audioEffects.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, StereoToolDeviceBox)).length,
            "and was NOT flattened onto the top host").toBe(0)
        })
        it("re-indexes only the top-level composite on paste, so it lands before the following device", () => {
            const sourceAU = createAudioUnit(source)
            const {composite} = addComposite(source, sourceAU)
            const deps = collectDeviceDependencies(composite, source.boxGraph)
            const data = ClipboardUtils.serializeBoxes([composite, ...deps])
            const targetAU = createAudioUnit(target)
            const existing = addAudioEffect(target, targetAU, "Reverb", 0)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                // Insert at index 0 (before the existing effect): the handler shifts existing effects up by the
                // copied top-level count (1), then re-indexes the pasted top-level effects from the insert index.
                existing.index.setValue(existing.index.getValue() + 1)
                const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph, makePasteMapper(targetAU, false, false))
                DevicesClipboard.reindexPastedTopLevelEffects(boxes,
                    Option.wrap(targetAU.audioEffects.address), Option.None, 0, 0)
            })
            const pastedComposite = target.boxGraph.boxes()
                .find(box => box instanceof AudioEffectCompositeBox) as AudioEffectCompositeBox
            expect(pastedComposite.index.getValue(), "the composite takes the insert slot").toBe(0)
            expect(pastedComposite.index.getValue(), "and sits before the following device")
                .toBeLessThan(existing.index.getValue())
            const pastedNested = target.boxGraph.boxes()
                .find(box => box instanceof StereoToolDeviceBox) as StereoToolDeviceBox
            expect(pastedNested.index.getValue(),
                "the nested effect keeps its in-entry index, not a top-level slot").toBe(0)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Audio effect with automation: copy scope + paste round-trip
    // ─────────────────────────────────────────────────────────

    describe("audio effect with automation", () => {
        it("includes ValueEventCollectionBox when copying effect with automation events", () => {
            const audioUnit = createAudioUnit(source)
            const effect = addAudioEffect(source, audioUnit, "Comp", 0)
            const autoTrack = addAutomationTrack(source, audioUnit, effect.threshold, 0)
            addValueRegion(source, autoTrack, 0, 960)
            const deps = collectDeviceDependencies(effect, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(1)
            expect(deps.filter(box => isInstanceOf(box, ValueRegionBox)).length).toBe(1)
            expect(deps.filter(box => isInstanceOf(box, ValueEventCollectionBox)).length).toBe(1)
        })
        it("includes mirror regions on different tracks of the same device", () => {
            const audioUnit = createAudioUnit(source)
            const effect = addAudioEffect(source, audioUnit, "Comp", 0)
            const trackA = addAutomationTrack(source, audioUnit, effect.threshold, 0)
            const trackB = addAutomationTrack(source, audioUnit, effect.ratio, 1)
            const regionA = addValueRegion(source, trackA, 0, 960)
            const sharedEvents = regionA.events.targetVertex.unwrap().box as ValueEventCollectionBox
            let regionB!: ValueRegionBox
            source.boxGraph.beginTransaction()
            regionB = ValueRegionBox.create(source.boxGraph, UUID.generate(), box => {
                box.regions.refer(trackB.regions)
                box.events.refer(sharedEvents.owners)
                box.position.setValue(0)
                box.duration.setValue(960)
            })
            source.boxGraph.endTransaction()
            const deps = collectDeviceDependencies(effect, source.boxGraph)
            const regions = deps.filter(box => isInstanceOf(box, ValueRegionBox))
            expect(regions.length).toBe(2)
            expect(regions).toContain(regionA)
            expect(regions).toContain(regionB)
            expect(deps.filter(box => isInstanceOf(box, ValueEventCollectionBox)).length).toBe(1)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(2)
        })
        it("does not pull in regions from unrelated devices that mirror the same collection", () => {
            const audioUnitA = createAudioUnit(source, 1)
            const effectA = addAudioEffect(source, audioUnitA, "CompA", 0)
            const trackA = addAutomationTrack(source, audioUnitA, effectA.threshold, 0)
            const regionA = addValueRegion(source, trackA, 0, 960)
            const sharedEvents = regionA.events.targetVertex.unwrap().box as ValueEventCollectionBox
            const audioUnitB = createAudioUnit(source, 2)
            const effectB = addAudioEffect(source, audioUnitB, "CompB", 0)
            const trackB = addAutomationTrack(source, audioUnitB, effectB.threshold, 0)
            source.boxGraph.beginTransaction()
            const unrelatedRegion = ValueRegionBox.create(source.boxGraph, UUID.generate(), box => {
                box.regions.refer(trackB.regions)
                box.events.refer(sharedEvents.owners)
                box.position.setValue(0)
                box.duration.setValue(960)
            })
            source.boxGraph.endTransaction()
            const deps = collectDeviceDependencies(effectA, source.boxGraph)
            const regions = deps.filter(box => isInstanceOf(box, ValueRegionBox))
            expect(regions).toContain(regionA)
            expect(regions).not.toContain(unrelatedRegion)
            const tracks = deps.filter(box => isInstanceOf(box, TrackBox))
            expect(tracks).toContain(trackA)
            expect(tracks).not.toContain(trackB)
        })
        it("round-trip paste of effect with automation events does not throw", () => {
            const sourceAU = createAudioUnit(source)
            const effect = addAudioEffect(source, sourceAU, "Comp", 0)
            const autoTrack = addAutomationTrack(source, sourceAU, effect.threshold, 0)
            addValueRegion(source, autoTrack, 0, 960)
            const deps = collectDeviceDependencies(effect, source.boxGraph)
            const data = ClipboardUtils.serializeBoxes([effect, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            expect(() => {
                editing.modify(() => {
                    ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                        makePasteMapper(targetAU, false, false))
                })
            }).not.toThrow()
            const pastedEffects = targetAU.audioEffects.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, CompressorDeviceBox))
            expect(pastedEffects.length).toBe(1)
            const pastedTracks = targetAU.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
            expect(pastedTracks.length).toBe(1)
        })
        it("pasted automation track targets the pasted device's parameter", () => {
            const sourceAU = createAudioUnit(source)
            const effect = addAudioEffect(source, sourceAU, "Comp", 0)
            const autoTrack = addAutomationTrack(source, sourceAU, effect.threshold, 0)
            addValueRegion(source, autoTrack, 0, 960)
            const deps = collectDeviceDependencies(effect, source.boxGraph)
            const data = ClipboardUtils.serializeBoxes([effect, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false, false))
            })
            const pastedEffect = targetAU.audioEffects.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, CompressorDeviceBox))
                .map(pointer => pointer.box as CompressorDeviceBox)[0]
            const pastedTrack = targetAU.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => pointer.box as TrackBox)[0]
            expect(pastedTrack).toBeDefined()
            const targetVertex = pastedTrack.target.targetVertex.unwrap()
            expect(targetVertex.box).toBe(pastedEffect)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Instrument paste
    // ─────────────────────────────────────────────────────────

    describe("paste instrument", () => {
        it("pastes instrument when replaceInstrument is true", () => {
            const sourceAU = createAudioUnit(source)
            addTapeInstrument(source, sourceAU, "Source Tape")
            const sourceInstrument = sourceAU.input.pointerHub.incoming()[0].box as TapeDeviceBox
            const data = ClipboardUtils.serializeBoxes([sourceInstrument])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, true))
            })
            expect(targetAU.input.pointerHub.incoming().length).toBe(1)
        })
        it("excludes instrument when replaceInstrument is false", () => {
            const sourceAU = createAudioUnit(source)
            addTapeInstrument(source, sourceAU, "Source Tape")
            const sourceInstrument = sourceAU.input.pointerHub.incoming()[0].box as TapeDeviceBox
            const data = ClipboardUtils.serializeBoxes([sourceInstrument])
            const targetAU = createAudioUnit(target)
            addTapeInstrument(target, targetAU, "Existing Tape")
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false))
            })
            const inputs = targetAU.input.pointerHub.incoming()
            expect(inputs.length).toBe(1)
            expect((inputs[0].box as TapeDeviceBox).label.getValue()).toBe("Existing Tape")
        })
        // #1049-#1051: copying an instrument bundles the unit's note tracks + regions. Pasting WITHOUT
        // replacing must drop that whole timeline subtree; otherwise a NoteRegionBox is deserialized without
        // its (excluded) track and its mandatory `regions` pointer dangles, rejecting the transaction.
        it("drops the bundled note structure (no dangling regions pointer) when not replacing (#1049)", () => {
            const sourceAU = createAudioUnit(source)
            const vapo = addVaporisateur(source, sourceAU, "Source Vapo")
            const noteTrack = addTrack(source, sourceAU, TrackType.Notes, 0)
            addNoteRegion(source, noteTrack, 0, 1920)
            const deps = collectDeviceDependencies(vapo, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([vapo, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            expect(() => {
                editing.modify(() => {
                    ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                        makePasteMapper(targetAU, false, true))
                })
            }).not.toThrow()
            const pastedTracks = targetAU.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
            expect(pastedTracks.length).toBe(0)
            expect(target.boxGraph.boxes().some(box => isInstanceOf(box, NoteRegionBox))).toBe(false)
        })
    })

    // ─────────────────────────────────────────────────────────
    // TrackBox exclusion
    // ─────────────────────────────────────────────────────────

    describe("TrackBox exclusion", () => {
        it("does not collect TrackBox as device dependency", () => {
            const audioUnit = createAudioUnit(source)
            const instrument = addTapeInstrument(source, audioUnit, "Test")
            addTrack(source, audioUnit, TrackType.Notes, 0)
            addTrack(source, audioUnit, TrackType.Value, 1)
            const deps = collectDeviceDependencies(instrument, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(0)
        })
        it("does not collect note regions from tracks", () => {
            const audioUnit = createAudioUnit(source)
            const instrument = addTapeInstrument(source, audioUnit, "Tape")
            const noteTrack = addTrack(source, audioUnit, TrackType.Notes, 0)
            addNoteRegion(source, noteTrack, 0, 480)
            addNoteRegion(source, noteTrack, 480, 480)
            expect(noteTrack.regions.pointerHub.incoming().length).toBe(2)
            const deps = collectDeviceDependencies(instrument, source.boxGraph)
            const allBoxes: Box[] = [instrument, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, TrackBox)).length).toBe(0)
            expect(allBoxes.filter(box => isInstanceOf(box, NoteRegionBox)).length).toBe(0)
            expect(allBoxes.filter(box => isInstanceOf(box, NoteEventCollectionBox)).length).toBe(0)
        })
        it("does not collect value regions from automation tracks", () => {
            const audioUnit = createAudioUnit(source)
            const instrument = addTapeInstrument(source, audioUnit, "Tape")
            const autoTrack = addTrack(source, audioUnit, TrackType.Value, 0)
            addValueRegion(source, autoTrack, 0, 960)
            const deps = collectDeviceDependencies(instrument, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(0)
            expect(deps.filter(box => isInstanceOf(box, ValueRegionBox)).length).toBe(0)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Werkstatt/Apparat owned children
    // ─────────────────────────────────────────────────────────

    describe("Werkstatt/Apparat owned children", () => {
        it("collects WerkstattParameterBox as owned child", () => {
            const audioUnit = createAudioUnit(source)
            const apparat = addApparatInstrument(source, audioUnit, "Apparat")
            addWerkstattParam(source, apparat.parameters, "cutoff", 0.5, 0)
            addWerkstattParam(source, apparat.parameters, "resonance", 0.3, 1)
            const deps = collectDeviceDependencies(apparat, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, WerkstattParameterBox)).length).toBe(2)
        })
        it("collects WerkstattSampleBox as owned child", () => {
            const audioUnit = createAudioUnit(source)
            const apparat = addApparatInstrument(source, audioUnit, "Apparat")
            addWerkstattSample(source, apparat.samples, "kick", "kick.wav", 0)
            const deps = collectDeviceDependencies(apparat, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, WerkstattSampleBox)).length).toBe(1)
        })
        it("collects AudioFileBox referenced by WerkstattSampleBox", () => {
            const audioUnit = createAudioUnit(source)
            const apparat = addApparatInstrument(source, audioUnit, "Apparat")
            addWerkstattSample(source, apparat.samples, "grain", "grain.wav", 0)
            const deps = collectDeviceDependencies(apparat, source.boxGraph)
            const allBoxes: Box[] = [apparat, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, WerkstattSampleBox)).length).toBe(1)
            expect(allBoxes.filter(box => isInstanceOf(box, AudioFileBox)).length).toBe(1)
        })
        it("collects multiple parameters and samples together", () => {
            const audioUnit = createAudioUnit(source)
            const apparat = addApparatInstrument(source, audioUnit, "Apparat")
            addWerkstattParam(source, apparat.parameters, "cutoff", 0.5, 0)
            addWerkstattParam(source, apparat.parameters, "resonance", 0.3, 1)
            addWerkstattSample(source, apparat.samples, "kick", "kick.wav", 0)
            addWerkstattSample(source, apparat.samples, "snare", "snare.wav", 1)
            const deps = collectDeviceDependencies(apparat, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, WerkstattParameterBox)).length).toBe(2)
            expect(deps.filter(box => isInstanceOf(box, WerkstattSampleBox)).length).toBe(2)
            expect(deps.filter(box => isInstanceOf(box, AudioFileBox)).length).toBe(2)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Playfield sample collection
    // ─────────────────────────────────────────────────────────

    describe("Playfield sample collection", () => {
        it("PlayfieldSampleBox is tagged as device", () => {
            const audioUnit = createAudioUnit(source)
            const playfield = addPlayfieldInstrument(source, audioUnit, "Playfield")
            const {sample} = addPlayfieldSample(source, playfield, "kick.wav", 36)
            expect(DeviceBoxUtils.isDeviceBox(sample)).toBe(true)
        })
        it("collects PlayfieldSampleBox as owned child despite device tags", () => {
            const audioUnit = createAudioUnit(source)
            const playfield = addPlayfieldInstrument(source, audioUnit, "Playfield")
            addPlayfieldSample(source, playfield, "kick.wav", 36)
            const deps = collectDeviceDependencies(playfield, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, PlayfieldSampleBox)).length).toBe(1)
        })
        it("collects all PlayfieldSampleBoxes with multiple samples", () => {
            const audioUnit = createAudioUnit(source)
            const playfield = addPlayfieldInstrument(source, audioUnit, "Playfield")
            addPlayfieldSample(source, playfield, "kick.wav", 36)
            addPlayfieldSample(source, playfield, "snare.wav", 38)
            addPlayfieldSample(source, playfield, "hihat.wav", 42)
            const deps = collectDeviceDependencies(playfield, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, PlayfieldSampleBox)).length).toBe(3)
        })
        it("collects AudioFileBox for each PlayfieldSampleBox", () => {
            const audioUnit = createAudioUnit(source)
            const playfield = addPlayfieldInstrument(source, audioUnit, "Playfield")
            addPlayfieldSample(source, playfield, "kick.wav", 36)
            addPlayfieldSample(source, playfield, "snare.wav", 38)
            const deps = collectDeviceDependencies(playfield, source.boxGraph)
            const allBoxes: Box[] = [playfield, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, PlayfieldSampleBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, AudioFileBox)).length).toBe(2)
        })
        it("shares AudioFileBox when two samples reference the same file", () => {
            const audioUnit = createAudioUnit(source)
            const playfield = addPlayfieldInstrument(source, audioUnit, "Playfield")
            const {audioFile: sharedFile} = addPlayfieldSample(source, playfield, "kick.wav", 36)
            source.boxGraph.beginTransaction()
            PlayfieldSampleBox.create(source.boxGraph, UUID.generate(), box => {
                box.device.refer(playfield.samples)
                box.file.refer(sharedFile)
                box.icon.setValue("drum")
                box.index.setValue(48)
            })
            source.boxGraph.endTransaction()
            const deps = collectDeviceDependencies(playfield, source.boxGraph)
            const allBoxes: Box[] = [playfield, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, PlayfieldSampleBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, AudioFileBox)).length).toBe(1)
        })
        it("clipboard contains device + samples + audio files", () => {
            const audioUnit = createAudioUnit(source)
            const playfield = addPlayfieldInstrument(source, audioUnit, "Playfield")
            addPlayfieldSample(source, playfield, "kick.wav", 36)
            addPlayfieldSample(source, playfield, "snare.wav", 38)
            addPlayfieldSample(source, playfield, "hihat.wav", 42)
            const deps = collectDeviceDependencies(playfield, source.boxGraph)
            const allBoxes: Box[] = [playfield, ...deps]
            expect(allBoxes.length).toBe(1 + 3 + 3)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Track re-indexing after instrument replacement
    // ─────────────────────────────────────────────────────────

    describe("track re-indexing after instrument replacement", () => {
        const reindexSurvivingTracks = (audioUnit: AudioUnitBox): void => {
            const surviving = audioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => pointer.box as TrackBox)
                .sort((trackA, trackB) => trackA.index.getValue() - trackB.index.getValue())
            surviving.forEach((track, idx) => track.index.setValue(idx))
        }
        const getTrackIndices = (audioUnit: AudioUnitBox): number[] =>
            audioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => (pointer.box as TrackBox).index.getValue())
                .sort()
        it("leaves gap when middle track is deleted without re-indexing", () => {
            const audioUnit = createAudioUnit(source)
            addTapeInstrument(source, audioUnit, "Test")
            addTrack(source, audioUnit, TrackType.Notes, 0)
            const middle = addTrack(source, audioUnit, TrackType.Notes, 1)
            addTrack(source, audioUnit, TrackType.Notes, 2)
            source.boxGraph.beginTransaction()
            middle.delete()
            source.boxGraph.endTransaction()
            expect(getTrackIndices(audioUnit)).toEqual([0, 2])
        })
        it("re-indexes to contiguous after middle track deletion", () => {
            const audioUnit = createAudioUnit(source)
            addTapeInstrument(source, audioUnit, "Test")
            const track0 = addTrack(source, audioUnit, TrackType.Notes, 0)
            const track1 = addTrack(source, audioUnit, TrackType.Notes, 1)
            const track2 = addTrack(source, audioUnit, TrackType.Notes, 2)
            source.boxGraph.beginTransaction()
            track1.delete()
            reindexSurvivingTracks(audioUnit)
            source.boxGraph.endTransaction()
            expect(getTrackIndices(audioUnit)).toEqual([0, 1])
            expect(track0.index.getValue()).toBe(0)
            expect(track2.index.getValue()).toBe(1)
        })
        it("re-indexes after deleting multiple non-adjacent tracks", () => {
            const audioUnit = createAudioUnit(source)
            addTapeInstrument(source, audioUnit, "Test")
            const track0 = addTrack(source, audioUnit, TrackType.Notes, 0)
            const track1 = addTrack(source, audioUnit, TrackType.Notes, 1)
            const track2 = addTrack(source, audioUnit, TrackType.Notes, 2)
            const track3 = addTrack(source, audioUnit, TrackType.Notes, 3)
            source.boxGraph.beginTransaction()
            track1.delete()
            track3.delete()
            reindexSurvivingTracks(audioUnit)
            source.boxGraph.endTransaction()
            expect(getTrackIndices(audioUnit)).toEqual([0, 1])
            expect(track0.index.getValue()).toBe(0)
            expect(track2.index.getValue()).toBe(1)
        })
        it("no-op when no tracks are deleted", () => {
            const audioUnit = createAudioUnit(source)
            addTapeInstrument(source, audioUnit, "Test")
            addTrack(source, audioUnit, TrackType.Notes, 0)
            addTrack(source, audioUnit, TrackType.Notes, 1)
            source.boxGraph.beginTransaction()
            reindexSurvivingTracks(audioUnit)
            source.boxGraph.endTransaction()
            expect(getTrackIndices(audioUnit)).toEqual([0, 1])
        })
        it("handles all tracks deleted", () => {
            const audioUnit = createAudioUnit(source)
            addTapeInstrument(source, audioUnit, "Test")
            const track0 = addTrack(source, audioUnit, TrackType.Notes, 0)
            const track1 = addTrack(source, audioUnit, TrackType.Notes, 1)
            source.boxGraph.beginTransaction()
            track0.delete()
            track1.delete()
            reindexSurvivingTracks(audioUnit)
            source.boxGraph.endTransaction()
            expect(getTrackIndices(audioUnit)).toEqual([])
        })
        it("re-indexes after deleting first track", () => {
            const audioUnit = createAudioUnit(source)
            addTapeInstrument(source, audioUnit, "Test")
            const track0 = addTrack(source, audioUnit, TrackType.Notes, 0)
            const track1 = addTrack(source, audioUnit, TrackType.Notes, 1)
            const track2 = addTrack(source, audioUnit, TrackType.Notes, 2)
            source.boxGraph.beginTransaction()
            track0.delete()
            reindexSurvivingTracks(audioUnit)
            source.boxGraph.endTransaction()
            expect(getTrackIndices(audioUnit)).toEqual([0, 1])
            expect(track1.index.getValue()).toBe(0)
            expect(track2.index.getValue()).toBe(1)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Full instrument copy: tracks + regions + events
    // ─────────────────────────────────────────────────────────

    describe("full instrument copy: tracks, regions, events", () => {
        it("collects automation track targeting instrument as ownedChild", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            addAutomationTrack(source, audioUnit, vaporisateur.cutoff, 0)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(1)
        })
        it("collects multiple automation tracks targeting different parameters", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            addAutomationTrack(source, audioUnit, vaporisateur.cutoff, 0)
            addAutomationTrack(source, audioUnit, vaporisateur.resonance, 1)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(2)
        })
        it("collects note track (targets AudioUnitBox)", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            addTrack(source, audioUnit, TrackType.Notes, 0)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(1)
        })
        it("collects note track with its regions and event collections", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            const noteTrack = addTrack(source, audioUnit, TrackType.Notes, 0)
            addNoteRegion(source, noteTrack, 0, 480)
            addNoteRegion(source, noteTrack, 480, 480)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            const allBoxes: Box[] = [vaporisateur, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, TrackBox)).length).toBe(1)
            expect(allBoxes.filter(box => isInstanceOf(box, NoteRegionBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, NoteEventCollectionBox)).length).toBe(2)
        })
        it("collects automation track with its value regions and event collections", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            const autoTrack = addAutomationTrack(source, audioUnit, vaporisateur.cutoff, 0)
            addValueRegion(source, autoTrack, 0, 960)
            addValueRegion(source, autoTrack, 960, 960)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            const allBoxes: Box[] = [vaporisateur, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, TrackBox)).length).toBe(1)
            expect(allBoxes.filter(box => isInstanceOf(box, ValueRegionBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, ValueEventCollectionBox)).length).toBe(2)
        })
        it("collects both note track and automation track", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            addTrack(source, audioUnit, TrackType.Notes, 0)
            addAutomationTrack(source, audioUnit, vaporisateur.cutoff, 1)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            expect(deps.filter(box => isInstanceOf(box, TrackBox)).length).toBe(2)
        })
        it("collects complete instrument with 2 tracks, 4 regions, 4 event collections", () => {
            const audioUnit = createAudioUnit(source)
            const vaporisateur = addVaporisateur(source, audioUnit, "Vapo")
            const noteTrack = addTrack(source, audioUnit, TrackType.Notes, 0)
            addNoteRegion(source, noteTrack, 0, 480)
            addNoteRegion(source, noteTrack, 480, 480)
            const autoTrack = addAutomationTrack(source, audioUnit, vaporisateur.cutoff, 1)
            addValueRegion(source, autoTrack, 0, 960)
            addValueRegion(source, autoTrack, 960, 960)
            const deps = collectDeviceDependencies(vaporisateur, source.boxGraph, audioUnit)
            const allBoxes: Box[] = [vaporisateur, ...deps]
            expect(allBoxes.filter(box => isInstanceOf(box, VaporisateurDeviceBox)).length).toBe(1)
            expect(allBoxes.filter(box => isInstanceOf(box, TrackBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, NoteRegionBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, NoteEventCollectionBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, ValueRegionBox)).length).toBe(2)
            expect(allBoxes.filter(box => isInstanceOf(box, ValueEventCollectionBox)).length).toBe(2)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Paste replace: automation track override (no duplicates)
    // ─────────────────────────────────────────────────────────

    describe("paste replace automation override", () => {
        it("paste-replace creates new automation track from clipboard", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source Vapo")
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 0)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const allSourceBoxes: Box[] = [sourceVapo, ...deps]
            const data = ClipboardUtils.serializeBoxes(allSourceBoxes)
            const targetAU = createAudioUnit(target)
            target.boxGraph.beginTransaction()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                makePasteMapper(targetAU, true))
            target.boxGraph.endTransaction()
            const pastedTracks = boxes.filter(box => isInstanceOf(box, TrackBox))
            expect(pastedTracks.length).toBe(1)
            const pastedInstruments = boxes.filter(box => isInstanceOf(box, VaporisateurDeviceBox))
            expect(pastedInstruments.length).toBe(1)
        })
        it("excludes automation tracks when replaceInstrument is false", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source Vapo")
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 0)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const allSourceBoxes: Box[] = [sourceVapo, ...deps]
            const data = ClipboardUtils.serializeBoxes(allSourceBoxes)
            const targetAU = createAudioUnit(target)
            addVaporisateur(target, targetAU, "Existing Vapo")
            target.boxGraph.beginTransaction()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                makePasteMapper(targetAU, false))
            target.boxGraph.endTransaction()
            const pastedTracks = boxes.filter(box => isInstanceOf(box, TrackBox))
            expect(pastedTracks.length).toBe(0)
            const pastedInstruments = boxes.filter(box => isInstanceOf(box, VaporisateurDeviceBox))
            expect(pastedInstruments.length).toBe(0)
        })
        it("parameter cannot have two automation tracks after paste-replace", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source Vapo")
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 0)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceVapo, ...deps])
            const targetAU = createAudioUnit(target)
            const targetVapo = addVaporisateur(target, targetAU, "Target Vapo")
            addAutomationTrack(target, targetAU, targetVapo.cutoff, 0)
            const oldTrackCount = targetAU.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox)).length
            expect(oldTrackCount).toBe(1)
            target.boxGraph.beginTransaction()
            const oldUuid = targetVapo.address.uuid
            for (const pointer of targetAU.tracks.pointerHub.filter(Pointers.TrackCollection)) {
                if (isInstanceOf(pointer.box, TrackBox)) {
                    pointer.box.target.targetVertex.ifSome(targetVertex => {
                        if (UUID.equals(targetVertex.box.address.uuid, oldUuid)) {
                            pointer.box.delete()
                        }
                    })
                }
            }
            targetVapo.delete()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                makePasteMapper(targetAU, true))
            target.boxGraph.endTransaction()
            const newTracks = boxes.filter(box => isInstanceOf(box, TrackBox))
            expect(newTracks.length).toBe(1)
            const allTracks = targetAU.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
            expect(allTracks.length).toBe(1)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Paste note track target remapping (Pointers.Automation)
    // ─────────────────────────────────────────────────────────

    describe("paste note track target remapping", () => {
        it("remaps note track target (Pointers.Automation) to target AudioUnitBox", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceVapo, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, true))
            })
            const pastedTracks = targetAU.tracks.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
            expect(pastedTracks.length).toBe(1)
        })
        it("remaps note track + automation track targets on paste-replace", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 1)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceVapo, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, true))
            })
            const pastedTracks = targetAU.tracks.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
            expect(pastedTracks.length).toBe(2)
        })
        it("note track with regions pastes without crash via BoxEditing.modify", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            const noteTrack = addTrack(source, sourceAU, TrackType.Notes, 0)
            addNoteRegion(source, noteTrack, 0, 480)
            addNoteRegion(source, noteTrack, 480, 480)
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 1)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceVapo, ...deps])
            const targetAU = createAudioUnit(target)
            const editing = new BoxEditing(target.boxGraph)
            expect(() => {
                editing.modify(() => {
                    ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                        makePasteMapper(targetAU, true))
                })
            }).not.toThrow()
        })
    })

    // ─────────────────────────────────────────────────────────
    // Paste into target without selected instrument
    // ─────────────────────────────────────────────────────────

    describe("paste without selected instrument", () => {
        it("pastes instrument when no instrument is selected (replaceInstrument false)", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            const deps = collectDeviceDependencies(sourceVapo, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceVapo, ...deps])
            const targetAU = createAudioUnit(target)
            target.boxGraph.beginTransaction()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph, {
                mapPointer: pointer => {
                    if (pointer.pointerType === Pointers.InstrumentHost) {
                        return Option.wrap(targetAU.input.address)
                    }
                    if (pointer.pointerType === Pointers.TrackCollection) {
                        return Option.wrap(targetAU.tracks.address)
                    }
                    if (pointer.pointerType === Pointers.Automation) {
                        return Option.wrap(targetAU.address)
                    }
                    return Option.None
                },
                excludeBox: () => false
            })
            target.boxGraph.endTransaction()
            expect(boxes.filter(box => isInstanceOf(box, VaporisateurDeviceBox)).length).toBe(1)
            expect(boxes.filter(box => isInstanceOf(box, TrackBox)).length).toBe(1)
        })
    })

    // ─────────────────────────────────────────────────────────
    // End-to-end paste-replace track index integrity
    // ─────────────────────────────────────────────────────────

    describe("paste-replace track index integrity", () => {
        const getTrackIndices = (audioUnit: AudioUnitBox): number[] =>
            audioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => (pointer.box as TrackBox).index.getValue())
                .sort()
        const simulatePasteReplace = (
            sourceInstrument: Box,
            sourceAudioUnit: AudioUnitBox,
            sourceBoxGraph: BoxGraph,
            targetAudioUnit: AudioUnitBox,
            targetInstrument: Box,
            targetBoxGraph: BoxGraph
        ): ReadonlyArray<Box> => {
            const deps = collectDeviceDependencies(sourceInstrument, sourceBoxGraph, sourceAudioUnit)
            const data = ClipboardUtils.serializeBoxes([sourceInstrument, ...deps])
            targetBoxGraph.beginTransaction()
            for (const pointer of targetAudioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)) {
                if (isInstanceOf(pointer.box, TrackBox)) {
                    pointer.box.delete()
                }
            }
            targetInstrument.delete()
            const boxes = ClipboardUtils.deserializeBoxes(data, targetBoxGraph,
                makePasteMapper(targetAudioUnit, true))
            const allTracks = targetAudioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => pointer.box as TrackBox)
                .sort((trackA, trackB) => trackA.index.getValue() - trackB.index.getValue())
            allTracks.forEach((track, idx) => track.index.setValue(idx))
            targetBoxGraph.endTransaction()
            return boxes
        }
        it("replaces all target tracks with source tracks", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 5)
            const targetAU = createAudioUnit(target)
            addTrack(target, targetAU, TrackType.Notes, 0)
            const targetVapo = addVaporisateur(target, targetAU, "Target")
            addAutomationTrack(target, targetAU, targetVapo.cutoff, 1)
            simulatePasteReplace(sourceVapo, sourceAU, source.boxGraph, targetAU, targetVapo, target.boxGraph)
            const indices = getTrackIndices(targetAU)
            expect(indices).toEqual([0, 1])
        })
        it("replaces all target tracks even when source has more tracks", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 10)
            addAutomationTrack(source, sourceAU, sourceVapo.resonance, 20)
            const targetAU = createAudioUnit(target)
            addTrack(target, targetAU, TrackType.Notes, 0)
            addTrack(target, targetAU, TrackType.Notes, 1)
            const targetVapo = addVaporisateur(target, targetAU, "Target")
            addAutomationTrack(target, targetAU, targetVapo.cutoff, 2)
            simulatePasteReplace(sourceVapo, sourceAU, source.boxGraph, targetAU, targetVapo, target.boxGraph)
            const indices = getTrackIndices(targetAU)
            expect(indices).toEqual([0, 1, 2])
        })
        it("paste-replace with no existing tracks produces contiguous from 0", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 7)
            const targetAU = createAudioUnit(target)
            const targetVapo = addVaporisateur(target, targetAU, "Target")
            simulatePasteReplace(sourceVapo, sourceAU, source.boxGraph, targetAU, targetVapo, target.boxGraph)
            const indices = getTrackIndices(targetAU)
            expect(indices).toEqual([0])
        })
        it("paste-replace onto self preserves note track and replaces automation", () => {
            const audioUnit = createAudioUnit(source)
            const vapo = addVaporisateur(source, audioUnit, "Vapo")
            addTrack(source, audioUnit, TrackType.Notes, 0)
            addAutomationTrack(source, audioUnit, vapo.cutoff, 1)
            const deps = collectDeviceDependencies(vapo, source.boxGraph, audioUnit)
            const data = ClipboardUtils.serializeBoxes([vapo, ...deps])
            source.boxGraph.beginTransaction()
            for (const pointer of audioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)) {
                if (isInstanceOf(pointer.box, TrackBox)) {
                    pointer.box.delete()
                }
            }
            vapo.delete()
            ClipboardUtils.deserializeBoxes(data, source.boxGraph,
                makePasteMapper(audioUnit, true))
            const allTracks = audioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox))
                .map(pointer => pointer.box as TrackBox)
                .sort((trackA, trackB) => trackA.index.getValue() - trackB.index.getValue())
            allTracks.forEach((track, idx) => track.index.setValue(idx))
            source.boxGraph.endTransaction()
            const indices = getTrackIndices(audioUnit)
            expect(indices).toEqual([0, 1])
            const trackCount = audioUnit.tracks.pointerHub.filter(Pointers.TrackCollection)
                .filter(pointer => isInstanceOf(pointer.box, TrackBox)).length
            expect(trackCount).toBe(2)
            const instrumentCount = audioUnit.input.pointerHub.incoming().length
            expect(instrumentCount).toBe(1)
        })
        it("no index gaps when source track had high index", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 99)
            const targetAU = createAudioUnit(target)
            const targetVapo = addVaporisateur(target, targetAU, "Target")
            simulatePasteReplace(sourceVapo, sourceAU, source.boxGraph, targetAU, targetVapo, target.boxGraph)
            const indices = getTrackIndices(targetAU)
            expect(indices).toEqual([0, 1])
        })
        it("no duplicate indices after paste-replace", () => {
            const sourceAU = createAudioUnit(source)
            const sourceVapo = addVaporisateur(source, sourceAU, "Source")
            addTrack(source, sourceAU, TrackType.Notes, 0)
            addAutomationTrack(source, sourceAU, sourceVapo.cutoff, 0)
            const targetAU = createAudioUnit(target)
            addTrack(target, targetAU, TrackType.Notes, 0)
            const targetVapo = addVaporisateur(target, targetAU, "Target")
            simulatePasteReplace(sourceVapo, sourceAU, source.boxGraph, targetAU, targetVapo, target.boxGraph)
            const indices = getTrackIndices(targetAU)
            expect(indices).toEqual([0, 1])
            const uniqueIndices = new Set(indices)
            expect(uniqueIndices.size).toBe(indices.length)
        })
    })

    // ─────────────────────────────────────────────────────────
    // Effect index management
    // ─────────────────────────────────────────────────────────

    describe("effect index management", () => {
        it("inserts at position 0 and shifts existing effects", () => {
            const sourceAU = createAudioUnit(source)
            const sourceEffect = addAudioEffect(source, sourceAU, "New", 0)
            const data = ClipboardUtils.serializeBoxes([sourceEffect])
            const targetAU = createAudioUnit(target)
            const existingA = addAudioEffect(target, targetAU, "A", 0)
            const existingB = addAudioEffect(target, targetAU, "B", 1)
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                for (const pointer of targetAU.audioEffects.pointerHub.incoming()) {
                    if (isInstanceOf(pointer.box, CompressorDeviceBox)) {
                        const idx = pointer.box.index.getValue()
                        if (idx >= 0) pointer.box.index.setValue(idx + 1)
                    }
                }
                const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false))
                boxes.filter((box): box is CompressorDeviceBox => isInstanceOf(box, CompressorDeviceBox))
                    .forEach((box, idx) => box.index.setValue(idx))
            })
            expect(existingA.index.getValue()).toBe(1)
            expect(existingB.index.getValue()).toBe(2)
            expect(targetAU.audioEffects.pointerHub.incoming().length).toBe(3)
        })
        it("inserts after selected effect and shifts only subsequent", () => {
            const sourceAU = createAudioUnit(source)
            const sourceEffect = addAudioEffect(source, sourceAU, "New", 0)
            const data = ClipboardUtils.serializeBoxes([sourceEffect])
            const targetAU = createAudioUnit(target)
            const existingA = addAudioEffect(target, targetAU, "A", 0)
            addAudioEffect(target, targetAU, "B", 1)
            const existingC = addAudioEffect(target, targetAU, "C", 2)
            const insertIndex = 2
            const editing = new BoxEditing(target.boxGraph)
            editing.modify(() => {
                for (const pointer of targetAU.audioEffects.pointerHub.incoming()) {
                    if (isInstanceOf(pointer.box, CompressorDeviceBox)) {
                        const idx = pointer.box.index.getValue()
                        if (idx >= insertIndex) pointer.box.index.setValue(idx + 1)
                    }
                }
                const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false))
                boxes.filter((box): box is CompressorDeviceBox => isInstanceOf(box, CompressorDeviceBox))
                    .forEach((box, idx) => box.index.setValue(insertIndex + idx))
            })
            expect(existingA.index.getValue()).toBe(0)
            expect(existingC.index.getValue()).toBe(3)
            expect(targetAU.audioEffects.pointerHub.incoming().length).toBe(4)
            const indices = targetAU.audioEffects.pointerHub.incoming()
                .filter(pointer => isInstanceOf(pointer.box, CompressorDeviceBox))
                .map(pointer => (pointer.box as CompressorDeviceBox).index.getValue())
                .sort()
            expect(indices).toEqual([0, 1, 2, 3])
        })
    })

    // ─────────────────────────────────────────────────────────
    // isInstanceOf type narrowing
    // ─────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────
    // MIDIOutputDeviceBox copy & paste
    // ─────────────────────────────────────────────────────────

    const addMIDIOutputInstrument = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox,
                                     label: string): MIDIOutputDeviceBox => {
        const {boxGraph} = skeleton
        let device!: MIDIOutputDeviceBox
        boxGraph.beginTransaction()
        device = MIDIOutputDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.host.refer(audioUnit.input)
        })
        boxGraph.endTransaction()
        return device
    }

    const connectMIDIOutput = (skeleton: ProjectSkeleton,
                               deviceBox: MIDIOutputDeviceBox,
                               outputId: string, outputLabel: string): MIDIOutputBox => {
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        let midiOutputBox!: MIDIOutputBox
        boxGraph.beginTransaction()
        midiOutputBox = MIDIOutputBox.create(boxGraph, UUID.generate(), box => {
            box.id.setValue(outputId)
            box.label.setValue(outputLabel)
            box.root.refer(rootBox.outputMidiDevices)
        })
        deviceBox.device.refer(midiOutputBox.device)
        boxGraph.endTransaction()
        return midiOutputBox
    }

    describe("MIDIOutputDeviceBox copy & paste", () => {
        it("collects MIDIOutputBox as dependency when device pointer is set", () => {
            const audioUnit = createAudioUnit(source)
            const midiDevice = addMIDIOutputInstrument(source, audioUnit, "MIDIOut")
            connectMIDIOutput(source, midiDevice, "output-1", "MIDI Port 1")
            const deps = collectDeviceDependencies(midiDevice, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, MIDIOutputBox)).length).toBe(1)
        })
        it("does not collect RootBox as dependency", () => {
            const audioUnit = createAudioUnit(source)
            const midiDevice = addMIDIOutputInstrument(source, audioUnit, "MIDIOut")
            connectMIDIOutput(source, midiDevice, "output-1", "MIDI Port 1")
            const deps = collectDeviceDependencies(midiDevice, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, RootBox)).length).toBe(0)
        })
        it("does not collect MIDIOutputBox when device pointer is empty", () => {
            const audioUnit = createAudioUnit(source)
            const midiDevice = addMIDIOutputInstrument(source, audioUnit, "MIDIOut")
            const deps = collectDeviceDependencies(midiDevice, source.boxGraph)
            expect(deps.filter(box => isInstanceOf(box, MIDIOutputBox)).length).toBe(0)
        })
        it("paste MIDIOutput with empty device pointer does not fill it", () => {
            const sourceAU = createAudioUnit(source)
            const sourceMidi = addMIDIOutputInstrument(source, sourceAU, "Source MIDI")
            const deps = collectDeviceDependencies(sourceMidi, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceMidi, ...deps])
            const targetAU = createAudioUnit(target)
            target.boxGraph.beginTransaction()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph, {
                mapPointer: (pointer, address) => {
                    if (address.isEmpty()) {return Option.None}
                    if (pointer.pointerType === Pointers.InstrumentHost) {
                        return Option.wrap(targetAU.input.address)
                    }
                    if (pointer.pointerType === Pointers.MIDIDevice) {
                        return Option.wrap(target.mandatoryBoxes.rootBox.outputMidiDevices.address)
                    }
                    if (pointer.pointerType === Pointers.TrackCollection) {
                        return Option.wrap(targetAU.tracks.address)
                    }
                    if (pointer.pointerType === Pointers.Automation) {
                        return Option.wrap(targetAU.address)
                    }
                    return Option.None
                },
                excludeBox: () => false
            })
            target.boxGraph.endTransaction()
            const pastedDevice = boxes.find(box => isInstanceOf(box, MIDIOutputDeviceBox)) as MIDIOutputDeviceBox
            expect(pastedDevice).toBeDefined()
            expect(pastedDevice.device.isEmpty()).toBe(true)
        })
        it("paste-replace MIDIOutput with connected device does not throw", () => {
            const sourceAU = createAudioUnit(source)
            const sourceMidi = addMIDIOutputInstrument(source, sourceAU, "Source MIDI")
            connectMIDIOutput(source, sourceMidi, "output-1", "MIDI Port 1")
            const deps = collectDeviceDependencies(sourceMidi, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceMidi, ...deps])
            const targetAU = createAudioUnit(target)
            const targetVapo = addVaporisateur(target, targetAU, "Target Vapo")
            expect(() => {
                target.boxGraph.beginTransaction()
                targetVapo.delete()
                ClipboardUtils.deserializeBoxes(data, target.boxGraph, {
                    ...makePasteMapper(targetAU, true),
                    mapPointer: (pointer, address) => {
                        const base = makePasteMapper(targetAU, true).mapPointer(pointer, address)
                        if (base.nonEmpty()) {return base}
                        if (pointer.pointerType === Pointers.MIDIDevice) {
                            return Option.wrap(target.mandatoryBoxes.rootBox.outputMidiDevices.address)
                        }
                        return Option.None
                    }
                })
                target.boxGraph.endTransaction()
            }).not.toThrow()
        })
        it("pasted MIDIOutputBox.root points to target RootBox.outputMidiDevices", () => {
            const sourceAU = createAudioUnit(source)
            const sourceMidi = addMIDIOutputInstrument(source, sourceAU, "Source MIDI")
            connectMIDIOutput(source, sourceMidi, "output-1", "MIDI Port 1")
            const deps = collectDeviceDependencies(sourceMidi, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceMidi, ...deps])
            const targetAU = createAudioUnit(target)
            target.boxGraph.beginTransaction()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph, {
                mapPointer: (pointer, address) => {
                    if (pointer.pointerType === Pointers.InstrumentHost) {
                        return Option.wrap(targetAU.input.address)
                    }
                    if (pointer.pointerType === Pointers.MIDIDevice) {
                        return Option.wrap(target.mandatoryBoxes.rootBox.outputMidiDevices.address)
                    }
                    if (pointer.pointerType === Pointers.TrackCollection) {
                        return Option.wrap(targetAU.tracks.address)
                    }
                    if (pointer.pointerType === Pointers.Automation) {
                        return Option.wrap(targetAU.address)
                    }
                    return Option.None
                },
                excludeBox: () => false
            })
            target.boxGraph.endTransaction()
            const pastedMidiOutputBox = boxes.find(box => isInstanceOf(box, MIDIOutputBox)) as MIDIOutputBox
            expect(pastedMidiOutputBox).toBeDefined()
            expect(pastedMidiOutputBox.root.targetVertex.unwrap().box).toBe(target.mandatoryBoxes.rootBox)
        })
        it("pasted MIDIOutputDeviceBox.device points to pasted MIDIOutputBox", () => {
            const sourceAU = createAudioUnit(source)
            const sourceMidi = addMIDIOutputInstrument(source, sourceAU, "Source MIDI")
            connectMIDIOutput(source, sourceMidi, "output-1", "MIDI Port 1")
            const deps = collectDeviceDependencies(sourceMidi, source.boxGraph, sourceAU)
            const data = ClipboardUtils.serializeBoxes([sourceMidi, ...deps])
            const targetAU = createAudioUnit(target)
            target.boxGraph.beginTransaction()
            const boxes = ClipboardUtils.deserializeBoxes(data, target.boxGraph, {
                mapPointer: (pointer, address) => {
                    if (pointer.pointerType === Pointers.InstrumentHost) {
                        return Option.wrap(targetAU.input.address)
                    }
                    if (pointer.pointerType === Pointers.MIDIDevice) {
                        return Option.wrap(target.mandatoryBoxes.rootBox.outputMidiDevices.address)
                    }
                    if (pointer.pointerType === Pointers.TrackCollection) {
                        return Option.wrap(targetAU.tracks.address)
                    }
                    if (pointer.pointerType === Pointers.Automation) {
                        return Option.wrap(targetAU.address)
                    }
                    return Option.None
                },
                excludeBox: () => false
            })
            target.boxGraph.endTransaction()
            const pastedDevice = boxes.find(box => isInstanceOf(box, MIDIOutputDeviceBox)) as MIDIOutputDeviceBox
            const pastedMidiOutput = boxes.find(box => isInstanceOf(box, MIDIOutputBox)) as MIDIOutputBox
            expect(pastedDevice).toBeDefined()
            expect(pastedMidiOutput).toBeDefined()
            expect(pastedDevice.device.targetVertex.unwrap().box).toBe(pastedMidiOutput)
        })
    })

    describe("isInstanceOf type narrowing", () => {
        it("narrows TrackBox type directly without intermediate null variable", () => {
            const audioUnit = createAudioUnit(source)
            addTrack(source, audioUnit, TrackType.Audio)
            const pointers = audioUnit.tracks.pointerHub.incoming()
            expect(pointers.length).toBe(1)
            expect(isInstanceOf(pointers[0].box, TrackBox)).toBe(true)
            if (isInstanceOf(pointers[0].box, TrackBox)) {
                expect(pointers[0].box.index.getValue()).toBe(0)
            } else {
                expect.unreachable("Expected TrackBox")
            }
        })
    })

    // The reported bug: enter a composite branch, copy+paste a device, undo. Undo must remove the pasted device
    // WITHOUT also reverting the branch navigation. Entering a branch writes the editing-chain pointer UNMARKED
    // (UI-state), so a following MARKED paste folds it into the paste's undo entry. copyDevices now calls
    // editing.mark() first, sealing that navigation as its own step.
    describe("undo after paste keeps you in the branch", () => {
        const uiBoxOf = (skeleton: ProjectSkeleton): UserInterfaceBox =>
            skeleton.boxGraph.boxes().find(box => box instanceof UserInterfaceBox) as UserInterfaceBox
        const enterBranch = (editing: BoxEditing, ui: UserInterfaceBox, cell: AudioEffectCompositeCellBox): void => {
            editing.modify(() => ui.editingDeviceChain.refer(cell), false) // UNMARKED UI-state, like UserEditing.edit
        }
        const pasteInto = (editing: BoxEditing, cell: AudioEffectCompositeCellBox): void => {
            editing.modify(() => CompressorDeviceBox.create(target.boxGraph, UUID.generate(), box => {
                box.host.refer(cell.audioEffects)
                box.index.setValue(1)
            }))
        }
        const inBranch = (ui: UserInterfaceBox, cell: AudioEffectCompositeCellBox): boolean =>
            ui.editingDeviceChain.targetVertex.mapOr(vertex => vertex === cell, false)

        it("WITHOUT sealing, undoing the paste also leaves the branch (the bug)", () => {
            const audioUnit = createAudioUnit(target)
            const {entry} = addComposite(target, audioUnit)
            const ui = uiBoxOf(target)
            const editing = new BoxEditing(target.boxGraph)
            enterBranch(editing, ui, entry)
            pasteInto(editing, entry) // no mark() first: the paste folds the navigation in
            editing.undo()
            expect(entry.audioEffects.pointerHub.incoming().length, "the pasted device is removed").toBe(1)
            expect(inBranch(ui, entry), "and the navigation was reverted too").toBe(false)
        })

        it("copy's editing.mark() seals the navigation so undo keeps you in the branch (the fix)", () => {
            const audioUnit = createAudioUnit(target)
            const {entry} = addComposite(target, audioUnit)
            const ui = uiBoxOf(target)
            const editing = new BoxEditing(target.boxGraph)
            enterBranch(editing, ui, entry)
            editing.mark() // what copyDevices now does before the paste
            pasteInto(editing, entry)
            editing.undo()
            expect(entry.audioEffects.pointerHub.incoming().length, "the pasted device is removed").toBe(1)
            expect(inBranch(ui, entry), "and you stay in the branch").toBe(true)
        })
    })
    // ─────────────────────────────────────────────────────────
    // Modulated devices
    // ─────────────────────────────────────────────────────────

    describe("modulated devices", () => {
        const addCrusher = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox,
                            label: string, index: number = 0): CrusherDeviceBox => {
            const {boxGraph} = skeleton
            let effect!: CrusherDeviceBox
            boxGraph.beginTransaction()
            effect = CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(label)
                box.host.refer(audioUnit.audioEffects)
                box.index.setValue(index)
            })
            boxGraph.endTransaction()
            return effect
        }
        const addModulator = (skeleton: ProjectSkeleton, label: string, index: number = 0): StepsModulatorBox => {
            const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
            let modulator!: StepsModulatorBox
            boxGraph.beginTransaction()
            modulator = StepsModulatorBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.modulators)
                box.label.setValue(label)
                box.index.setValue(index)
            })
            boxGraph.endTransaction()
            return modulator
        }
        const assign = (skeleton: ProjectSkeleton, modulator: StepsModulatorBox,
                        target: Vertex, depth: number = 0.25): ModulationBox => {
            const {boxGraph} = skeleton
            let modulation!: ModulationBox
            boxGraph.beginTransaction()
            modulation = ModulationBox.create(boxGraph, UUID.generate(), box => {
                box.source.refer(modulator.assignments)
                box.target.refer(target)
                box.depth.setValue(depth)
                box.index.setValue(modulator.assignments.pointerHub.incoming().length)
            })
            boxGraph.endTransaction()
            return modulation
        }
        const modulatorsOf = (skeleton: ProjectSkeleton): ReadonlyArray<Box> =>
            skeleton.mandatoryBoxes.rootBox.modulators.pointerHub.incoming().map(({box}) => box)
        const modulationsOf = (skeleton: ProjectSkeleton): ReadonlyArray<ModulationBox> =>
            skeleton.boxGraph.boxes().filter(box => isInstanceOf(box, ModulationBox)) as ModulationBox[]
        const pastedEffectsOf = (audioUnit: AudioUnitBox): ReadonlyArray<CrusherDeviceBox> =>
            audioUnit.audioEffects.pointerHub.incoming()
                .map(({box}) => box)
                .filter(box => isInstanceOf(box, CrusherDeviceBox)) as CrusherDeviceBox[]
        const bundleOf = (skeleton: ProjectSkeleton, device: Box): ArrayBufferLike =>
            ClipboardUtils.serializeBoxes([device, ...collectDeviceDependencies(device, skeleton.boxGraph)])
        const pasteInto = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox, data: ArrayBufferLike): void => {
            new BoxEditing(skeleton.boxGraph).modify(() =>
                ClipboardUtils.deserializeBoxes(data, skeleton.boxGraph, makePasteMapper(audioUnit, false, false)))
        }

        describe("copy bundles the modulator", () => {
            it("collects the ModulationBox of a modulated parameter", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                const modulation = assign(source, modulator, crusher.crush)
                const deps = collectDeviceDependencies(crusher, source.boxGraph)
                expect(deps).toContain(modulation)
            })
            it("collects the modulator the assignment points at", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const deps = collectDeviceDependencies(crusher, source.boxGraph)
                expect(deps).toContain(modulator)
            })
            it("collects both modulators when two drive the same device", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const first = addModulator(source, "Steps A", 0)
                const second = addModulator(source, "Steps B", 1)
                assign(source, first, crusher.crush)
                assign(source, second, crusher.bits)
                const deps = collectDeviceDependencies(crusher, source.boxGraph)
                expect(deps).toContain(first)
                expect(deps).toContain(second)
            })
            it("collects one modulator once when it drives two parameters", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                assign(source, modulator, crusher.bits)
                const deps = collectDeviceDependencies(crusher, source.boxGraph)
                expect(deps.filter(box => box === modulator).length).toBe(1)
            })
            it("does not collect the RootBox the modulator hangs off", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const deps = collectDeviceDependencies(crusher, source.boxGraph)
                expect(deps.some(box => isInstanceOf(box, RootBox))).toBe(false)
            })
            it("collects no modulator for an unmodulated device", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                addModulator(source, "Steps")
                const deps = collectDeviceDependencies(crusher, source.boxGraph)
                expect(deps.some(box => isInstanceOf(box, StepsModulatorBox))).toBe(false)
                expect(deps.some(box => isInstanceOf(box, ModulationBox))).toBe(false)
            })
            it("does not collect a modulator that drives a different device", () => {
                const audioUnit = createAudioUnit(source)
                const copied = addCrusher(source, audioUnit, "Copied", 0)
                const other = addCrusher(source, audioUnit, "Other", 1)
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, other.crush)
                const deps = collectDeviceDependencies(copied, source.boxGraph)
                expect(deps).not.toContain(modulator)
            })
            it("does not collect the same modulator's assignments to OTHER devices", () => {
                const audioUnit = createAudioUnit(source)
                const copied = addCrusher(source, audioUnit, "Copied", 0)
                const other = addCrusher(source, audioUnit, "Other", 1)
                const modulator = addModulator(source, "Steps")
                const mine = assign(source, modulator, copied.crush)
                const foreign = assign(source, modulator, other.crush)
                const deps = collectDeviceDependencies(copied, source.boxGraph)
                expect(deps).toContain(modulator)
                expect(deps).toContain(mine)
                expect(deps).not.toContain(foreign)
            })
            it("collects the modulator of an effect nested in a composite cell", () => {
                const audioUnit = createAudioUnit(source)
                const {composite, nested} = addComposite(source, audioUnit)
                const modulator = addModulator(source, "Steps")
                const modulation = assign(source, modulator, nested.volume)
                const deps = collectDeviceDependencies(composite, source.boxGraph)
                expect(deps).toContain(modulation)
                expect(deps).toContain(modulator)
            })
        })

        describe("duplicate inside the same project", () => {
            it("does not throw", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                expect(() => pasteInto(source, audioUnit, data)).not.toThrow()
            })
            it("adds no second modulator", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                expect(modulatorsOf(source).length).toBe(1)
                expect(modulatorsOf(source)[0]).toBe(modulator)
            })
            it("points the duplicate's assignment at the SAME modulator", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                const modulations = modulationsOf(source)
                expect(modulations.length).toBe(2)
                modulations.forEach(modulation =>
                    expect(modulation.source.targetVertex.unwrap("source").box).toBe(modulator))
            })
            it("targets the duplicate's OWN parameter, not the original's", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                const duplicate = pastedEffectsOf(audioUnit).find(box => box !== crusher)
                expect(isDefined(duplicate)).toBe(true)
                const targets = modulationsOf(source)
                    .map(modulation => modulation.target.targetVertex.unwrap("target"))
                expect(targets.some(vertex => vertex === crusher.crush)).toBe(true)
                expect(targets.some(vertex => vertex === duplicate!.crush)).toBe(true)
            })
            it("keeps depth and enabled through the duplicate", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                const modulation = assign(source, modulator, crusher.crush, 0.75)
                source.boxGraph.beginTransaction()
                modulation.enabled.setValue(false)
                source.boxGraph.endTransaction()
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                const pasted = modulationsOf(source).find(box => box !== modulation)
                expect(isDefined(pasted)).toBe(true)
                expect(pasted!.depth.getValue()).toBeCloseTo(0.75)
                expect(pasted!.enabled.getValue()).toBe(false)
            })
            it("keeps both assignments when one modulator drives two parameters", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                assign(source, modulator, crusher.bits)
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                expect(modulationsOf(source).length).toBe(4)
                expect(modulatorsOf(source).length).toBe(1)
                const duplicate = pastedEffectsOf(audioUnit).find(box => box !== crusher)
                expect(duplicate!.crush.pointerHub.incoming().length).toBe(1)
                expect(duplicate!.bits.pointerHub.incoming().length).toBe(1)
            })
            it("keeps both assignments when two modulators drive one device", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const first = addModulator(source, "Steps A", 0)
                const second = addModulator(source, "Steps B", 1)
                assign(source, first, crusher.crush)
                assign(source, second, crusher.bits)
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                expect(modulatorsOf(source).length).toBe(2)
                const duplicate = pastedEffectsOf(audioUnit).find(box => box !== crusher)
                const sources = modulationsOf(source)
                    .filter(modulation => modulation.target.targetVertex
                        .mapOr(vertex => vertex.box === duplicate, false))
                    .map(modulation => modulation.source.targetVertex.unwrap("source").box)
                expect(sources.length).toBe(2)
                expect(sources).toContain(first)
                expect(sources).toContain(second)
            })
        })

        describe("paste into another project", () => {
            it("does not throw", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                expect(() => pasteInto(target, targetAU, data)).not.toThrow()
            })
            it("creates a modulator copy", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, data)
                expect(modulatorsOf(target).length).toBe(1)
                expect(modulatorsOf(target)[0]).not.toBe(modulator)
            })
            it("attaches the copy to the TARGET project's root", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, data)
                const copy = modulatorsOf(target)[0] as StepsModulatorBox
                expect(copy.collection.targetVertex.unwrap("collection"))
                    .toBe(target.mandatoryBoxes.rootBox.modulators)
                expect(modulatorsOf(source).length).toBe(1)
            })
            it("points the pasted assignment at the copy, not at the source modulator", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, data)
                const copy = modulatorsOf(target)[0]
                const modulations = modulationsOf(target)
                expect(modulations.length).toBe(1)
                expect(modulations[0].source.targetVertex.unwrap("source").box).toBe(copy)
                expect(copy).not.toBe(modulator)
                // The copy keeps the modulator's identity so a repeated paste finds it instead of adding another.
                expect(UUID.toString(copy.address.uuid)).toBe(UUID.toString(modulator.address.uuid))
            })
            it("carries the modulator's own state", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Rumble", 3)
                source.boxGraph.beginTransaction()
                modulator.count.setValue(7)
                source.boxGraph.endTransaction()
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, data)
                const copy = modulatorsOf(target)[0] as StepsModulatorBox
                expect(copy.label.getValue()).toBe("Rumble")
                expect(copy.count.getValue()).toBe(7)
            })
            it("drives the pasted device, not the source device", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, data)
                const pastedDevice = pastedEffectsOf(targetAU)[0]
                expect(modulationsOf(target)[0].target.targetVertex.unwrap("target")).toBe(pastedDevice.crush)
                expect(crusher.crush.pointerHub.incoming().length).toBe(1)
            })
            it("a second paste reuses the modulator the first one created", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, data)
                const copy = modulatorsOf(target)[0]
                pasteInto(target, targetAU, data)
                expect(modulatorsOf(target).length).toBe(1)
                expect(modulatorsOf(target)[0]).toBe(copy)
                const modulations = modulationsOf(target)
                expect(modulations.length).toBe(2)
                modulations.forEach(modulation =>
                    expect(modulation.source.targetVertex.unwrap("source").box).toBe(copy))
            })
        })

        describe("shared modulators and undo", () => {
            it("pastes into another project when the modulator also drives a device left behind", () => {
                const sourceAU = createAudioUnit(source)
                const copied = addCrusher(source, sourceAU, "Copied", 0)
                const other = addCrusher(source, sourceAU, "Other", 1)
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, copied.crush)
                assign(source, modulator, other.crush)
                const data = bundleOf(source, copied)
                const targetAU = createAudioUnit(target)
                expect(() => pasteInto(target, targetAU, data)).not.toThrow()
                expect(modulatorsOf(target).length).toBe(1)
                expect(modulationsOf(target).length).toBe(1)
                expect(modulationsOf(source).length).toBe(2)
            })
            it("keeps one modulator when two devices of one project are pasted into another", () => {
                const sourceAU = createAudioUnit(source)
                const first = addCrusher(source, sourceAU, "First", 0)
                const second = addCrusher(source, sourceAU, "Second", 1)
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, first.crush)
                assign(source, modulator, second.crush)
                const targetAU = createAudioUnit(target)
                pasteInto(target, targetAU, bundleOf(source, first))
                pasteInto(target, targetAU, bundleOf(source, second))
                expect(modulatorsOf(target).length).toBe(1)
                expect(modulationsOf(target).length).toBe(2)
                const copy = modulatorsOf(target)[0]
                modulationsOf(target).forEach(modulation =>
                    expect(modulation.source.targetVertex.unwrap("source").box).toBe(copy))
            })
            it("undoing a duplicate removes the assignment and keeps the modulator", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const editing = new BoxEditing(source.boxGraph)
                editing.modify(() => ClipboardUtils.deserializeBoxes(data, source.boxGraph,
                    makePasteMapper(audioUnit, false, false)))
                expect(modulationsOf(source).length).toBe(2)
                editing.undo()
                expect(modulationsOf(source).length).toBe(1)
                expect(modulatorsOf(source).length).toBe(1)
                expect(modulatorsOf(source)[0]).toBe(modulator)
                expect(crusher.crush.pointerHub.incoming().length).toBe(1)
            })
            it("undoing a cross-project paste removes the modulator copy too", () => {
                const sourceAU = createAudioUnit(source)
                const crusher = addCrusher(source, sourceAU, "Crusher")
                const modulator = addModulator(source, "Steps")
                assign(source, modulator, crusher.crush)
                const data = bundleOf(source, crusher)
                const targetAU = createAudioUnit(target)
                const editing = new BoxEditing(target.boxGraph)
                editing.modify(() => ClipboardUtils.deserializeBoxes(data, target.boxGraph,
                    makePasteMapper(targetAU, false, false)))
                expect(modulatorsOf(target).length).toBe(1)
                editing.undo()
                expect(modulatorsOf(target).length).toBe(0)
                expect(modulationsOf(target).length).toBe(0)
            })
            it("duplicating an unmodulated device leaves the modulator list alone", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                const data = bundleOf(source, crusher)
                pasteInto(source, audioUnit, data)
                expect(modulatorsOf(source).length).toBe(1)
                expect(modulatorsOf(source)[0]).toBe(modulator)
                expect(modulationsOf(source).length).toBe(0)
            })
        })

        describe("paste helpers", () => {
            it("excludes a modulator the target graph already has", () => {
                const modulator = addModulator(source, "Steps")
                expect(DevicesClipboard.excludeExistingModulator(modulator, source.boxGraph)).toBe(true)
            })
            it("keeps a modulator the target graph does not have", () => {
                const modulator = addModulator(source, "Steps")
                expect(DevicesClipboard.excludeExistingModulator(modulator, target.boxGraph)).toBe(false)
            })
            it("never excludes a non-modulator box", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                expect(DevicesClipboard.excludeExistingModulator(crusher, source.boxGraph)).toBe(false)
            })
            it("keeps a resolvable source address", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                const modulation = assign(source, modulator, crusher.crush)
                const mapped = DevicesClipboard.mapModulationPointer(
                    modulation.source, Option.wrap(modulator.assignments.address), source.boxGraph)
                expect(mapped.unwrap("mapped").equals(modulator.assignments.address)).toBe(true)
            })
            it("drops a source address that does not resolve in the target graph", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                const modulator = addModulator(source, "Steps")
                const modulation = assign(source, modulator, crusher.crush)
                const mapped = DevicesClipboard.mapModulationPointer(
                    modulation.source, Option.wrap(modulator.assignments.address), target.boxGraph)
                expect(mapped.isEmpty()).toBe(true)
            })
            it("maps a collection pointer to the target project's root", () => {
                const modulator = addModulator(source, "Steps")
                const mapped = DevicesClipboard.mapModulationPointer(
                    modulator.collection, Option.wrap(source.mandatoryBoxes.rootBox.modulators.address),
                    target.boxGraph)
                expect(mapped.unwrap("mapped").equals(target.mandatoryBoxes.rootBox.modulators.address)).toBe(true)
            })
            it("answers nothing for an unrelated pointer type", () => {
                const audioUnit = createAudioUnit(source)
                const crusher = addCrusher(source, audioUnit, "Crusher")
                expect(DevicesClipboard.mapModulationPointer(
                    crusher.host, Option.wrap(audioUnit.audioEffects.address), source.boxGraph).isEmpty()).toBe(true)
            })
        })
    })
})

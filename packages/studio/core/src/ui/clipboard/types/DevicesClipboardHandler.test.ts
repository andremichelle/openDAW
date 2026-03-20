import {describe, expect, it, beforeEach} from "vitest"
import {isDefined, isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {Box, BoxEditing, BoxGraph, Field} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioFileBox,
    AudioUnitBox,
    CompressorDeviceBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    TapeDeviceBox,
    TrackBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    WerkstattParameterBox,
    WerkstattSampleBox
} from "@opendaw/studio-boxes"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {DeviceBoxUtils, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {ClipboardUtils} from "../ClipboardUtils"

describe("DevicesClipboardHandler", () => {
    let source: ProjectSkeleton
    let target: ProjectSkeleton

    beforeEach(() => {
        source = ProjectSkeleton.empty({createDefaultUser: true, createOutputCompressor: false})
        target = ProjectSkeleton.empty({createDefaultUser: true, createOutputCompressor: false})
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

    // Mirrors the exact dependency collection logic from DevicesClipboardHandler.copyDevices
    const collectDeviceDependencies = (deviceBox: Box, boxGraph: BoxGraph): Box[] => {
        const ownedChildren = deviceBox.incomingEdges()
            .filter(pointer => pointer.mandatory && !pointer.box.ephemeral
                && !isInstanceOf(pointer.box, TrackBox)
                && !isDefined(pointer.box.resource))
            .map(pointer => pointer.box)
        const preserved = [deviceBox, ...ownedChildren].flatMap(root =>
            Array.from(boxGraph.dependenciesOf(root, {
                alwaysFollowMandatory: true,
                excludeBox: (dep: Box) => dep.ephemeral || DeviceBoxUtils.isDeviceBox(dep)
            }).boxes).filter(dep => dep.resource === "preserved"))
        const seen = new Set<string>()
        return [...ownedChildren, ...preserved].filter(box => {
            const uuid = UUID.toString(box.address.uuid)
            if (seen.has(uuid)) return false
            seen.add(uuid)
            return true
        })
    }

    const makePasteMapper = (targetAudioUnit: AudioUnitBox, replaceInstrument: boolean) => ({
        mapPointer: (pointer: {pointerType: unknown}) => {
            if (pointer.pointerType === Pointers.InstrumentHost && replaceInstrument) {
                return Option.wrap(targetAudioUnit.input.address)
            }
            if (pointer.pointerType === Pointers.AudioEffectHost) {
                return Option.wrap(targetAudioUnit.audioEffects.address)
            }
            if (pointer.pointerType === Pointers.MIDIEffectHost) {
                return Option.wrap(targetAudioUnit.midiEffects.address)
            }
            if (pointer.pointerType === Pointers.TrackCollection && replaceInstrument) {
                return Option.wrap(targetAudioUnit.tracks.address)
            }
            return Option.None
        },
        excludeBox: (box: Box) =>
            DeviceBoxUtils.isInstrumentDeviceBox(box) && !replaceInstrument
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
})
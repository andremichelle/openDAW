import {describe, expect, it, beforeEach} from "vitest"
import {isDefined, isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {Box, BoxEditing, BoxGraph, Field, type Vertex} from "@opendaw/lib-box"
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
    VaporisateurDeviceBox,
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
    const collectDeviceDependencies = (deviceBox: Box, boxGraph: BoxGraph,
                                       audioUnit?: AudioUnitBox): Box[] => {
        const ownedChildren = deviceBox.incomingEdges()
            .filter(pointer => pointer.mandatory && !pointer.box.ephemeral
                && !isDefined(pointer.box.resource))
            .map(pointer => pointer.box)
        const preserved = [deviceBox, ...ownedChildren].flatMap(root =>
            Array.from(boxGraph.dependenciesOf(root, {
                alwaysFollowMandatory: true,
                excludeBox: (dep: Box) => dep.ephemeral || DeviceBoxUtils.isDeviceBox(dep)
            }).boxes).filter(dep => dep.resource === "preserved"))
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
                        excludeBox: (dep: Box) => dep.ephemeral
                            || isInstanceOf(dep, TrackBox)
                            || DeviceBoxUtils.isDeviceBox(dep)
                    }).boxes)
                    trackContent.push(...regionDeps)
                }
            }
        }
        const seen = new Set<string>()
        return [...ownedChildren, ...preserved, ...trackContent].filter(box => {
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
            if (pointer.pointerType === Pointers.Automation && replaceInstrument) {
                return Option.wrap(targetAudioUnit.address)
            }
            return Option.None
        },
        excludeBox: (box: Box) =>
            !replaceInstrument && (DeviceBoxUtils.isInstrumentDeviceBox(box) || isInstanceOf(box, TrackBox))
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
import {describe, expect, it} from "vitest"
import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {Box, Vertex} from "@opendaw/lib-box"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureAudioBox,
    CrusherDeviceBox,
    ModulationBox,
    StepsModulatorBox,
    TapeDeviceBox,
    TrackBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TrackType} from "../timeline/TrackType"
import {TransferAudioUnits} from "./TransferAudioUnits"
import {TransferUtils} from "./TransferUtils"

// #385: a modulated device parameter drags its ModulationBox into the transfer (mandatory `target`), but the
// ModulationBox's mandatory `source` points at a project-level modulator (rootBox.modulators) that is NOT part
// of the unit. Copying into another project left `source` dangling: "Pointer {ModulationBox (source) …/1
// requires an edge". The modulator must travel along, and be shared (not duplicated) when already present.
describe("modulators travel with modulated parameters (#385)", () => {
    const empty = (): ProjectSkeleton => ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})

    const createModulatedUnit = (skeleton: ProjectSkeleton): {
        audioUnit: AudioUnitBox, crusher: CrusherDeviceBox, modulator: StepsModulatorBox, modulation: ModulationBox
    } => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
        boxGraph.beginTransaction()
        const audioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        audioUnit.capture.refer(CaptureAudioBox.create(boxGraph, UUID.generate()))
        TapeDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Tape")
            box.host.refer(audioUnit.input)
        })
        const crusher = CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Crusher")
            box.host.refer(audioUnit.audioEffects)
            box.index.setValue(0)
        })
        const modulator = StepsModulatorBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Steps")
            box.index.setValue(0)
        })
        const modulation = assign(boxGraph, modulator, crusher.crush)
        boxGraph.endTransaction()
        return {audioUnit, crusher, modulator, modulation}
    }
    const assign = (boxGraph: ProjectSkeleton["boxGraph"], modulator: StepsModulatorBox, target: Vertex): ModulationBox =>
        ModulationBox.create(boxGraph, UUID.generate(), box => {
            box.source.refer(modulator.assignments)
            box.target.refer(target)
            box.depth.setValue(0.25)
            box.index.setValue(modulator.assignments.pointerHub.incoming().length)
        })
    const addAudioRegion = (skeleton: ProjectSkeleton, audioUnit: AudioUnitBox): AudioRegionBox => {
        const {boxGraph} = skeleton
        boxGraph.beginTransaction()
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(audioUnit.tracks)
            box.target.refer(audioUnit)
            box.index.setValue(0)
        })
        const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(2.0)
            box.fileName.setValue("sample.wav")
        })
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const region = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.file.refer(file)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(1000)
        })
        boxGraph.endTransaction()
        return region
    }
    const modulatorsOf = (skeleton: ProjectSkeleton): ReadonlyArray<Box> =>
        skeleton.mandatoryBoxes.rootBox.modulators.pointerHub.incoming().map(({box}) => box)
    const modulationsOf = (skeleton: ProjectSkeleton): ReadonlyArray<ModulationBox> =>
        skeleton.boxGraph.boxes().filter((box): box is ModulationBox => isInstanceOf(box, ModulationBox))
    const crushersOf = (skeleton: ProjectSkeleton): ReadonlyArray<CrusherDeviceBox> =>
        skeleton.boxGraph.boxes().filter((box): box is CrusherDeviceBox => isInstanceOf(box, CrusherDeviceBox))
    const expectWired = (skeleton: ProjectSkeleton, modulationCount: number): void => {
        const modulators = modulatorsOf(skeleton)
        expect(modulators.length).toBe(1)
        expect(modulators[0].isAttached()).toBe(true)
        const modulations = modulationsOf(skeleton)
        expect(modulations.length).toBe(modulationCount)
        modulations.forEach(modulation => {
            expect(modulation.source.targetVertex.unwrap().box).toBe(modulators[0])
            expect(crushersOf(skeleton).map(crusher => crusher.crush)).toContain(modulation.target.targetVertex.unwrap())
        })
    }

    describe("TransferAudioUnits.transfer", () => {
        it("into another project carries the modulator and wires the assignment to it", () => {
            const source = empty()
            const target = empty()
            const {audioUnit, modulator} = createModulatedUnit(source)
            target.boxGraph.beginTransaction()
            expect(() => TransferAudioUnits.transfer([audioUnit], target)).not.toThrow()
            target.boxGraph.endTransaction()
            expectWired(target, 1)
            expect(UUID.equals(modulatorsOf(target)[0].address.uuid, modulator.address.uuid)).toBe(true)
            expect(modulatorsOf(target)[0].graph).toBe(target.boxGraph)
        })
        it("twice into another project shares one modulator", () => {
            const source = empty()
            const target = empty()
            const {audioUnit} = createModulatedUnit(source)
            target.boxGraph.beginTransaction()
            TransferAudioUnits.transfer([audioUnit], target)
            TransferAudioUnits.transfer([audioUnit], target)
            target.boxGraph.endTransaction()
            expectWired(target, 2)
        })
        it("within the same project shares the existing modulator", () => {
            const source = empty()
            const {audioUnit, modulator} = createModulatedUnit(source)
            source.boxGraph.beginTransaction()
            TransferAudioUnits.transfer([audioUnit], source)
            source.boxGraph.endTransaction()
            expectWired(source, 2)
            expect(modulatorsOf(source)[0]).toBe(modulator)
        })
    })

    describe("TransferUtils.extractRegions", () => {
        it("into another project carries the modulator of the unit's modulated parameter", () => {
            const source = empty()
            const target = empty()
            const {audioUnit} = createModulatedUnit(source)
            const region = addAudioRegion(source, audioUnit)
            target.boxGraph.beginTransaction()
            expect(() => TransferUtils.extractRegions([region], target)).not.toThrow()
            target.boxGraph.endTransaction()
            expectWired(target, 1)
        })
    })
})

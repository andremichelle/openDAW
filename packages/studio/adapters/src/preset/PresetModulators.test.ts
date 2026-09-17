import {describe, expect, it} from "vitest"
import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {Box, Vertex} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    CaptureAudioBox,
    CrusherDeviceBox,
    ModulationBox,
    StepsModulatorBox,
    TapeDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"
import {PresetHeader} from "./PresetHeader"

// #385 sibling paths: presets copy a unit (or an effect chain) through the same dependency closure the
// clipboard uses. A ModulationBox comes along with its modulated parameter, its project-level modulator did
// not, so encoding already panicked on the dangling mandatory `source` (or decoding did, into a fresh project).
describe("presets carry the modulators of modulated parameters (#385)", () => {
    const empty = (): ProjectSkeleton => ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})

    const createUnit = (skeleton: ProjectSkeleton): {audioUnit: AudioUnitBox, crusher: CrusherDeviceBox} => {
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
        boxGraph.endTransaction()
        return {audioUnit, crusher}
    }
    const modulate = (skeleton: ProjectSkeleton, target: Vertex): StepsModulatorBox => {
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        boxGraph.beginTransaction()
        const modulator = StepsModulatorBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Steps")
            box.index.setValue(0)
        })
        ModulationBox.create(boxGraph, UUID.generate(), box => {
            box.source.refer(modulator.assignments)
            box.target.refer(target)
            box.depth.setValue(0.25)
            box.index.setValue(0)
        })
        boxGraph.endTransaction()
        return modulator
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
        const modulations = modulationsOf(skeleton)
        expect(modulations.length).toBe(modulationCount)
        modulations.forEach(modulation => {
            expect(modulation.source.targetVertex.unwrap().box).toBe(modulators[0])
            expect(crushersOf(skeleton).map(crusher => crusher.crush)).toContain(modulation.target.targetVertex.unwrap())
        })
    }
    const encodeModulatedUnit = (): {source: ProjectSkeleton, bytes: ArrayBuffer} => {
        const source = empty()
        const {audioUnit, crusher} = createUnit(source)
        modulate(source, crusher.crush)
        return {source, bytes: PresetEncoder.encode(audioUnit) as ArrayBuffer}
    }

    it("encode does not throw on a modulated parameter", () => {
        const source = empty()
        const {audioUnit, crusher} = createUnit(source)
        modulate(source, crusher.crush)
        expect(() => PresetEncoder.encode(audioUnit)).not.toThrow()
    })

    it("decode into another project wires the assignment to a carried modulator", () => {
        const {bytes} = encodeModulatedUnit()
        const target = empty()
        target.boxGraph.beginTransaction()
        expect(() => PresetDecoder.decode(bytes, target)).not.toThrow()
        target.boxGraph.endTransaction()
        expectWired(target, 1)
    })

    it("decode twice into the same project shares one modulator", () => {
        const {bytes} = encodeModulatedUnit()
        const target = empty()
        target.boxGraph.beginTransaction()
        PresetDecoder.decode(bytes, target)
        PresetDecoder.decode(bytes, target)
        target.boxGraph.endTransaction()
        expectWired(target, 2)
    })

    it("replaceAudioUnit into another project wires the assignment to a carried modulator", () => {
        const {bytes} = encodeModulatedUnit()
        const target = empty()
        const {audioUnit} = createUnit(target)
        target.boxGraph.beginTransaction()
        const attempt = PresetDecoder.replaceAudioUnit(bytes, audioUnit)
        target.boxGraph.endTransaction()
        expect(attempt.isSuccess()).toBe(true)
        expectWired(target, 1)
    })

    it("encodeEffects/insertEffectChain carry the modulator of a modulated effect parameter", () => {
        const source = empty()
        const {crusher} = createUnit(source)
        modulate(source, crusher.crush)
        const bytes = PresetEncoder.encodeEffects([crusher], PresetHeader.ChainKind.Audio)
        const target = empty()
        const {audioUnit} = createUnit(target)
        target.boxGraph.beginTransaction()
        const attempt = PresetDecoder.insertEffectChain(bytes, audioUnit.audioEffects, 0, PresetHeader.ChainKind.Audio)
        target.boxGraph.endTransaction()
        expect(attempt.isSuccess()).toBe(true)
        expectWired(target, 1)
    })
})

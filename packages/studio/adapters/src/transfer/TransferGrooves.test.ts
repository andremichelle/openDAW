import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    AudioUnitBox,
    CaptureMidiBox,
    CubedDeviceBox,
    GrooveFunctionBox,
    GrooveShuffleBox,
    GrooveStackBox,
    GrooveStackEntryBox,
    VaporisateurDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferAudioUnits} from "./TransferAudioUnits"
import {PresetEncoder} from "../preset/PresetEncoder"
import {PresetDecoder} from "../preset/PresetDecoder"
import {PresetHeader} from "../preset/PresetHeader"
import {GrooveBox, isGrooveBox} from "../grooves/GrooveBoxAdapter"

const empty = (): ProjectSkeleton => ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})

const globalOf = (skeleton: ProjectSkeleton): GrooveShuffleBox =>
    skeleton.mandatoryBoxes.rootBox.groove.targetVertex.unwrap().box as GrooveShuffleBox

const groovesOf = (skeleton: ProjectSkeleton): ReadonlyArray<GrooveBox> =>
    skeleton.mandatoryBoxes.rootBox.grooves.pointerHub.incoming()
        .map(pointer => pointer.box)
        .filter((box): box is GrooveBox => isGrooveBox(box))
        .sort((a, b) => a.index.getValue() - b.index.getValue())

const zeitgeistsOf = (skeleton: ProjectSkeleton): ReadonlyArray<ZeitgeistDeviceBox> =>
    skeleton.boxGraph.boxes().filter((box): box is ZeitgeistDeviceBox => box instanceof ZeitgeistDeviceBox)

const grooveOf = (zeitgeist: ZeitgeistDeviceBox) => zeitgeist.groove.targetVertex.map(vertex => vertex.box)

// An instrument with one Zeitgeist on the given groove (or the global one)
const createUnit = (skeleton: ProjectSkeleton, groove?: (skeleton: ProjectSkeleton) => GrooveBox) => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    boxGraph.beginTransaction()
    const audioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    audioUnit.capture.refer(CaptureMidiBox.create(boxGraph, UUID.generate()))
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue("Vapo")
        box.host.refer(audioUnit.input)
    })
    const target = groove?.(skeleton) ?? globalOf(skeleton)
    const zeitgeist = ZeitgeistDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue("Zeitgeist")
        box.host.refer(audioUnit.midiEffects)
        box.index.setValue(0)
        box.groove.refer(target)
    })
    boxGraph.endTransaction()
    return {audioUnit, zeitgeist, groove: target}
}

const customGroove = (label: string) => ({boxGraph, mandatoryBoxes: {rootBox}}: ProjectSkeleton): GrooveBox =>
    GrooveFunctionBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue(label)
        box.collection.refer(rootBox.grooves)
        box.index.setValue(1)
        box.amount.setValue(0.9)
    })

const stackGroove = (skeleton: ProjectSkeleton): GrooveBox => {
    const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
    const member = customGroove("Member")(skeleton)
    const stack = GrooveStackBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue("Stack")
        box.collection.refer(rootBox.grooves)
        box.index.setValue(2)
    })
    GrooveStackEntryBox.create(boxGraph, UUID.generate(), box => {
        box.stack.refer(stack.entries)
        box.groove.refer(member)
        box.index.setValue(0)
    })
    GrooveStackEntryBox.create(boxGraph, UUID.generate(), box => {
        box.stack.refer(stack.entries)
        box.groove.refer(globalOf(skeleton))
        box.index.setValue(1)
    })
    return stack
}

const transfer = (audioUnit: AudioUnitBox, target: ProjectSkeleton): void => {
    target.boxGraph.beginTransaction()
    TransferAudioUnits.transfer([audioUnit], target)
    target.boxGraph.endTransaction()
}

describe("grooves travel with a Zeitgeist", () => {
    it("the global groove maps onto the other project's global groove", () => {
        const source = empty()
        const target = empty()
        const {audioUnit} = createUnit(source)
        transfer(audioUnit, target)
        expect(grooveOf(zeitgeistsOf(target)[0]).unwrap()).toBe(globalOf(target))
        expect(groovesOf(target).length).toBe(1)
    })
    it("another groove comes along as an unshared groove at the end of the list", () => {
        const source = empty()
        const target = empty()
        const {audioUnit} = createUnit(source, customGroove("Laid Back"))
        transfer(audioUnit, target)
        const pasted = grooveOf(zeitgeistsOf(target)[0]).unwrap() as GrooveFunctionBox
        expect(pasted.graph).toBe(target.boxGraph)
        expect(pasted.amount.getValue()).toBeCloseTo(0.9)
        expect(groovesOf(target).map(box => box.label.getValue())).toEqual(["Global Shuffle", "Laid Back"])
        expect(groovesOf(target).map(box => box.index.getValue())).toEqual([0, 1])
    })
    it("within the same project the copy keeps the same groove", () => {
        const source = empty()
        const {audioUnit, groove} = createUnit(source, customGroove("Laid Back"))
        transfer(audioUnit, source)
        const zeitgeists = zeitgeistsOf(source)
        expect(zeitgeists.length).toBe(2)
        zeitgeists.forEach(zeitgeist => expect(grooveOf(zeitgeist).unwrap()).toBe(groove))
        expect(groovesOf(source).length).toBe(2)
    })
    it("a copy within the same project keeps the order of the list", () => {
        const source = empty()
        const {audioUnit} = createUnit(source, customGroove("Laid Back"))
        source.boxGraph.beginTransaction()
        GrooveShuffleBox.create(source.boxGraph, UUID.generate(), box => {
            box.label.setValue("After")
            box.collection.refer(source.mandatoryBoxes.rootBox.grooves)
            box.index.setValue(2)
        })
        source.boxGraph.endTransaction()
        transfer(audioUnit, source)
        expect(groovesOf(source).map(box => box.label.getValue())).toEqual(["Global Shuffle", "Laid Back", "After"])
    })
    it("a stack comes along with its entries and members, its global member maps to the target", () => {
        const source = empty()
        const target = empty()
        const {audioUnit} = createUnit(source, stackGroove)
        transfer(audioUnit, target)
        const stack = grooveOf(zeitgeistsOf(target)[0]).unwrap() as GrooveStackBox
        expect(stack).toBeInstanceOf(GrooveStackBox)
        const members = stack.entries.pointerHub.incoming()
            .map(pointer => pointer.box as GrooveStackEntryBox)
            .sort((a, b) => a.index.getValue() - b.index.getValue())
            .map(entry => entry.groove.targetVertex.unwrap().box)
        expect(members.length).toBe(2)
        expect((members[0] as GrooveBox).label.getValue()).toBe("Member")
        expect(members[0].graph).toBe(target.boxGraph)
        expect(members[1]).toBe(globalOf(target))
        expect(groovesOf(target).map(box => box.label.getValue()).sort()).toEqual(["Global Shuffle", "Member", "Stack"])
    })
    it("a stack copied within the same project gets no second set of entries", () => {
        const source = empty()
        const {audioUnit, groove} = createUnit(source, stackGroove)
        transfer(audioUnit, source)
        expect((groove as GrooveStackBox).entries.pointerHub.incoming().length).toBe(2)
    })
    it("an audio unit preset carries a custom groove and maps the global one", () => {
        const source = empty()
        const target = empty()
        const {audioUnit} = createUnit(source, customGroove("Laid Back"))
        const preset = PresetEncoder.encode(audioUnit)
        target.boxGraph.beginTransaction()
        PresetDecoder.decode(preset, target)
        target.boxGraph.endTransaction()
        const pasted = grooveOf(zeitgeistsOf(target)[0]).unwrap() as GrooveFunctionBox
        expect(pasted.label.getValue()).toBe("Laid Back")
        expect(groovesOf(target).map(box => box.index.getValue())).toEqual([0, 1])
        const other = empty()
        const plain = createUnit(other)
        const plainPreset = PresetEncoder.encode(plain.audioUnit)
        const third = empty()
        third.boxGraph.beginTransaction()
        PresetDecoder.decode(plainPreset, third)
        third.boxGraph.endTransaction()
        expect(grooveOf(zeitgeistsOf(third)[0]).unwrap()).toBe(globalOf(third))
    })
    it("a midi effect chain preset maps the global groove and carries a custom one", () => {
        const source = empty()
        const target = empty()
        const {zeitgeist} = createUnit(source, customGroove("Laid Back"))
        const preset = PresetEncoder.encodeEffects([zeitgeist], PresetHeader.ChainKind.Midi)
        const {audioUnit: targetUnit} = createUnit(target)
        target.boxGraph.beginTransaction()
        const result = PresetDecoder.insertEffectChain(preset, targetUnit.midiEffects, 1, PresetHeader.ChainKind.Midi)
        target.boxGraph.endTransaction()
        expect(result.isSuccess()).toBe(true)
        const labels = zeitgeistsOf(target).map(box => grooveOf(box).map(groove => (groove as GrooveBox).label.getValue()).unwrap())
        expect(labels.sort()).toEqual(["Global Shuffle", "Laid Back"])
        expect(groovesOf(target).map(box => box.index.getValue())).toEqual([0, 1])
    })
    it("a groove from before the groove list joins the target's list", () => {
        const source = empty()
        const target = empty()
        const {audioUnit} = createUnit(source, ({boxGraph}) => GrooveShuffleBox.create(boxGraph, UUID.generate(),
            box => box.label.setValue("Shuffle")))
        transfer(audioUnit, target)
        expect(groovesOf(target).map(box => box.label.getValue())).toEqual(["Global Shuffle", "Shuffle"])
        expect(grooveOf(zeitgeistsOf(target)[0]).unwrap()).toBe(groovesOf(target)[1])
    })
    it("a Zeitgeist without a groove stays without one", () => {
        const source = empty()
        const target = empty()
        const {audioUnit, zeitgeist} = createUnit(source)
        source.boxGraph.beginTransaction()
        zeitgeist.groove.defer()
        source.boxGraph.endTransaction()
        transfer(audioUnit, target)
        expect(zeitgeistsOf(target)[0].groove.targetAddress.isEmpty()).toBe(true)
    })
})

describe("grooves travel with a Cubed", () => {
    const createCubed = (skeleton: ProjectSkeleton, groove: (skeleton: ProjectSkeleton) => GrooveBox) => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
        boxGraph.beginTransaction()
        const audioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        audioUnit.capture.refer(CaptureMidiBox.create(boxGraph, UUID.generate()))
        const target = groove(skeleton)
        CubedDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(audioUnit.input)
            box.groove.refer(target)
        })
        boxGraph.endTransaction()
        return {audioUnit, groove: target}
    }
    const cubedOf = (skeleton: ProjectSkeleton): ReadonlyArray<CubedDeviceBox> =>
        skeleton.boxGraph.boxes().filter((box): box is CubedDeviceBox => box instanceof CubedDeviceBox)

    it("a copy into another project carries the groove into its list", () => {
        const source = empty()
        const target = empty()
        const {audioUnit} = createCubed(source, customGroove("Laid Back"))
        transfer(audioUnit, target)
        const pasted = cubedOf(target)[0].groove.targetVertex.unwrap().box as GrooveFunctionBox
        expect(pasted.graph).toBe(target.boxGraph)
        expect(groovesOf(target).map(box => box.label.getValue())).toEqual(["Global Shuffle", "Laid Back"])
    })
    it("a copy within the same project keeps the same groove", () => {
        const source = empty()
        const {audioUnit, groove} = createCubed(source, customGroove("Laid Back"))
        transfer(audioUnit, source)
        expect(cubedOf(source).map(cubed => cubed.groove.targetVertex.unwrap().box)).toEqual([groove, groove])
        expect(groovesOf(source).length).toBe(2)
    })
    it("a preset carries a custom groove and maps the global one", () => {
        for (const [groove, labels] of [[customGroove("Laid Back"), ["Global Shuffle", "Laid Back"]],
            [globalOf, ["Global Shuffle"]]] as const) {
            const target = empty()
            const preset = PresetEncoder.encode(createCubed(empty(), groove).audioUnit)
            target.boxGraph.beginTransaction()
            PresetDecoder.decode(preset, target)
            target.boxGraph.endTransaction()
            const pasted = cubedOf(target)[0].groove.targetVertex.unwrap().box
            expect(groovesOf(target).map(box => box.label.getValue())).toEqual(labels)
            expect(groovesOf(target)).toContain(pasted)
        }
    })
})

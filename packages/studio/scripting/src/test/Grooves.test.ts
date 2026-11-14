import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {
    GrooveFunctionBox,
    GrooveOffsetBox,
    GrooveRandomBox,
    GrooveStackBox,
    GrooveStackEntryBox,
    RootBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {createFixture} from "./Fixture"
import {ZeitgeistEffectImpl} from "../impl/devices/MIDIEffects"
import {GrooveOffset, GrooveRandom, GrooveStack} from "../Api"

// Scripts cannot create grooves yet, the fixture builds them on the box graph like the studio does
const setup = () => {
    const {project} = createFixture()
    const zeitgeist = project.addInstrumentUnit("Vaporisateur").addMIDIEffect("Zeitgeist") as ZeitgeistEffectImpl
    const {context} = zeitgeist
    const {boxGraph} = context
    const rootBox = boxGraph.boxes().find((box): box is RootBox => isInstanceOf(box, RootBox))!
    const list = (box: GrooveFunctionBox | GrooveRandomBox | GrooveStackBox, index: number) => {
        box.collection.refer(rootBox.grooves)
        box.index.setValue(index)
    }
    const boxes = context.edit(() => {
        const power = GrooveFunctionBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Power")
            list(box, 1)
        })
        const curve = GrooveFunctionBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Curve")
            box.function.setValue(1)
            list(box, 2)
        })
        const random = GrooveRandomBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Random")
            list(box, 3)
        })
        const stack = GrooveStackBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Stack")
            list(box, 4)
        })
        // entries created out of order, members follow their index
        GrooveStackEntryBox.create(boxGraph, UUID.generate(), box => {
            box.stack.refer(stack.entries)
            box.groove.refer(random)
            box.index.setValue(1)
        })
        GrooveStackEntryBox.create(boxGraph, UUID.generate(), box => {
            box.stack.refer(stack.entries)
            box.groove.refer(power)
            box.index.setValue(0)
        })
        return {power, curve, random, stack}
    })
    const point = (box: GrooveFunctionBox | GrooveRandomBox | GrooveStackBox | null) => context.edit(() => {
        const device = zeitgeist.box as ZeitgeistDeviceBox
        if (box === null) {device.groove.defer()} else {device.groove.refer(box)}
    })
    return {project, zeitgeist, boxes, point}
}

describe("grooves", () => {
    it("a new Zeitgeist uses the global shuffle", () => {
        const {project, zeitgeist} = setup()
        expect(zeitgeist.groove).toBe(project.groove)
        expect(project.groove.kind).toBe("Shuffle")
        expect(project.groove.label).toBe("Global Shuffle")
    })

    it("lists every groove of the project in order", () => {
        const {project} = setup()
        expect(project.grooves.map(groove => groove.kind)).toEqual(["Shuffle", "Power", "S-Curve", "Random", "Stack"])
        expect(project.grooves.map(groove => groove.label))
            .toEqual(["Global Shuffle", "Power", "Curve", "Random", "Stack"])
    })

    it("reads and writes a function groove", () => {
        const {zeitgeist, boxes, point} = setup()
        point(boxes.curve)
        const groove = zeitgeist.groove
        if (groove?.kind !== "S-Curve") {throw new Error("expected an s-curve")}
        expect(groove.amount).toBeCloseTo(0.75)
        expect(groove.duration).toBe(PPQN.Quarter)
        groove.amount = 2
        expect(groove.amount).toBe(1)
        expect(boxes.curve.amount.getValue()).toBe(1)
        groove.duration = PPQN.SemiQuaver
        expect(boxes.curve.duration.getValue()).toBe(PPQN.SemiQuaver)
    })

    it("reads and writes a random groove with its schema defaults", () => {
        const {zeitgeist, boxes, point} = setup()
        point(boxes.random)
        const groove = zeitgeist.groove as GrooveRandom
        expect(groove.kind).toBe("Random")
        expect(groove.amount).toBeCloseTo(0.75)
        expect(groove.duration).toBe(PPQN.Bar)
        expect(groove.seed).toBe(1)
        expect(groove.roughness).toBe(1)
        expect(groove.steps).toBe(64)
        groove.seed = 4711
        groove.roughness = 0.25
        groove.steps = 100
        expect(boxes.random.seed.getValue()).toBe(4711)
        expect(boxes.random.roughness.getValue()).toBe(0.25)
        expect(groove.steps).toBe(64)
        groove.steps = 1
        expect(groove.steps).toBe(2)
        groove.label = "Wobble"
        expect(boxes.random.label.getValue()).toBe("Wobble")
    })

    it("lists a stack's members in their order", () => {
        const {zeitgeist, boxes, point} = setup()
        point(boxes.stack)
        const groove = zeitgeist.groove as GrooveStack
        expect(groove.kind).toBe("Stack")
        expect(groove.members.map(member => member.label)).toEqual(["Power", "Random"])
        expect(groove.members[1]).toBe(zeitgeist.context.edit(() => groove.members[1]))
    })

    it("follows the global groove when its type changes", () => {
        const {project, zeitgeist, boxes} = setup()
        const {context} = zeitgeist
        context.edit(() => {
            const rootBox = context.boxGraph.boxes().find((box): box is RootBox => isInstanceOf(box, RootBox))!
            rootBox.groove.refer(boxes.random)
        })
        expect(project.groove.kind).toBe("Random")
    })

    it("reads and writes an offset groove within an eighth note", () => {
        const {project, zeitgeist} = setup()
        const {context} = zeitgeist
        const box = context.edit(() => GrooveOffsetBox.create(context.boxGraph, UUID.generate(), box => {
            box.label.setValue("Late")
            box.collection.refer(context.boxGraph.boxes().find((box): box is RootBox => isInstanceOf(box, RootBox))!.grooves)
            box.index.setValue(5)
        }))
        const groove = project.grooves.find(groove => groove.kind === "Offset") as GrooveOffset
        expect(groove.label).toBe("Late")
        expect(groove.offset).toBe(0)
        groove.offset = -240
        expect(box.offset.getValue()).toBe(-240)
        groove.offset = 1000
        expect(groove.offset).toBe(480)
        groove.offset = -1000
        expect(groove.offset).toBe(-480)
    })

    it("a note region, a note clip and an automation region read and write their groove", () => {
        const {project, boxes} = setup()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const track = unit.addNoteTrack()
        const region = track.addRegion({duration: PPQN.Bar})
        const clip = track.addClip({duration: PPQN.Bar})
        const lane = unit.addValueTrack(unit.instrument, "cutoff")
        const automation = lane.addRegion({duration: PPQN.Bar})
        const random = project.grooves.find(groove => groove.kind === "Random")!
        for (const owner of [region, clip, automation]) {
            expect(owner.groove).toBeNull()
            owner.groove = random
            expect(owner.groove).toBe(random)
            owner.groove = project.groove
            expect(owner.groove?.kind).toBe("Shuffle")
            owner.groove = null
            expect(owner.groove).toBeNull()
        }
        // only the stack member still points at it
        expect(boxes.random.pointerHub.incoming().length).toBe(1)
    })

    it("a Cubed plays straight until a script gives it a groove", () => {
        const {project, boxes} = setup()
        const cubed = project.addInstrumentUnit("Cubed").instrument
        if (cubed.key !== "Cubed") {throw new Error("expected a Cubed")}
        expect(cubed.groove).toBeNull()
        const random = project.grooves.find(groove => groove.kind === "Random")!
        cubed.groove = random
        expect(cubed.groove).toBe(random)
        expect(boxes.random.pointerHub.incoming().length).toBe(2)
        cubed.groove = null
        expect(cubed.groove).toBeNull()
        const other = setup().project
        expect(() => {cubed.groove = other.groove}).toThrow("Expected a groove of the project")
    })

    it("a Surgeon plays straight until a script gives it a groove", () => {
        const {project, boxes} = setup()
        const surgeon = project.addInstrumentUnit("Surgeon").instrument
        if (surgeon.key !== "Surgeon") {throw new Error("expected a Surgeon")}
        expect(surgeon.groove).toBeNull()
        const random = project.grooves.find(groove => groove.kind === "Random")!
        surgeon.groove = random
        expect(surgeon.groove).toBe(random)
        expect(boxes.random.pointerHub.incoming().length).toBe(2)
        surgeon.groove = null
        expect(surgeon.groove).toBeNull()
        const other = setup().project
        expect(() => {surgeon.groove = other.groove}).toThrow("Expected a groove of the project")
    })

    it("a region refuses a groove of another project", () => {
        const {project} = setup()
        const other = setup().project
        const region = project.addInstrumentUnit("Vaporisateur").addNoteTrack().addRegion({duration: PPQN.Bar})
        expect(() => {region.groove = other.groove}).toThrow("Expected a groove of the project")
        expect(region.groove).toBeNull()
    })

    it("a Zeitgeist without a groove reads null", () => {
        const {zeitgeist, point} = setup()
        point(null)
        expect(zeitgeist.groove).toBeNull()
    })
})

import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {
    GrooveFunctionBox,
    GrooveRandomBox,
    GrooveStackBox,
    GrooveStackEntryBox,
    RootBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {createFixture} from "./Fixture"
import {ZeitgeistEffectImpl} from "../impl/devices/MIDIEffects"
import {GrooveRandom, GrooveStack} from "../Api"

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

    it("a Zeitgeist without a groove reads null", () => {
        const {zeitgeist, point} = setup()
        point(null)
        expect(zeitgeist.groove).toBeNull()
    })
})

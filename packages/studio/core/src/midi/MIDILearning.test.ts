import {afterEach, describe, expect, it} from "vitest"
import {asInstanceOf, ByteArrayInput, ByteArrayOutput, int, isDefined, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {MIDIControllerBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"
import {MidiData} from "@opendaw/lib-midi"
import {PrimitiveField, PrimitiveValues} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {MIDIEncoding, MIDITakeover} from "./MIDIMappingTransform"

// jsdom lacks AudioWorkletNode, which EngineWorklet extends at module-eval time.
if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {},
        invalidate: () => {},
        remove: () => {},
        register: () => Terminable.Empty
    },
    soundfontManager: undefined,
    sampleService: undefined,
    soundfontService: undefined
}) as unknown as ProjectEnv

const lifecycle = new Terminator()

// Creates a project whose primary audio unit volume is mapped to controller 7.
const createLearnedProject = async (): Promise<Project> => {
    const {Project} = await import("../project/Project")
    const project = lifecycle.own(Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
        createDefaultUser: true, createOutputMaximizer: false
    })))
    const {midiControllers} = asInstanceOf(project.rootBox.users.pointerHub.incoming()[0].box, UserInterfaceBox)
    project.editing.modify(() => MIDIControllerBox.create(project.boxGraph, UUID.generate(), box => {
        box.controllers.refer(midiControllers)
        box.parameter.refer(project.primaryAudioUnitBox.volume)
        box.controlId.setValue(7)
    }))
    return project
}

// The loaded pointer holds an equal but distinct Address instance.
const reload = async (project: Project): Promise<Project> => {
    const {Project} = await import("../project/Project")
    return lifecycle.own(Project.load(createEnv(), project.toArrayBuffer() as ArrayBuffer))
}

describe("MIDILearning", () => {
    afterEach(() => lifecycle.terminate())

    it("recognises a learned parameter in the same session", async () => {
        const project = await createLearnedProject()
        expect(project.midiLearning.hasMidiConnection(project.primaryAudioUnitBox.volume.address)).toBe(true)
    })

    it("recognises a learned parameter after the project is reloaded", async () => {
        const reloaded = await reload(await createLearnedProject())
        expect(reloaded.midiLearning.hasMidiConnection(reloaded.primaryAudioUnitBox.volume.address)).toBe(true)
    })

    it("does not report another parameter of the same box as connected", async () => {
        const reloaded = await reload(await createLearnedProject())
        expect(reloaded.midiLearning.hasMidiConnection(reloaded.primaryAudioUnitBox.panning.address)).toBe(false)
    })

    it("counts the connections of a reloaded project", async () => {
        const reloaded = await reload(await createLearnedProject())
        expect(reloaded.midiLearning.numberOfConnections).toBe(1)
    })

    it("forgets a mapping after the project is reloaded and deletes its box", async () => {
        const reloaded = await reload(await createLearnedProject())
        const {volume} = reloaded.primaryAudioUnitBox
        reloaded.midiLearning.forgetMidiConnection(volume.address)
        expect(reloaded.midiLearning.hasMidiConnection(volume.address)).toBe(false)
        expect(reloaded.midiLearning.numberOfConnections).toBe(0)
        expect(reloaded.boxGraph.boxes().some(box => box instanceof MIDIControllerBox)).toBe(false)
    })

    it("keeps min, max, takeover and encoding after reload", async () => {
        const project = await createLearnedProject()
        project.editing.modify(() => {
            const box = controllerBox(project)
            box.min.setValue(0.2)
            box.max.setValue(0.6)
            box.takeover.setValue(MIDITakeover.Pickup)
            box.encoding.setValue(MIDIEncoding.BinaryOffset)
        })
        const box = controllerBox(await reload(project))
        expect(box.min.getValue()).toBeCloseTo(0.2, 6)
        expect(box.max.getValue()).toBeCloseTo(0.6, 6)
        expect(box.takeover.getValue()).toBe(MIDITakeover.Pickup)
        expect(box.encoding.getValue()).toBe(MIDIEncoding.BinaryOffset)
    })

    it("decodes a mapping saved without the new fields with defaults", async () => {
        const project = await createLearnedProject()
        project.editing.modify(() => {
            const box = controllerBox(project)
            box.min.setValue(0.3)
            box.max.setValue(0.4)
            box.takeover.setValue(MIDITakeover.Scaling)
            box.encoding.setValue(MIDIEncoding.SignBit)
        })
        const legacy = stripControllerFields(project.toArrayBuffer(), 5)
        const {Project} = await import("../project/Project")
        const loaded = lifecycle.own(Project.load(createEnv(), legacy))
        const box = controllerBox(loaded)
        expect(box.controlId.getValue()).toBe(7)
        expect(box.min.getValue()).toBe(0.0)
        expect(box.max.getValue()).toBe(1.0)
        expect(box.takeover.getValue()).toBe(MIDITakeover.Jump)
        expect(box.encoding.getValue()).toBe(MIDIEncoding.Absolute)
        expect(loaded.midiLearning.hasMidiConnection(loaded.primaryAudioUnitBox.volume.address)).toBe(true)
    })

    it("applies min and max to an incoming CC", async () => {
        const project = await createLearnedProject()
        project.editing.modify(() => {
            controllerBox(project).min.setValue(0.25)
            controllerBox(project).max.setValue(0.75)
        })
        project.midiLearning.receive(MidiData.control(0, 7, 127), "")
        expect(volumeUnitValue(project)).toBeCloseTo(0.75, 6)
    })

    it("ignores the same CC on another channel", async () => {
        const project = await createLearnedProject()
        project.editing.modify(() => controllerBox(project).deviceChannel.setValue(2))
        const before = volumeUnitValue(project)
        project.midiLearning.receive(MidiData.control(3, 7, 127), "")
        expect(volumeUnitValue(project)).toBe(before)
        project.midiLearning.receive(MidiData.control(2, 7, 127), "")
        expect(volumeUnitValue(project)).toBeCloseTo(1.0, 6)
    })

    it("accepts every channel when the mapping channel is -1", async () => {
        const project = await createLearnedProject()
        project.editing.modify(() => {
            controllerBox(project).deviceChannel.setValue(-1)
            controllerBox(project).min.setValue(0.25)
        })
        project.midiLearning.receive(MidiData.control(5, 7, 0), "")
        expect(volumeUnitValue(project)).toBeCloseTo(0.25, 6)
    })

    it("ignores another CC number", async () => {
        const project = await createLearnedProject()
        const before = volumeUnitValue(project)
        project.midiLearning.receive(MidiData.control(0, 8, 127), "")
        expect(volumeUnitValue(project)).toBe(before)
    })

    it("lists its controller boxes and notifies changes on add and remove", async () => {
        const project = await createLearnedProject()
        let changes = 0
        lifecycle.own(project.midiLearning.subscribeChanges(() => changes++))
        expect(project.midiLearning.controllerBoxes().length).toBe(1)
        project.midiLearning.forgetMidiConnection(project.primaryAudioUnitBox.volume.address)
        expect(changes).toBe(1)
        expect(project.midiLearning.controllerBoxes().length).toBe(0)
    })
})

describe("MIDILearning bulk removal", () => {
    afterEach(() => lifecycle.terminate())

    it("stays consistent when several mappings are deleted in one transaction", async () => {
        const project = await createLearnedProject()
        const {midiLearning, primaryAudioUnitBox: {volume, panning}} = project
        midiLearning.mapMode.setValue(true)
        midiLearning.mapTarget.wrap(panning as unknown as MappableField)
        midiLearning.receive(MidiData.control(0, 21, 64), "")
        midiLearning.mapMode.setValue(false)
        lifecycle.own(midiLearning.subscribeChanges(() => midiLearning.hasMidiConnection(volume.address)))
        const boxes = midiLearning.controllerBoxes()
        expect(boxes.length).toBe(2)
        project.editing.modify(() => boxes.forEach(box => box.delete()))
        expect(midiLearning.numberOfConnections).toBe(0)
        expect(midiLearning.controllerBoxes().length).toBe(0)
    })
})

describe("MIDILearning map mode", () => {
    afterEach(() => lifecycle.terminate())

    const panningOf = (project: Project): MappableField =>
        project.primaryAudioUnitBox.panning as unknown as MappableField

    const panningBoxes = (project: Project): ReadonlyArray<MIDIControllerBox> =>
        project.midiLearning.controllerBoxes().filter(box => box.parameter.targetAddress
            .mapOr(address => address.equals(project.primaryAudioUnitBox.panning.address), false))

    const enterMapMode = async (): Promise<Project> => {
        const project = await createLearnedProject()
        project.midiLearning.mapMode.setValue(true)
        project.midiLearning.mapTarget.wrap(panningOf(project))
        return project
    }

    it("binds the selected target to the next CC", async () => {
        const project = await enterMapMode()
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        const boxes = panningBoxes(project)
        expect(boxes.length).toBe(1)
        expect(boxes[0].controlId.getValue()).toBe(21)
        expect(boxes[0].deviceChannel.getValue()).toBe(0)
    })

    it("keeps the same box when the mapped knob moves again", async () => {
        const project = await enterMapMode()
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        const first = panningBoxes(project)[0]
        project.midiLearning.receive(MidiData.control(0, 21, 70), "")
        expect(panningBoxes(project).length).toBe(1)
        expect(panningBoxes(project)[0]).toBe(first)
    })

    // UAT F-3: the learned control must stop pulsing as the target
    it("clears the target after binding but stays in map mode", async () => {
        const project = await enterMapMode()
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        expect(project.midiLearning.mapTarget.isEmpty()).toBe(true)
        expect(project.midiLearning.mapMode.getValue()).toBe(true)
    })

    // UAT B-03: moving another controller after binding must not steal the binding
    it("does not re-bind when another controller moves after binding", async () => {
        const project = await enterMapMode()
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        project.midiLearning.receive(MidiData.control(0, 22, 64), "")
        const boxes = panningBoxes(project)
        expect(boxes.length).toBe(1)
        expect(boxes[0].controlId.getValue()).toBe(21)
    })

    it("re-binds the target to another CC when it is selected again", async () => {
        const project = await enterMapMode()
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        project.midiLearning.mapTarget.wrap(panningOf(project))
        project.midiLearning.receive(MidiData.control(0, 22, 64), "")
        const boxes = panningBoxes(project)
        expect(boxes.length).toBe(1)
        expect(boxes[0].controlId.getValue()).toBe(22)
    })

    it("does not bind outside map mode", async () => {
        const project = await enterMapMode()
        project.midiLearning.mapMode.setValue(false)
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        expect(panningBoxes(project).length).toBe(0)
    })

    it("clears the target when leaving map mode", async () => {
        const project = await enterMapMode()
        project.midiLearning.mapMode.setValue(false)
        expect(project.midiLearning.mapTarget.isEmpty()).toBe(true)
    })

    it("leaves the other mappings untouched", async () => {
        const project = await enterMapMode()
        project.midiLearning.receive(MidiData.control(0, 21, 64), "")
        expect(project.midiLearning.hasMidiConnection(project.primaryAudioUnitBox.volume.address)).toBe(true)
        expect(project.midiLearning.numberOfConnections).toBe(2)
    })
})

type MappableField = PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>

const volumeUnitValue = (project: Project): number =>
    project.parameterFieldAdapters.get(project.primaryAudioUnitBox.volume.address).getUnitValue()

const controllerBox = (project: Project): MIDIControllerBox =>
    asInstanceOf(project.boxGraph.boxes().find(box => box instanceof MIDIControllerBox), MIDIControllerBox)

// Rewrites a project file so every MIDIControllerBox only carries field keys up to maxKey (the pre-change layout).
const stripControllerFields = (project: ArrayBufferLike, maxKey: int): ArrayBuffer => {
    const input = new ByteArrayInput(project)
    const output = ByteArrayOutput.create()
    output.writeInt(input.readInt())
    output.writeInt(input.readInt())
    const chunk = new Int8Array(input.readInt())
    input.readBytes(chunk)
    const graphInput = new ByteArrayInput(chunk.buffer)
    const graphOutput = ByteArrayOutput.create()
    const numBoxes = graphInput.readInt()
    graphOutput.writeInt(numBoxes)
    for (let index = 0; index < numBoxes; index++) {
        const boxBytes = new Int8Array(graphInput.readInt())
        graphInput.readBytes(boxBytes)
        const rewritten = rewriteBox(boxBytes, maxKey)
        graphOutput.writeInt(rewritten.byteLength)
        graphOutput.writeBytes(rewritten)
    }
    const graphBytes = new Int8Array(graphOutput.toArrayBuffer())
    output.writeInt(graphBytes.byteLength)
    output.writeBytes(graphBytes)
    return output.toArrayBuffer() as ArrayBuffer
}

const rewriteBox = (bytes: Int8Array, maxKey: int): Int8Array => {
    const input = new ByteArrayInput(bytes.buffer)
    const creationIndex = input.readInt()
    const name = input.readString()
    if (name !== MIDIControllerBox.ClassName) {return bytes}
    const uuid = new Int8Array(16)
    input.readBytes(uuid)
    const output = ByteArrayOutput.create()
    output.writeInt(creationIndex)
    output.writeString(name)
    output.writeBytes(uuid)
    output.writeInt(input.readInt())
    const fields: Array<{key: int, data: Int8Array}> = []
    const numFields = input.readShort()
    for (let index = 0; index < numFields; index++) {
        const key = input.readShort()
        const data = new Int8Array(input.readInt())
        input.readBytes(data)
        if (key <= maxKey) {fields.push({key, data})}
    }
    output.writeShort(fields.length)
    fields.forEach(({key, data}) => {
        output.writeShort(key)
        output.writeInt(data.byteLength)
        output.writeBytes(data)
    })
    return new Int8Array(output.toArrayBuffer())
}

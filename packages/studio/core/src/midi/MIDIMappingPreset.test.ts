import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {MidiData} from "@opendaw/lib-midi"
import {InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"
import {MIDIMappingPreset} from "./MIDIMappingPreset"
import {MIDIEncoding, MIDITakeover} from "./MIDIMappingTransform"

// jsdom lacks AudioWorkletNode, which EngineWorklet extends at module-eval time.
if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

// Tape instruments build a gain stage, so the context needs the two node factories the instrument uses.
const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
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

const createProject = async (): Promise<Project> => {
    const {Project} = await import("../project/Project")
    return lifecycle.own(Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
        createDefaultUser: true, createOutputMaximizer: false
    })))
}

// Creates a Tape instrument and returns its audio unit; label overrides the unique name the API picks.
const addTape = (project: Project, label?: string): AudioUnitBox => project.editing.modify(() => {
    const {audioUnitBox, instrumentBox} = project.api.createInstrument(InstrumentFactories.Tape)
    if (isDefined(label)) {instrumentBox.label.setValue(label)}
    return audioUnitBox
}).unwrap("no tape")

// Maps the tape volume to CC 7 on channel 2 with non-default settings through map mode.
const createMappedProject = async (): Promise<{project: Project, unit: AudioUnitBox}> => {
    const project = await createProject()
    const unit = addTape(project)
    const {midiLearning} = project
    midiLearning.mapMode.setValue(true)
    midiLearning.mapTarget.wrap(unit.volume as unknown as Parameters<typeof midiLearning.mapTarget.wrap>[0])
    midiLearning.receive(MidiData.control(2, 7, 0), "")
    midiLearning.mapMode.setValue(false)
    project.editing.modify(() => {
        const box = midiLearning.controllerBoxes()[0]
        box.min.setValue(0.25)
        box.max.setValue(0.75)
        box.takeover.setValue(MIDITakeover.Scaling)
        box.encoding.setValue(MIDIEncoding.Absolute)
    })
    return {project, unit}
}

describe("MIDIMappingPreset", () => {
    afterEach(() => lifecycle.terminate())

    it("exports a mapping with address and names", async () => {
        const {project, unit} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        expect(preset.version).toBe(1)
        expect(preset.mappings.length).toBe(1)
        const [entry] = preset.mappings
        expect(entry.address).toBe(unit.volume.address.toString())
        expect(entry.unit).toBe("Audio Track")
        expect(entry.parameter).toBe("Volume")
        expect(entry.channel).toBe(2)
        expect(entry.controlId).toBe(7)
        expect(entry.min).toBeCloseTo(0.25, 6)
        expect(entry.max).toBeCloseTo(0.75, 6)
        expect(entry.takeover).toBe(MIDITakeover.Scaling)
    })

    it("round-trips through JSON text", async () => {
        const {project} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        const parsed = MIDIMappingPreset.parse(JSON.stringify(preset)).unwrap("parse failed")
        expect(parsed).toEqual(preset)
    })

    it("imports into the same project by address", async () => {
        const {project, unit} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        project.midiLearning.forgetMidiConnection(unit.volume.address)
        const result = MIDIMappingPreset.apply(project, preset)
        expect(result).toEqual({imported: 1, replaced: 0, skipped: 0})
        const box = project.midiLearning.controllerBoxes()[0]
        expect(box.parameter.targetAddress.unwrap("target").equals(unit.volume.address)).toBe(true)
        expect(box.controlId.getValue()).toBe(7)
        expect(box.deviceChannel.getValue()).toBe(2)
        expect(box.max.getValue()).toBeCloseTo(0.75, 6)
        expect(box.takeover.getValue()).toBe(MIDITakeover.Scaling)
    })

    it("imports into another project by names", async () => {
        const {project} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        const other = await createProject()
        const otherUnit = addTape(other)
        const result = MIDIMappingPreset.apply(other, preset)
        expect(result).toEqual({imported: 1, replaced: 0, skipped: 0})
        expect(other.midiLearning.hasMidiConnection(otherUnit.volume.address)).toBe(true)
    })

    it("skips an ambiguous name match", async () => {
        const {project} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        const other = await createProject()
        addTape(other)
        addTape(other, "Audio Track")
        const result = MIDIMappingPreset.apply(other, preset)
        expect(result).toEqual({imported: 0, replaced: 0, skipped: 1})
        expect(other.midiLearning.numberOfConnections).toBe(0)
    })

    it("skips a mapping without any match", async () => {
        const {project} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        const other = await createProject()
        const result = MIDIMappingPreset.apply(other, preset)
        expect(result).toEqual({imported: 0, replaced: 0, skipped: 1})
    })

    it("replaces an existing binding on the same parameter", async () => {
        const {project} = await createMappedProject()
        const preset = MIDIMappingPreset.create(project)
        const result = MIDIMappingPreset.apply(project, preset)
        expect(result).toEqual({imported: 1, replaced: 1, skipped: 0})
        expect(project.midiLearning.numberOfConnections).toBe(1)
    })

    it("rejects malformed input", () => {
        expect(MIDIMappingPreset.parse("{").isEmpty()).toBe(true)
        expect(MIDIMappingPreset.parse("null").isEmpty()).toBe(true)
        expect(MIDIMappingPreset.parse('{"version":2,"mappings":[]}').isEmpty()).toBe(true)
        expect(MIDIMappingPreset.parse('{"version":1}').isEmpty()).toBe(true)
        const entry = {address: "a", unit: "u", owner: "o", parameter: "p", deviceId: "", channel: 0,
            min: 0, max: 1, takeover: 0, encoding: 0}
        expect(MIDIMappingPreset.parse(JSON.stringify({version: 1, mappings: [entry]})).isEmpty()).toBe(true)
        expect(MIDIMappingPreset.parse(JSON.stringify({version: 1, mappings: [{...entry, controlId: 128}]})).isEmpty()).toBe(true)
        expect(MIDIMappingPreset.parse(JSON.stringify({version: 1, mappings: [{...entry, controlId: 7}]})).nonEmpty()).toBe(true)
    })
})

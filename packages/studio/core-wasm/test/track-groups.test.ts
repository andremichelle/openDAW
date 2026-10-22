import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, InstrumentFactories, ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, StereoToolDeviceBox} from "@opendaw/studio-boxes"
import type {ProjectEnv, Project} from "@opendaw/studio-core"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("@opendaw/studio-core")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}



const render = async (project: Project): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const copy = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
    const sync = connectSyncToEngine(engine, memory, copy.boxGraph)
    await sync.settle()
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    engine.play()
    const result = new Float32Array(256 * 20)
    for (let index = 0; index < 20; index++) {
        engine.render()
        result.set(new Float32Array(memory.buffer, engine.output_ptr(), 256), index * 256)
    }
    sync.close()
    return result
}
const maxDiff = (a: Float32Array, b: Float32Array): number =>
    a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index])), 0)
const peak = (a: Float32Array): number => a.reduce((max, value) => Math.max(max, Math.abs(value)), 0)

describe("track groups on the real WASM engine", () => {
    it("keeps parent effects in the live engine when creating a subgroup inside an existing group", async () => {
        const project = await createProject()
        const code = `class Processor { process(output, block) { for (let i=block.s0;i<block.s1;i++) {output[0][i] += 0.1;output[1][i] += 0.1;} } }`
        const unit = project.editing.modify(() => {
            const {audioUnitBox, instrumentBox} = project.api.createAnyInstrument(InstrumentFactories.Apparat)
            const source = instrumentBox as ApparatDeviceBox
            source.code.setValue("// @apparat js 1 1\n" + code)
            new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
                UUID.toString(source.address.uuid), 1, code))()
            return audioUnitBox
        }).unwrap()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, project.boxGraph)
        await sync.settle()
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        const capture = () => {
            engine.stop(); engine.play()
            for (let index = 0; index < 128; index++) {engine.render()}
            return new Float32Array(memory.buffer, engine.output_ptr(), 256).slice()
        }
        const baseline = capture()
        const outer = project.editing.modify(() => project.grouping.create([unit])!).unwrap()
        await sync.settle()
        const {EffectFactories} = await import("@opendaw/studio-core")
        project.editing.modify(() => {
            const effect = project.api.insertEffect(outer.audioEffects, EffectFactories.AudioNamed.StereoTool) as StereoToolDeviceBox
            effect.volume.setValue(-6)
        })
        await sync.settle()
        const processed = capture()
        expect(peak(processed) / peak(baseline)).toBeCloseTo(Math.pow(10, -6 / 20), 4)
        project.editing.modify(() => project.grouping.create([unit]))
        await sync.settle()
        expect(maxDiff(processed, capture())).toBeLessThan(1e-6)
        const [copy] = project.editing.modify(() => project.grouping.duplicate([unit])).unwrap()
        const copiedSource = copy.input.pointerHub.incoming().map(pointer => pointer.box)
            .find(box => box instanceof ApparatDeviceBox)!
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(copiedSource.address.uuid), 1, code))()
        project.editing.modify(() => unit.mute.setValue(true))
        await sync.settle()
        expect(maxDiff(processed, capture())).toBeLessThan(1e-6)
        project.terminate()
        sync.close()
    }, 30_000)
    it("preserves audio through nested groups and collapse, applies group effects, mute and solo", async () => {
        const project = await createProject()
        const code = `class Processor { process(output, block) { for (let i=block.s0;i<block.s1;i++) {output[0][i] += 0.1;output[1][i] += 0.1;} } }`
        const unit = project.editing.modify(() => {
            const {audioUnitBox, instrumentBox} = project.api.createAnyInstrument(InstrumentFactories.Apparat)
            const source = instrumentBox as ApparatDeviceBox
            source.code.setValue("// @apparat js 1 1\n" + code)
            new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
                UUID.toString(source.address.uuid), 1, code))()
            return audioUnitBox
        }).unwrap()
        const baseline = await render(project)
        expect(peak(baseline)).toBeGreaterThan(0.001)
        const inner = project.editing.modify(() => project.grouping.create([unit])!).unwrap()
        const outer = project.editing.modify(() => project.grouping.create([inner])!).unwrap()
        expect(maxDiff(baseline, await render(project))).toBeLessThan(1e-6)
        project.editing.modify(() => outer.groupCollapsed.setValue(true))
        expect(maxDiff(baseline, await render(project))).toBeLessThan(1e-6)
        project.editing.modify(() => outer.solo.setValue(true))
        expect(maxDiff(baseline, await render(project))).toBeLessThan(1e-6)
        project.editing.modify(() => outer.mute.setValue(true))
        expect(peak(await render(project))).toBe(0)
        project.editing.modify(() => {outer.mute.setValue(false); outer.solo.setValue(false)})
        const {EffectFactories} = await import("@opendaw/studio-core")
        const effect = project.editing.modify(() => project.api.insertEffect(outer.audioEffects,
            EffectFactories.AudioNamed.StereoTool) as StereoToolDeviceBox).unwrap()
        project.editing.modify(() => effect.volume.setValue(-6))
        const processed = await render(project)
        expect(peak(processed) / peak(baseline)).toBeCloseTo(Math.pow(10, -6 / 20), 4)
        project.editing.modify(() => project.grouping.move([unit], undefined))
        expect(maxDiff(baseline, await render(project))).toBeLessThan(1e-6)
        project.terminate()
    }, 30_000)
})

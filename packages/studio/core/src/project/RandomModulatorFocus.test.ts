import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Modulators, RandomModulatorBoxAdapter} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"

// jsdom lacks the Web Audio worklet globals that EngineWorklet extends at module-eval time.
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

// Mirrors the engine's `focus_pulls_random_draws_towards_the_bias`: the editor draws what the engine plays.
describe("random modulator focus", () => {
    it("pulls the draws towards the bias and leaves them untouched without focus", async () => {
        const {Project} = await import("./Project")
        const {ProjectSkeleton} = await import("@opendaw/studio-adapters")
        const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const box = project.editing.modify(() => Modulators.createRandom(project)).unwrap("no random")
        const adapter = project.boxAdapters.adapterFor(box, RandomModulatorBoxAdapter)
        const draws = (): ReadonlyArray<number> => Array.from({length: 256}, (_, index) => adapter.draw(index))
        const plain = draws()
        project.editing.modify(() => box.bias.setValue(0.5))
        expect(draws()).toEqual(plain)
        project.editing.modify(() => box.focus.setValue(0.75))
        const focused = draws()
        const near = (values: ReadonlyArray<number>) => values.filter(value => Math.abs(value - 0.5) < 0.25).length
        expect(near(focused)).toBeGreaterThan(near(plain) * 2)
        expect(focused.every(value => value >= -1.0 && value <= 1.0)).toBe(true)
        expect(focused.every((value, index) => value === 0.5 || Math.sign(value - 0.5) === Math.sign(plain[index] - 0.5))).toBe(true)
        expect(focused.some(value => value < -0.5)).toBe(true)
        project.editing.modify(() => box.focus.setValue(1.0))
        expect(draws().every(value => value === 0.5)).toBe(true)
        project.terminate()
    })
})

import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {GrooveAdapter, GrooveBox, GrooveDurations, GrooveKind, Grooves, ProjectSkeleton} from "@opendaw/studio-adapters"
import {GrooveFunctionBox, GrooveRandomBox, GrooveShuffleBox, GrooveStackBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {Reflect.set(globalThis, "AudioWorkletNode", class {})}

const env = {
    audioContext: undefined, audioWorklets: undefined, soundfontManager: undefined, sampleService: undefined,
    soundfontService: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    }
} as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(env, ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const Amounts = [0.0, 0.001, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999, 1.0]
const CellKinds: ReadonlyArray<GrooveKind> = ["shuffle", "power", "s-curve", "random"]

// positions over several cells: every cell start, just before and after it, and points inside
const positionsFor = (duration: number): ReadonlyArray<number> => {
    const positions: Array<number> = []
    for (let cell = 0; cell < 4; cell++) {
        const start = cell * duration
        positions.push(start, start + 1e-6, start + 1, start + duration * 0.25, start + duration * 0.5,
            start + duration * 0.75, start + duration - 1, start + duration - 1e-6)
    }
    return positions
}

const configure = (groove: GrooveBox, amount: number, duration: number): void => {
    if (groove instanceof GrooveStackBox) {return}
    groove.amount.setValue(amount)
    groove.duration.setValue(duration)
    if (groove instanceof GrooveRandomBox) {
        groove.roughness.setValue(1.0)
        groove.steps.setValue(16)
    }
}

// a shuffle at 0% or 100% squashes into [0.01, 0.99] and the others blend at most 98%, so a cell never collapses
const expectRoundTrip = (adapter: GrooveAdapter, position: number, tolerance: number, what: string): void => {
    const warped = adapter.warp(position)
    expect(Number.isFinite(warped), `${what} warp(${position}) is finite`).toBe(true)
    expect(Math.abs(adapter.unwarp(warped) - position), `${what} unwarp(warp(${position}))`).toBeLessThan(tolerance)
    const unwarped = adapter.unwarp(position)
    expect(Math.abs(adapter.warp(unwarped) - position), `${what} warp(unwarp(${position}))`).toBeLessThan(tolerance)
}

describe("grooves come back to the input through warp and unwarp", () => {
    it("every cell groove at every amount and duration", async () => {
        const project = await createProject()
        for (const kind of CellKinds) {
            const groove = project.editing.modify(() => Grooves.create(project, kind)).unwrap()
            const adapter = Grooves.adapterOf(project, groove)
            for (const duration of GrooveDurations.PPQNs) {
                for (const amount of Amounts) {
                    project.editing.modify(() => configure(groove, amount, duration))
                    positionsFor(duration).forEach(position =>
                        expectRoundTrip(adapter, position, duration * 1e-6 + 1e-6, `${kind} ${amount} ${duration}`))
                }
            }
        }
    })
    it("warp keeps every cell start and stays inside its cell", async () => {
        const project = await createProject()
        for (const kind of CellKinds) {
            const groove = project.editing.modify(() => Grooves.create(project, kind)).unwrap()
            const adapter = Grooves.adapterOf(project, groove)
            for (const amount of [0.0, 0.5, 1.0]) {
                project.editing.modify(() => configure(groove, amount, 960))
                for (let cell = 0; cell < 4; cell++) {
                    expect(adapter.warp(cell * 960)).toBeCloseTo(cell * 960, 9)
                    for (const offset of [1, 240, 480, 720, 959]) {
                        const warped = adapter.warp(cell * 960 + offset)
                        expect(warped).toBeGreaterThanOrEqual(cell * 960)
                        expect(warped).toBeLessThanOrEqual((cell + 1) * 960)
                    }
                }
            }
        }
    })
    it("warp never reorders positions", async () => {
        const project = await createProject()
        for (const kind of CellKinds) {
            const groove = project.editing.modify(() => Grooves.create(project, kind)).unwrap()
            const adapter = Grooves.adapterOf(project, groove)
            for (const amount of Amounts) {
                project.editing.modify(() => configure(groove, amount, 480))
                let previous = -Infinity
                for (let position = 0; position <= 1920; position += 7) {
                    const warped = adapter.warp(position)
                    expect(warped, `${kind} ${amount} @ ${position}`).toBeGreaterThanOrEqual(previous)
                    previous = warped
                }
            }
        }
    })
    it("a stack with many entries of every kind and extreme amounts", async () => {
        const project = await createProject()
        const stack = project.editing.modify(() => {
            const stack = Grooves.create(project, "stack") as GrooveStackBox
            const durations = GrooveDurations.PPQNs
            for (let index = 0; index < 24; index++) {
                const member = Grooves.create(project, CellKinds[index % CellKinds.length])
                configure(member, Amounts[index % Amounts.length], durations[index % durations.length])
                Grooves.addToStack(project, stack, member)
            }
            return stack
        }).unwrap()
        expect(Grooves.entriesOf(stack).length).toBe(24)
        const adapter = Grooves.adapterOf(project, stack)
        const span = adapter.cellDuration()
        expect(span).toBe(Math.max(...GrooveDurations.PPQNs))
        for (const position of [0, 1, 239, 240, 241, 480, 1000, 3839, 3840, 12345.678, span - 1, span, span * 2 + 17]) {
            expectRoundTrip(adapter, position, 1e-3, "stack")
        }
        let previous = -Infinity
        for (let position = 0; position <= 7680; position += 13) {
            const warped = adapter.warp(position)
            expect(warped).toBeGreaterThanOrEqual(previous)
            previous = warped
        }
    })
    const nestedStack = (project: Project, shuffleAmount: number, powerAmount: number): GrooveStackBox =>
        project.editing.modify(() => {
            const shuffle = Grooves.globalGroove(project) as GrooveShuffleBox
            shuffle.amount.setValue(shuffleAmount)
            const power = Grooves.create(project, "power") as GrooveFunctionBox
            power.amount.setValue(powerAmount)
            const inner = Grooves.create(project, "stack") as GrooveStackBox
            for (let index = 0; index < 8; index++) {Grooves.addToStack(project, inner, index % 2 === 0 ? shuffle : power)}
            const outer = Grooves.create(project, "stack") as GrooveStackBox
            Grooves.addToStack(project, outer, inner)
            Grooves.addToStack(project, outer, inner)
            Grooves.addToStack(project, outer, shuffle)
            return outer
        }).unwrap()
    it("a stack of stacks using the same grooves many times", async () => {
        const project = await createProject()
        const adapter = Grooves.adapterOf(project, nestedStack(project, 0.7, 0.3))
        for (const position of [0, 1, 100, 240, 479, 480, 959, 960, 1919.5, 3840]) {
            expectRoundTrip(adapter, position, 1e-3, "nested stack")
        }
    })
    it("a stack of extreme grooves stays finite and in order", async () => {
        // 17 shuffles at 100% and power at 0% pull every position of a cell onto almost the same tick, which no
        // unwarp can tell apart again, so only order and finiteness are checked
        const project = await createProject()
        const adapter = Grooves.adapterOf(project, nestedStack(project, 1.0, 0.0))
        let previous = -Infinity
        for (let position = 0; position <= 3840; position += 3) {
            const warped = adapter.warp(position)
            expect(Number.isFinite(warped) && Number.isFinite(adapter.unwarp(warped))).toBe(true)
            expect(warped).toBeGreaterThanOrEqual(previous)
            previous = warped
        }
    })
    it("an empty stack passes positions through", async () => {
        const project = await createProject()
        const stack = project.editing.modify(() => Grooves.create(project, "stack")).unwrap()
        const adapter = Grooves.adapterOf(project, stack)
        for (const position of [0, 123.456, 3840]) {
            expect(adapter.warp(position)).toBe(position)
            expect(adapter.unwarp(position)).toBe(position)
        }
    })
})

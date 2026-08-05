import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"
import type {RestartWorklet} from "./Project"
import type {EngineWorklet} from "../EngineWorklet"

// Reproduces live error 1083 (No profile available). Project.startAudioWorklet's error handler awaits
// restart.unload (the "Restart Engine" dialog) and then restarted unconditionally. When the project was closed
// while the dialog was open (closing the profile terminates the project), the chain resurrected an engine for a
// dead project and restart.load switched back to a project screen without a profile, panicking in
// StudioService.get profile. The handler must bail after unload once the project is terminated.

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

const createFakeWorklet = () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    return {
        playbackTimestamp: new DefaultObservableValue(0),
        countInBeatsRemaining: new DefaultObservableValue(0),
        position: new DefaultObservableValue(0),
        bpm: new DefaultObservableValue(120),
        isPlaying: new DefaultObservableValue(false),
        isRecording: new DefaultObservableValue(false),
        isCountingIn: new DefaultObservableValue(false),
        markerState: new DefaultObservableValue(null),
        cpuLoad: new DefaultObservableValue(0),
        preferences: {update: () => {}, subscribeAll: () => Terminable.Empty},
        context: {destination: {}},
        addEventListener: (type: string, listener: (event: unknown) => void) => {
            if (!listeners.has(type)) {listeners.set(type, new Set())}
            listeners.get(type)?.add(listener)
        },
        removeEventListener: (type: string, listener: (event: unknown) => void) => {
            listeners.get(type)?.delete(listener)
        },
        dispatch: (type: string, event: unknown) => listeners.get(type)?.forEach(listener => listener(event)),
        connect: () => {},
        isReady: () => new Promise(() => {}),
        terminate: () => {}
    }
}

type FakeWorklet = ReturnType<typeof createFakeWorklet>

const createEnv = (worklets: Array<FakeWorklet>): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: {
        createEngine: () => {
            const worklet = createFakeWorklet()
            worklets.push(worklet)
            return worklet
        }
    },
    sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const flushRestartChain = () => new Promise(resolve => setTimeout(resolve, 0))

describe("Worklet restart chain on a terminated project (live error 1083)", () => {
    it("does not restart the engine when the project was terminated during unload", async () => {
        const {Project} = await import("./Project")
        const worklets: Array<FakeWorklet> = []
        const project = Project.fromSkeleton(createEnv(worklets),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const loads: Array<EngineWorklet> = []
        const restart: RestartWorklet = {
            unload: async () => project.terminate(),
            load: (engine: EngineWorklet) => loads.push(engine)
        }
        project.startAudioWorklet(restart, {})
        expect(worklets.length).toBe(1)
        worklets[0].dispatch("processorerror", {type: "processorerror"})
        await flushRestartChain()
        expect(worklets.length, "no engine resurrected for a terminated project").toBe(1)
        expect(loads.length, "restart.load must not fire after termination").toBe(0)
    })
    it("still restarts the engine when the project is alive", async () => {
        const {Project} = await import("./Project")
        const worklets: Array<FakeWorklet> = []
        const project = Project.fromSkeleton(createEnv(worklets),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const loads: Array<EngineWorklet> = []
        const restart: RestartWorklet = {
            unload: async () => {},
            load: (engine: EngineWorklet) => loads.push(engine)
        }
        project.startAudioWorklet(restart, {})
        worklets[0].dispatch("processorerror", {type: "processorerror"})
        await flushRestartChain()
        expect(worklets.length, "a fresh engine was booted").toBe(2)
        expect(loads.length).toBe(1)
        expect(loads[0], "load receives the fresh engine").toBe(worklets[1])
        project.terminate()
    })
})

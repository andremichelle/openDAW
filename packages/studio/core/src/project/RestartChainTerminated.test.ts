import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, MutableObservableOption, Option, Terminable, UUID} from "@opendaw/lib-std"
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
        compensationLatency: new DefaultObservableValue(0),
        compensationExceeded: new DefaultObservableValue(false),
        position: new DefaultObservableValue(0),
        bpm: new DefaultObservableValue(120),
        isPlaying: new DefaultObservableValue(false),
        isRecording: new DefaultObservableValue(false),
        isCountingIn: new DefaultObservableValue(false),
        markerState: new DefaultObservableValue(null),
        cpuLoad: new DefaultObservableValue(0),
        recordingStart: new MutableObservableOption(),
        subscribeTransportAnchors: () => Terminable.Empty,
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

// Live errors 1240 to 1264: the browser reports a failed processor constructor without a cause (Chrome: a trusted
// ErrorEvent of type "error" with a message and no error). The processor sends the cause as an error event of its
// own, before or after, so the handler waits briefly for it before the restart dialog.
describe("Worklet error cause (live errors 1240 to 1264)", () => {
    const start = async () => {
        const {Project} = await import("./Project")
        const worklets: Array<FakeWorklet> = []
        const project = Project.fromSkeleton(createEnv(worklets),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const unloaded: Array<unknown> = []
        project.startAudioWorklet({unload: async event => {unloaded.push(event)}, load: () => {}}, {})
        return {project, worklets, unloaded}
    }
    const wait = (millis: number) => new Promise(resolve => setTimeout(resolve, millis))
    const causeless = () => new ErrorEvent("error", {message: "invoking user-supplied constructor failed"})
    const withCause = () => new ErrorEvent("error", {error: new Error("the real cause")})
    it("hands the cause to unload when it arrives after the causeless event", async () => {
        const {project, worklets, unloaded} = await start()
        const cause = withCause()
        worklets[0].dispatch("error", causeless())
        await wait(20)
        expect(unloaded.length, "still waiting for the cause").toBe(0)
        worklets[0].dispatch("error", causeless())
        worklets[0].dispatch("error", cause)
        await wait(20)
        expect(unloaded).toEqual([cause])
        project.terminate()
    })
    it("hands the cause to unload when it arrives first, the causeless event is ignored", async () => {
        const {project, worklets, unloaded} = await start()
        const cause = withCause()
        worklets[0].dispatch("error", cause)
        worklets[0].dispatch("error", causeless())
        await wait(20)
        expect(unloaded).toEqual([cause])
        project.terminate()
    })
    it("waits for the cause after a processorerror too", async () => {
        const {project, worklets, unloaded} = await start()
        const cause = withCause()
        worklets[0].dispatch("processorerror", new Event("processorerror"))
        worklets[0].dispatch("error", cause)
        await wait(20)
        expect(unloaded).toEqual([cause])
        project.terminate()
    })
    it("falls back to the causeless event when no cause arrives", async () => {
        const {project, worklets, unloaded} = await start()
        const event = causeless()
        worklets[0].dispatch("error", event)
        await wait(350)
        expect(unloaded).toEqual([event])
        project.terminate()
    })
})

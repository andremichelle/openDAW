import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, WclapDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../../core/src/project/ProjectEnv"
import {EffectFactories} from "../../core/src/EffectFactories"
import {WclapStates} from "../../core/src/wclap/WclapStates"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"

const WASM = path.resolve(__dirname, "../dist/wasm/engine.wasm")

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

type EngineExports = {
    checksum_ptr(): number
    init(sampleRate: number): void
    bind(): number
    apply_updates(len: number): number
    input_reserve(len: number): number
}

describe("WebCLAP plugin state as bytes", () => {
    it("keeps the engine mirror in sync through a legacy string, a 1 MB state and a cleared state", async () => {
        const memory = new WebAssembly.Memory({initial: 256})
        const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
        const env: Record<string, unknown> = {memory, __indirect_function_table: table, host_perf_now: () => performance.now() * 1000.0}
        const imports = {env: new Proxy(env, {get: (target, key: string) => key in target ? target[key] : () => 0})}
        const engine = new WebAssembly.Instance(await WebAssembly.compile(readFileSync(WASM)), imports as WebAssembly.Imports)
            .exports as unknown as EngineExports
        engine.init(48000)
        const {Project} = await import("../../core/src/project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        project.boxGraph.beginTransaction()
        const device = EffectFactories.AudioNamed.Wclap.create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox
        device.state.setValue(btoa("legacy"))
        project.boxGraph.endTransaction()
        const uuid = UUID.toString(device.address.uuid)
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks))
                const pointer = engine.input_reserve(bytes.length) // may grow and detach the old buffer
                new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(value: Int8Array): Promise<void> {
                const local = new Int8Array(memory.buffer, engine.checksum_ptr(), 32)
                return value.every((byte, index) => byte === local[index])
                    ? Promise.resolve() : Promise.reject(new Error("checksum mismatch"))
            }
        }
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(new BroadcastChannel("wclap-state-bytes-mirror")), target)
        const {SyncSource} = await import("@opendaw/lib-box")
        const syncSource = new SyncSource(project.boxGraph, Messenger.for(new BroadcastChannel("wclap-state-bytes-mirror")), true)
        const inSync = (): Promise<void> => syncSource.checksum(project.boxGraph.checksum())
        engine.bind()
        await expect(inSync()).resolves.toBeUndefined()
        WclapStates.store(project, uuid, new Uint8Array([0, 128, 255]).buffer)
        await expect(inSync()).resolves.toBeUndefined()
        WclapStates.store(project, uuid, Uint8Array.from({length: 1 << 20}, (_, index) => index & 0xFF).buffer)
        await expect(inSync()).resolves.toBeUndefined()
        WclapStates.store(project, uuid, new ArrayBuffer(0))
        await expect(inSync()).resolves.toBeUndefined()
        expect(device.pluginState.getValue().length).toBe(0)
        expect(device.state.getValue()).toBe("")
    })
})

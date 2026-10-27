// A WebCLAP parameter box deleted and created again (same address: WclapParameters derives the uuid from the
// device and the clap id, so a plugin that drops a parameter and reports it again gets the same box address)
// must get a fresh parameter adapter. The old one stayed registered in the
// project's ParameterFieldAdapters, and the plugin's next value report went through it: written to the deleted
// field, sent to the engine for the live box, the engine mirror diverged (box-graph checksum mismatch).

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, WclapDeviceBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../../core/src/project/ProjectEnv"
import {EffectFactories} from "../../core/src/EffectFactories"
import {WclapParameters} from "../../core/src/wclap/WclapParameters"
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
    input_ptr(): number
    checksum_ptr(): number
    init(sampleRate: number): void
    bind(): number
    apply_updates(len: number): number
}

describe("WebCLAP parameter box created again at the same address", () => {
    it("keeps the engine mirror in sync", async () => {
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
        project.boxGraph.endTransaction()
        const uuid = UUID.toString(device.address.uuid)

        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks))
                new Uint8Array(memory.buffer, engine.input_ptr(), bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(value: Int8Array): Promise<void> {
                const local = new Int8Array(memory.buffer, engine.checksum_ptr(), 32)
                return value.every((byte, index) => byte === local[index])
                    ? Promise.resolve() : Promise.reject(new Error("checksum mismatch"))
            }
        }
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(new BroadcastChannel("wclap-undo-mirror")), target)
        const {SyncSource} = await import("@opendaw/lib-box")
        const syncSource = new SyncSource(project.boxGraph, Messenger.for(new BroadcastChannel("wclap-undo-mirror")), true)
        const inSync = (): Promise<void> => syncSource.checksum(project.boxGraph.checksum())
        engine.bind()

        const cutoff = {id: 7, name: "Cutoff", module: "", min: 0, max: 1, defaultValue: 0, value: 0.1, flags: 0}
        WclapParameters.reconcile(project, uuid, [cutoff])
        await expect(inSync()).resolves.toBeUndefined()
        WclapParameters.reconcile(project, uuid, []) // the plugin drops it
        WclapParameters.reconcile(project, uuid, [cutoff]) // and reports it again
        await expect(inSync()).resolves.toBeUndefined()
        WclapParameters.apply(project, uuid, 7, 0.5, 0)
        const paramBox = device.parameters.pointerHub.incoming()[0].box as WclapParameterBox
        expect(paramBox.value.getValue()).toBe(0.5)
        await expect(inSync()).resolves.toBeUndefined()
    })
})

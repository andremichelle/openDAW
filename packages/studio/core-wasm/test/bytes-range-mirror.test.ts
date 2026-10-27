// A bytes field changed in a range reaches the Rust engine as an update-bytes task with only that range. The engine
// resolves it against its own copy of the field, so the graph checksums must stay equal through every kind of range
// edit, several in one transaction, edits of a box created in the same transaction, undo and redo.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {BoxEditing, UpdateTask, UpdateTasks} from "@opendaw/lib-box"
import {BoxIO, WclapDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../../core/src/project/ProjectEnv"
import {EffectFactories} from "../../core/src/EffectFactories"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"

const WASM = path.resolve(__dirname, "../dist/wasm/engine.wasm")
const MB = 1 << 20

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

const pattern = (length: number, seed: number = 0): Int8Array => Int8Array.from({length}, (_, index) => (index * 13 + seed) & 0x7f)

// a project with one WebCLAP device whose plugin-state is the bytes field under test, mirrored into a fresh engine
const setup = async () => {
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
    const graph = project.boxGraph
    const tasks: Array<UpdateTask<BoxIO.TypeMap>> = []
    const sent = {bytes: 0, kinds: [] as Array<string>}
    const send = (batch: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): number => {
        const bytes = new Uint8Array(serializeUpdateTasks(batch))
        const pointer = engine.input_reserve(bytes.length)
        new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
        sent.bytes = bytes.length
        sent.kinds = batch.map(task => task.type)
        return engine.apply_updates(bytes.length)
    }
    // the whole project once, as SyncSource's initialize does
    expect(send(graph.boxes().map<UpdateTask<BoxIO.TypeMap>>(box => ({
        type: "new", name: box.name as keyof BoxIO.TypeMap, uuid: box.address.uuid, buffer: box.toArrayBuffer()
    })))).toBe(0)
    engine.bind()
    graph.subscribeToAllUpdatesImmediate({onUpdate: update => tasks.push(UpdateTasks.of<BoxIO.TypeMap>(update))})
    graph.subscribeTransaction({
        onBeginTransaction: () => {},
        onEndTransaction: rolledBack => {
            const batch = tasks.splice(0)
            if (!rolledBack && batch.length > 0) {expect(send(batch)).toBe(0)}
        }
    })
    const inSync = (): boolean => {
        const local = graph.checksum()
        const remote = new Int8Array(memory.buffer, engine.checksum_ptr(), 32)
        return local.every((byte, index) => byte === remote[index])
    }
    const editing = new BoxEditing(graph)
    const device = editing.modify(() => EffectFactories.AudioNamed.Wclap
        .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
    return {graph, editing, device, sent, inSync}
}

describe("bytes range edits reach the engine", () => {
    it("a one byte edit of a megabyte sends a few bytes and keeps the checksum", async () => {
        const {editing, device, sent, inSync} = await setup()
        editing.modify(() => device.pluginState.setValue(pattern(MB)))
        expect(inSync()).toBe(true)
        editing.modify(() => device.pluginState.setByte(654_321, 3))
        expect(sent.kinds).toStrictEqual(["update-bytes"])
        expect(sent.bytes).toBeLessThan(200)
        expect(inSync()).toBe(true)
    })

    it("grows, shrinks, inserts and removes in the middle, every time in sync", async () => {
        const {editing, device, inSync} = await setup()
        editing.modify(() => device.pluginState.setValue(pattern(100_000)))
        const steps: ReadonlyArray<(value: Int8Array) => Int8Array> = [
            value => {const next = new Int8Array(value.length + 5000); next.set(value); return next},
            value => value.slice(0, value.length - 7000),
            value => {
                const next = new Int8Array(value.length + 10)
                next.set(value.subarray(0, 500))
                next.set(pattern(10, 9), 500)
                next.set(value.subarray(500), 510)
                return next
            },
            value => {
                const next = new Int8Array(value.length - 300)
                next.set(value.subarray(0, 20_000))
                next.set(value.subarray(20_300), 20_000)
                return next
            },
            value => {const next = value.slice(); next[0] = -1; next[next.length - 1] = -2; return next}
        ]
        for (const step of steps) {
            editing.modify(() => device.pluginState.setValue(step(device.pluginState.getValue() as Int8Array)))
            expect(inSync()).toBe(true)
        }
    })

    it("several range edits of the field in one transaction arrive in order", async () => {
        const {editing, device, sent, inSync} = await setup()
        editing.modify(() => device.pluginState.setValue(pattern(50_000)))
        editing.modify(() => {
            device.pluginState.setBytes(10, pattern(30, 1))
            device.pluginState.setLength(49_000)
            device.pluginState.setBytes(48_999, pattern(4, 2))
            device.pluginState.setByte(25_000, 77)
        })
        expect(sent.kinds).toStrictEqual(["update-bytes", "update-bytes", "update-bytes", "update-bytes"])
        expect(inSync()).toBe(true)
    })

    it("a range edit of a box created in the same transaction is applied to it", async () => {
        const {graph, editing, sent, inSync} = await setup()
        editing.modify(() => {
            const host = graph.boxes().find(box => box instanceof WclapDeviceBox) as WclapDeviceBox
            const created = WclapDeviceBox.create(graph, UUID.generate(), box => {
                box.host.refer(host.host.targetVertex.unwrap())
                box.index.setValue(1)
                box.pluginState.setValue(pattern(40_000))
            })
            created.pluginState.setByte(39_999, 5)
        })
        expect(sent.kinds).toContain("update-bytes")
        expect(inSync()).toBe(true)
    })

    it("undo and redo of range edits stay in sync", async () => {
        const {editing, device, inSync} = await setup()
        editing.modify(() => device.pluginState.setValue(pattern(MB)))
        for (let round = 0; round < 10; round++) {
            editing.modify(() => device.pluginState.setByte(round * 99_991, round))
        }
        for (let round = 0; round < 10; round++) {
            editing.undo()
            expect(inSync()).toBe(true)
        }
        for (let round = 0; round < 10; round++) {
            editing.redo()
            expect(inSync()).toBe(true)
        }
    })

    it("a whole new value of other bytes still goes as a whole value", async () => {
        const {editing, device, sent, inSync} = await setup()
        editing.modify(() => device.pluginState.setValue(pattern(1000)))
        editing.modify(() => device.pluginState.setValue(pattern(1000, 50)))
        expect(sent.kinds).toStrictEqual(["update-primitive"])
        expect(inSync()).toBe(true)
    })
})

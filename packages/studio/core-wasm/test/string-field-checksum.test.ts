// A JS string field may hold lone UTF-16 surrogates (e.g. a WebCLAP parameter name decoded from malformed
// UTF-8). The engine mirror used to decode string fields lossily (U+FFFD), so its checksum diverged from the
// source graph and the studio restarted the engine in a loop. The mirror must re-serialize every string byte-exact.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {Communicator} from "@opendaw/lib-runtime"
import {BoxGraph, SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, CaptureMidiBox, WclapInstrumentBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {createSyncLoopback} from "../src/sync/loopback"

const WASM = path.resolve(__dirname, "../dist/wasm/engine.wasm")

type EngineExports = {
    input_reserve(len: number): number
    checksum_ptr(): number
    init(sampleRate: number): void
    apply_updates(len: number): number
}

const loadEngine = async () => {
    const module = await WebAssembly.compile(readFileSync(WASM))
    const memory = new WebAssembly.Memory({initial: 256})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engine = new WebAssembly.Instance(module, {env: {memory, __indirect_function_table: table, host_perf_now: () => performance.now() * 1000.0}})
        .exports as unknown as EngineExports
    engine.init(48000)
    return {engine, memory}
}

describe("string fields: engine mirror stays byte-exact", () => {
    it("keeps the checksum equal for lone surrogates in any string field", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        const {engine, memory} = await loadEngine()
        const engineChecksum = (): Int8Array => new Int8Array(memory.buffer, engine.checksum_ptr(), 32).slice()
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates: (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void => {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks))
                const pointer = engine.input_reserve(bytes.length)
                new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum: () => Promise.resolve()
        }
        const loopback = createSyncLoopback()
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(loopback.target, target)
        const syncSource = new SyncSource<BoxIO.TypeMap>(source as BoxGraph<BoxIO.TypeMap>, loopback.source, true)
        expect(engineChecksum()).toEqual(source.checksum())
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const device = WclapInstrumentBox.create(source, UUID.generate(), box => {
            box.label.setValue("lone \udc00 in a new box"); box.host.refer(unit.input)
        })
        const parameter = WclapParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(device.parameters); box.label.setValue("M\ud861nch"); box.module.setValue("\ud800")
        })
        source.endTransaction()
        expect(engineChecksum()).toEqual(source.checksum())
        for (const text of ["a\udbffb", "tail \ud83d", "\udc00\ud800", "pair 👻 ok", "", "plain"]) {
            source.beginTransaction()
            parameter.label.setValue(text)
            device.state.setValue(text)
            source.endTransaction()
            expect(engineChecksum(), JSON.stringify(text)).toEqual(source.checksum())
        }
        syncSource.terminate()
        executor.terminate()
        loopback.terminate()
    })
})

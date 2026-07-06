// Shared WASM-engine boot + resource plumbing for BOTH studio hosts: the realtime worklet processor and
// the offline render worker. Links the engine + device side-modules (with the script/NAM bridges) and
// runs the sample/soundfont load handshakes over the UNCHANGED EngineToClient RPC.
import {isDefined, Procedure, Provider, tryCatch, UUID} from "@opendaw/lib-std"
import {EngineToClient} from "@opendaw/studio-adapters"
import {EngineExports, readPanicMessage} from "./engine-exports"
import {CompositeSpec} from "./engine-modules"
import {linkDevice, registerComposite} from "./device-linker"
import {ScriptBridges, ScriptEngine} from "./script-bridge"
import {NamBridges} from "./nam-bridge"
import {simplifySoundfont} from "./soundfont-simplify"

const ENGINE_TABLE_RESERVE = 512 // shared table slots reserved for the engine's own functions (it needs ~42)

export type WasmEngineModules = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module>
    deviceBoxTypes: ReadonlyArray<string>
    composites: ReadonlyArray<CompositeSpec>
}

// A wasm trap surfaces as an anonymous "RuntimeError: unreachable" (panic=abort strips the message);
// the engine's panic handler deposits the real message + location into a static buffer first, so attach
// it before the error leaves the host.
export const describeEngineTrap = (engine: EngineExports, memory: WebAssembly.Memory, error: unknown): unknown => {
    const message = tryCatch(() => readPanicMessage(engine, memory))
    if (message.status === "failure" || message.value.length === 0) {return error}
    return new Error(`wasm panic: ${message.value}`, {cause: error})
}

export const instantiateWasmEngine = (modules: WasmEngineModules, memory: WebAssembly.Memory,
                                      sampleRate: number, engineToClient: EngineToClient): EngineExports => {
    const table = new WebAssembly.Table({initial: ENGINE_TABLE_RESERVE, element: "anyfunc"})
    const now: Provider<number> = isDefined(globalThis.performance)
        ? () => performance.now() * 1000.0 : () => Date.now() * 1000.0
    const engine = new WebAssembly.Instance(modules.engineModule,
        {env: {memory, __indirect_function_table: table, host_perf_now: now}}).exports as unknown as EngineExports
    engine.init(sampleRate)
    const scriptBridges = new ScriptBridges(memory, engine as unknown as ScriptEngine, sampleRate,
        (uuid, message) => engineToClient.deviceMessage(uuid, message))
    const namBridges = new NamBridges(memory, () => engineToClient.fetchNamWasm(), sampleRate)
    const bridgeImports = {...scriptBridges.imports(), ...namBridges.imports()}
    modules.deviceModules.forEach((deviceModule, index) =>
        linkDevice(engine, memory, table, deviceModule, modules.deviceBoxTypes[index], sampleRate, bridgeImports))
    modules.composites.forEach(composite => registerComposite(engine, memory, composite))
    return engine
}

// Pop every sample/soundfont the engine queued and run the load handshake for each: fetch + decode over
// the EngineToClient RPC, write into the engine allocation, mark ready. Each runs as its own async chain
// tracked in `pending` (queryLoadingComplete awaits them); a failed sample resolves as 1-frame silence.
// A throw INSIDE a continuation (an engine trap while writing the allocation) would otherwise vanish as
// an unhandled rejection in the host's global scope, so it routes into `onError`.
export const drainResourceRequests = (engine: EngineExports, memory: WebAssembly.Memory,
                                      engineToClient: EngineToClient, pending: Set<Promise<unknown>>,
                                      fallbackSampleRate: number, onError: Procedure<unknown>): void => {
    const track = (promise: Promise<unknown>): void => {
        const guarded = promise.catch(onError)
        pending.add(guarded)
        guarded.finally(() => pending.delete(guarded))
    }
    for (; ;) {
        const outPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(outPtr)
        if (handle < 0) {break}
        const uuid = new Uint8Array(memory.buffer, outPtr, 16).slice() as UUID.Bytes
        track(engineToClient.fetchAudio(uuid).then(data => {
            const {numberOfFrames, numberOfChannels, sampleRate: dataRate, frames} = data
            const bytesPerChannel = numberOfFrames * Float32Array.BYTES_PER_ELEMENT
            const pointer = engine.sample_allocate(handle, numberOfChannels * bytesPerChannel)
            // A dead handle (its slot was freed + generation-bumped between the request and this async
            // delivery — e.g. the AudioFileBox delete/recreate churn when a recorded take is finalized)
            // returns 0. Writing the frames at address 0 would corrupt the engine's own memory, so skip:
            // the engine re-requests against the fresh handle when the new box syncs.
            if (pointer === 0) {return}
            for (let channel = 0; channel < numberOfChannels; channel++) {
                new Float32Array(memory.buffer, pointer + channel * bytesPerChannel, numberOfFrames)
                    .set(frames[channel])
            }
            engine.sample_set_ready(handle, numberOfFrames, numberOfChannels, dataRate)
        }, (reason: unknown) => {
            engine.sample_allocate(handle, 4)
            engine.sample_set_ready(handle, 1, 1, fallbackSampleRate)
            engineToClient.log(`sample load failed: ${reason}`)
        }))
    }
    for (; ;) {
        const outPtr = engine.input_reserve(16)
        const handle = engine.soundfont_take_request(outPtr)
        if (handle < 0) {break}
        const uuid = new Uint8Array(memory.buffer, outPtr, 16).slice() as UUID.Bytes
        track(engineToClient.fetchSoundfont(uuid).then(soundfont => {
            const blob = new Uint8Array(simplifySoundfont(soundfont))
            const pointer = engine.soundfont_allocate(handle, blob.byteLength)
            if (pointer === 0) {return} // dead handle (see the sample path): writing at 0 would corrupt memory
            new Uint8Array(memory.buffer, pointer, blob.byteLength).set(blob)
            engine.soundfont_set_ready(handle)
        }, (reason: unknown) => engineToClient.log(`soundfont load failed: ${reason}`)))
    }
}

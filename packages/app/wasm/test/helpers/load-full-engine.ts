// Loads the REAL engine.wasm AND every device side-module (delay, gate, vaporisateur, playfield slot, …) the
// same way the AudioWorklet does (engine-processor.ts), so a test can drive the actual DSP graph — not the
// bare engine with an empty device table. Reuse this for any test that needs real devices / composites.

import * as path from "node:path"
import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {UUID} from "@opendaw/lib-std"
import {ScriptBridges, ScriptEngine} from "../../src/script-bridge"
import {NamBridges} from "../../src/nam-bridge"
import {linkDevice, registerComposite} from "../../src/device-linker"
import {COMPOSITES, DEVICES as DEVICE_URLS} from "../../src/engine-modules"

const PUBLIC = path.resolve(__dirname, "../../public")

// ONE device/composite list for every context: the production tables from engine-modules, with the vite
// URL mapped to the public/ file name. The former local copies had already drifted (wrong composite cell
// field keys), which is exactly why they are gone.
const DEVICES: ReadonlyArray<{file: string, boxType: string}> =
    DEVICE_URLS.map(({url, boxType}) => ({file: url.slice(1), boxType}))

export type FullEngine = {
    engine: any
    memory: WebAssembly.Memory
    namBridges: NamBridges
    deviceBuilds(): number
    // Feed a synthetic sample to every load the engine has queued (on seeing an AudioFileBox), so sample-based
    // devices (a Playfield slot) are AUDIBLE in tests. Returns how many it satisfied. The real loader fetches +
    // decodes a file; here we write a fixed 0.5 s 220 Hz mono tone, which is enough to assert real signal. Call
    // it after building the project (and again after any edit that adds a sample).
    drainSamples(): number
}

export const loadFullEngine = async (sampleRate = 48000,
                                     onScriptMessage: (uuid: string, message: string) => void = () => {}): Promise<FullEngine> => {
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engineModule = await WebAssembly.compile(readFileSync(path.join(PUBLIC, "wasm", "engine.wasm")))
    const engine = new WebAssembly.Instance(engineModule, {env: {
        memory, __indirect_function_table: table,
        host_perf_now: () => performance.now() * 1000.0 // micros clock for the render profiler
    }}).exports as any
    engine.init(sampleRate)
    // User scripts read the `sampleRate` global (an AudioWorkletGlobalScope built-in); provide it in node so the
    // scriptable devices behave exactly as in the worklet.
    ;(globalThis as any).sampleRate = sampleRate
    // The script bridge runs the scriptable devices' user JavaScript over the shared memory (see script-bridge.ts).
    const scriptBridges = new ScriptBridges(memory, engine as ScriptEngine, sampleRate, onScriptMessage)
    // The nam bridge runs the NeuralAmp devices' nam-wasm inference; in node the binary comes from the package.
    const namBridges = new NamBridges(memory, async () => {
        const namWasmPath = createRequire(path.join(__dirname, "load-full-engine.ts")).resolve("@opendaw/nam-wasm/nam.wasm")
        const bytes = readFileSync(namWasmPath)
        // A node Buffer can sit at an offset inside a pooled ArrayBuffer; hand over exactly the file's bytes.
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }, sampleRate)
    const bridgeImports = {...scriptBridges.imports(), ...namBridges.imports()}

    for (const {file, boxType} of DEVICES) {
        const module = await WebAssembly.compile(readFileSync(path.join(PUBLIC, file)))
        linkDevice(engine, memory, table, module, boxType, sampleRate, bridgeImports)
    }
    for (const composite of COMPOSITES) {
        registerComposite(engine, memory, composite)
    }
    const drainSamples = (): number => {
        let satisfied = 0
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const frameCount = Math.floor(sampleRate * 0.5)
            const channelCount = 1
            const byteLength = frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT
            const pointer = engine.sample_allocate(handle, byteLength)
            const frames = new Float32Array(memory.buffer, pointer, frameCount)
            for (let frame = 0; frame < frameCount; frame++) {
                frames[frame] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate)
            }
            engine.sample_set_ready(handle, frameCount, channelCount, sampleRate)
            satisfied++
        }
        return satisfied
    }
    // Satisfy pending soundfont requests: the test supplies the simplified blob bytes for each requested uuid
    // (mirrors the main-thread SoundfontLoader that builds the blob from the parsed .sf2).
    const drainSoundfonts = (build: (uuid: string) => ArrayBuffer): number => {
        let satisfied = 0
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.soundfont_take_request(requestPtr)
            if (handle < 0) {break}
            const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(requestPtr, requestPtr + 16)) as UUID.Bytes)
            const blob = new Uint8Array(build(uuid))
            const pointer = engine.soundfont_allocate(handle, blob.byteLength)
            new Uint8Array(memory.buffer, pointer, blob.byteLength).set(blob)
            engine.soundfont_set_ready(handle)
            satisfied++
        }
        return satisfied
    }
    return {engine, memory, namBridges, deviceBuilds: () => engine.device_build_count() >>> 0, drainSamples, drainSoundfonts}
}

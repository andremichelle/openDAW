// Spike host: the real wasm engine with an empty project, metronome on, transport playing, driven from Rust
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineToClient, ProjectSkeleton} from "@opendaw/studio-adapters"
import {createEngineMemory, loadEngineModules} from "../../../studio/core-wasm/src/engine-modules"
import {createWclapBridges, instantiateWasmEngine} from "../../../studio/core-wasm/src/boot"
import {serializeUpdateTasks} from "../../../studio/core-wasm/src/sync/serialize-update-tasks"
import {EngineExports} from "../../../studio/core-wasm/src/engine-exports"

const RenderQuantum = 128

const engineToClient = new Proxy({}, {
    get: (_target, name) => (...args: Array<unknown>) => {
        if (String(name).startsWith("fetch")) {return Promise.reject(new Error(`${String(name)} is not available in the spike`))}
        if (name === "log" || name === "error") {console.log(`engine ${String(name)}`, ...args)}
        return undefined
    }
}) as EngineToClient

const state: { engine?: EngineExports, memory?: WebAssembly.Memory, garbage?: unknown } = {}

const init = async (sampleRate: number): Promise<void> => {
    ;(globalThis as unknown as { sampleRate: number }).sampleRate = sampleRate
    const modules = await loadEngineModules("/wasm-engine")
    const memory = createEngineMemory()
    const engine = instantiateWasmEngine(modules, memory, sampleRate, engineToClient, createWclapBridges(memory, sampleRate, engineToClient))
    const {boxGraph} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const tasks: Array<UpdateTask<BoxIO.TypeMap>> = boxGraph.boxes().map(box =>
        ({type: "new", name: box.name as keyof BoxIO.TypeMap, uuid: box.address.uuid, buffer: box.toArrayBuffer()}))
    const bytes = new Uint8Array(serializeUpdateTasks(tasks))
    const pointer = engine.input_reserve(bytes.length)
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
    if (engine.apply_updates(bytes.length) !== 0) {throw new Error("apply_updates rejected the project")}
    if (engine.bind() !== 0) {throw new Error("no TimelineBox")}
    engine.set_metronome_enabled(1)
    engine.play()
    state.engine = engine
    state.memory = memory
}

// renders one quantum interleaved into `out` (owned by Rust)
const render = (out: Float32Array): void => {
    const {engine, memory} = state
    if (engine === undefined || memory === undefined) {return}
    engine.render()
    const stress = (globalThis as unknown as { __stress: number }).__stress
    for (let index = 0; index < stress; index++) {state.garbage = {index, values: new Float64Array(64), text: `garbage ${index}`}}
    const pointer = engine.output_ptr()
    const left = new Float32Array(memory.buffer, pointer, RenderQuantum)
    const right = new Float32Array(memory.buffer, pointer + RenderQuantum * 4, RenderQuantum)
    for (let index = 0; index < RenderQuantum; index++) {
        out[index * 2] = left[index]
        out[index * 2 + 1] = right[index]
    }
}

;(globalThis as unknown as { spike: unknown }).spike = {init, render}

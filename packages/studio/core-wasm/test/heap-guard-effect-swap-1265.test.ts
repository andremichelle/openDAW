// Live error 1265 on the heap-guard engine (`sh build-guard-engine.sh`, run with OPENDAW_HEAP_GUARD=1): a loaded
// WebCLAP effect stays in the chain while stock effects are put in front of it and replaced one after another
// (Crusher, Compressor, Convolver, Delay, Convolver, Reverb), each delete followed by the next insert a few
// quanta later. Production trapped in the allocator's free while a device node was dropped.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {existsSync, readFileSync} from "node:fs"
import {tryCatch, UUID} from "@opendaw/lib-std"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    AutotuneDeviceBox,
    CompressorDeviceBox,
    ConvolverDeviceBox,
    CrusherDeviceBox,
    DelayDeviceBox,
    ReverbDeviceBox,
    WclapDeviceBox
} from "@opendaw/studio-boxes"
import {WclapBundle, WclapStatus} from "@opendaw/studio-adapters"
import {buildEffectProject} from "./helpers/effect-harness"
import {GUARD_ENGINE_WASM, loadFullEngine, useEngineWasm} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WET_CHORUS = "studio.opendaw.commons.wet-chorus"
const bundle: WclapBundle = {files: [{path: "module.wasm", bytes: new Uint8Array(readFileSync(path.resolve(__dirname, "assets", "wet-chorus.wasm")))}]}

type Creator = (graph: BoxGraph, unit: AudioUnitBox) => Box

const at0 = (unit: AudioUnitBox) => (box: {host: {refer(target: unknown): void}, index: {setValue(value: number): void}}): void => {
    box.host.refer(unit.audioEffects)
    box.index.setValue(0)
}

const CREATORS: Record<string, Creator> = {
    Crusher: (graph, unit) => CrusherDeviceBox.create(graph, UUID.generate(), at0(unit) as never),
    Compressor: (graph, unit) => CompressorDeviceBox.create(graph, UUID.generate(), at0(unit) as never),
    Convolver: (graph, unit) => ConvolverDeviceBox.create(graph, UUID.generate(), at0(unit) as never),
    Delay: (graph, unit) => DelayDeviceBox.create(graph, UUID.generate(), at0(unit) as never),
    Reverb: (graph, unit) => ReverbDeviceBox.create(graph, UUID.generate(), at0(unit) as never)
}

const LIVE_ORDER = ["Crusher", "Compressor", "Convolver", "Delay", "Convolver", "Reverb"]

const decodePanic = (engine: any, memory: WebAssembly.Memory): string => {
    const length = engine.panic_message_len() >>> 0
    return new TextDecoder().decode(new Uint8Array(memory.buffer, engine.panic_message_ptr(), length))
}

const rig = async (withAutotune: boolean) => {
    let unit: AudioUnitBox | null = null
    let wclap: WclapDeviceBox | null = null
    let autotune: AutotuneDeviceBox | null = null
    const graph = buildEffectProject(0.3, (source, unitBox) => {
        unit = unitBox
        wclap = WclapDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unitBox.audioEffects)
            box.index.setValue(0)
            box.url.setValue("wet-chorus")
            box.clapId.setValue(WET_CHORUS)
        })
        if (withAutotune) {
            autotune = AutotuneDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unitBox.audioEffects)
                box.index.setValue(1)
            })
        }
        return wclap
    })
    const statuses: Array<WclapStatus> = []
    const loads: Array<Promise<unknown>> = []
    const {engine, memory} = await loadFullEngine(48000, () => {}, () => null, {
        loadBundle: () => Promise.resolve(bundle),
        sendStatus: (_uuid, status) => statuses.push(status),
        track: promise => loads.push(promise)
    })
    const sync = connectSyncToEngine(engine, memory, graph)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const guarded = <T>(run: () => T): T => {
        const result = tryCatch(run)
        if (result.status === "success") {return result.value}
        const {error} = result
        if (error instanceof WebAssembly.RuntimeError) {
            throw new Error(`engine trap: ${decodePanic(engine, memory) || error.message}`)
        }
        throw error
    }
    const check = (): number => guarded(() => engine.heap_guard_check(1) >>> 0)
    const render = (count: number): void => {
        for (let quantum = 0; quantum < count; quantum++) {guarded(() => engine.render())}
        check()
    }
    const edit = async <T>(mutate: () => T): Promise<T> => {
        graph.beginTransaction()
        const value = mutate()
        graph.endTransaction()
        await sync.settle()
        check()
        return value
    }
    for (let attempt = 0; attempt < 100 && !statuses.some(({state}) => state === "ready"); attempt++) {
        render(8)
        await Promise.all(loads)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    return {graph, unit: unit!, wclap: wclap!, autotune: autotune as AutotuneDeviceBox | null, statuses, render, edit, check}
}

describe.skipIf(process.env.OPENDAW_HEAP_GUARD !== "1" || !existsSync(GUARD_ENGINE_WASM))("heap guard: stock effects swapped in front of a WebCLAP effect (1265)", () => {
    useEngineWasm(GUARD_ENGINE_WASM)

    for (const gap of [0, 1, 3, 19]) {
        for (const hold of [0, 1, 7, 64, 400]) {
            it(`live order, ${hold} quanta in the chain, ${gap} quanta until the next one`, async () => {
                const test = await rig(true)
                expect(test.statuses.some(({state}) => state === "ready")).toBe(true)
                test.render(64)
                await test.edit(() => {
                    test.autotune!.delete()
                })
                test.render(64)
                for (let round = 0; round < 3; round++) {
                    for (const name of LIVE_ORDER) {
                        const device = await test.edit(() => {
                            test.wclap.index.setValue(1)
                            return CREATORS[name](test.graph, test.unit)
                        })
                        test.render(hold)
                        await test.edit(() => {
                            device.delete()
                            test.wclap.index.setValue(0)
                        })
                        test.render(gap)
                    }
                }
                await test.edit(() => test.wclap.delete())
                test.render(16)
                expect(test.check()).toBeGreaterThan(0)
            }, 120000)
        }
    }

    it("delete and insert in one transaction (Replace)", async () => {
        const test = await rig(false)
        let device = await test.edit(() => {
            test.wclap.index.setValue(1)
            return CREATORS.Delay(test.graph, test.unit)
        })
        for (let round = 0; round < 40; round++) {
            const name = LIVE_ORDER[round % LIVE_ORDER.length]
            const previous = device
            device = await test.edit(() => {
                const next = CREATORS[name](test.graph, test.unit)
                previous.delete()
                return next
            })
            test.render(round % 9)
        }
        expect(test.check()).toBeGreaterThan(0)
    }, 120000)
})

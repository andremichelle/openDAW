// Heap stress on the heap-guard engine (`sh build-guard-engine.sh`, run with OPENDAW_HEAP_GUARD=1): every allocation carries guard
// bytes and freed blocks are poisoned + quarantined, so an overrun or a write into freed memory panics with the
// victim block instead of faulting later inside talc. Focus: deleting a Convolver while it builds its IR state
// (fresh insert, IR swap, normalize/reverse retransform, resampled and mono IRs), then a seeded random edit
// stress across several effects. `heap_guard_check` runs after every render and edit.
import {describe, expect, it} from "vitest"
import {existsSync} from "node:fs"
import {tryCatch, UUID} from "@opendaw/lib-std"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {
    AudioFileBox,
    AudioUnitBox,
    CompressorDeviceBox,
    ConvolverDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    ReverbDeviceBox
} from "@opendaw/studio-boxes"
import {buildEffectProject} from "./helpers/effect-harness"
import {GUARD_ENGINE_WASM, loadFullEngine, useEngineWasm} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const RATE = 48000

type Ir = {planes: Float32Array, frames: number, channels: number, rate: number}

const makeIr = (seconds: number, channels: number, rate: number, seed: number): Ir => {
    const frames = Math.round(rate * seconds)
    const planes = new Float32Array(frames * channels)
    for (let i = 0; i < planes.length; i++) {
        seed = (seed * 48271) % 2147483647
        planes[i] = ((seed / 2147483647) * 2 - 1) * 0.05 * Math.exp(-(i % frames) / (frames * 0.3))
    }
    return {planes, frames, channels, rate}
}

const decodePanic = (engine: any, memory: WebAssembly.Memory): string => {
    const length = engine.panic_message_len() >>> 0
    return new TextDecoder().decode(new Uint8Array(memory.buffer, engine.panic_message_ptr(), length))
}

type Rig = {
    graph: BoxGraph
    unit: AudioUnitBox
    engine: any
    memory: WebAssembly.Memory
    settle(): Promise<void>
    render(count: number): void
    check(poison?: boolean): number
    requestedHandles(): Array<number>
    deliver(handle: number, ir: Ir): void
    deliverAll(ir: Ir): number
    edit<T>(mutate: () => T): Promise<T>
}

const rig = async (): Promise<Rig> => {
    let unitBox: AudioUnitBox | null = null
    const graph = buildEffectProject(0.3, (_source, unit) => {
        unitBox = unit
        return unit
    })
    const {engine, memory} = await loadFullEngine()
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
    const check = (poison = true): number => guarded(() => engine.heap_guard_check(poison ? 1 : 0) >>> 0)
    let renders = 0
    const requestedHandles = (): Array<number> => {
        const handles: Array<number> = []
        for (; ;) {
            const handle = guarded(() => engine.sample_take_request(engine.input_reserve(16)))
            if (handle < 0) {break}
            handles.push(handle)
        }
        return handles
    }
    const deliver = (handle: number, ir: Ir): void => guarded(() => {
        const bytesPerChannel = ir.frames * 4
        const pointer = engine.sample_allocate(handle, ir.channels * bytesPerChannel)
        if (pointer === 0) {return}
        for (let channel = 0; channel < ir.channels; channel++) {
            new Float32Array(memory.buffer, pointer + channel * bytesPerChannel, ir.frames)
                .set(ir.planes.subarray(channel * ir.frames, (channel + 1) * ir.frames))
        }
        engine.sample_set_ready(handle, ir.frames, ir.channels, ir.rate)
        check()
    })
    const deliverAll = (ir: Ir): number => {
        const handles = requestedHandles()
        handles.forEach(handle => deliver(handle, ir))
        return handles.length
    }
    return {
        graph, unit: unitBox!, engine, memory,
        settle: () => sync.settle(),
        render: (count: number) => {
            for (let q = 0; q < count; q++) {
                guarded(() => engine.render())
                check(++renders % 16 === 0)
            }
        },
        check, requestedHandles, deliver, deliverAll,
        edit: async <T>(mutate: () => T): Promise<T> => {
            graph.beginTransaction()
            const value = mutate()
            graph.endTransaction()
            await sync.settle()
            check()
            return value
        }
    }
}

const fileFor = (graph: BoxGraph, ir: Ir, name: string): AudioFileBox =>
    AudioFileBox.create(graph, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0)
        box.endInSeconds.setValue(ir.frames / ir.rate)
        box.fileName.setValue(name)
    })

const insertConvolver = (graph: BoxGraph, unit: AudioUnitBox, file: AudioFileBox, index = 0): ConvolverDeviceBox =>
    ConvolverDeviceBox.create(graph, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(index)
        box.file.refer(file)
    })

const currentFile = (device: ConvolverDeviceBox): Box => device.file.targetVertex.unwrap().box

const swapFile = (graph: BoxGraph, device: ConvolverDeviceBox, ir: Ir): void => {
    const previous = currentFile(device)
    device.file.refer(fileFor(graph, ir, "swap"))
    previous.delete()
}

const deleteConvolver = (device: ConvolverDeviceBox): void => {
    const file = currentFile(device)
    device.delete()
    file.delete()
}

type Effect = ConvolverDeviceBox | DelayDeviceBox | CompressorDeviceBox | ReverbDeviceBox | DattorroReverbDeviceBox

const LOAD_STEPS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 64]

const IRS: ReadonlyArray<{label: string, ir: () => Ir}> = [
    {label: "2 s stereo 48k", ir: () => makeIr(2, 2, RATE, 7)},
    {label: "8 s stereo 48k", ir: () => makeIr(8, 2, RATE, 11)},
    {label: "8 s stereo 44.1k", ir: () => makeIr(8, 2, 44100, 13)},
    {label: "3 s mono 96k", ir: () => makeIr(3, 1, 96000, 17)},
    {label: "20 s stereo 48k (beyond max)", ir: () => makeIr(20, 2, RATE, 19)}
]

describe.skipIf(process.env.OPENDAW_HEAP_GUARD !== "1" || !existsSync(GUARD_ENGINE_WASM))("heap guard: convolver deletion while building its IR state", () => {
    useEngineWasm(GUARD_ENGINE_WASM)

    it("the guard reports a write past a sample allocation", async () => {
        const test = await rig()
        const ir = makeIr(0.1, 1, RATE, 3)
        await test.edit(() => insertConvolver(test.graph, test.unit, fileFor(test.graph, ir, "probe")))
        const [handle] = test.requestedHandles()
        const pointer = test.engine.sample_allocate(handle, ir.frames * 4)
        new Uint8Array(test.memory.buffer, pointer + ir.frames * 4, 4).fill(0x42)
        expect(() => test.check()).toThrow(/OVERRUN/)
    }, 30000)

    it("the guard reports a write into a freed sample", async () => {
        const test = await rig()
        const ir = makeIr(0.1, 1, RATE, 3)
        const device = await test.edit(() => insertConvolver(test.graph, test.unit, fileFor(test.graph, ir, "probe")))
        const [handle] = test.requestedHandles()
        const pointer = test.engine.sample_allocate(handle, ir.frames * 4)
        test.engine.sample_set_ready(handle, ir.frames, 1, RATE)
        test.render(4)
        await test.edit(() => deleteConvolver(device))
        test.render(4)
        new Uint8Array(test.memory.buffer, pointer, 4).fill(0x42)
        expect(() => test.check()).toThrow(/WRITE AFTER FREE/)
    }, 30000)

    for (const {label, ir: makeSource} of IRS) {
        it(`fresh insert, deleted during the first load (${label})`, async () => {
            const test = await rig()
            const ir = makeSource()
            for (const steps of LOAD_STEPS) {
                const device = await test.edit(() => insertConvolver(test.graph, test.unit, fileFor(test.graph, ir, "ir")))
                expect(test.deliverAll(ir)).toBe(1)
                test.render(steps)
                await test.edit(() => deleteConvolver(device))
                test.render(4)
            }
        }, 120000)

        it(`IR swap, deleted while the new IR loads (${label})`, async () => {
            const test = await rig()
            const first = makeIr(2, 2, RATE, 5)
            const next = makeSource()
            for (const steps of LOAD_STEPS) {
                const device = await test.edit(() => insertConvolver(test.graph, test.unit, fileFor(test.graph, first, "a")))
                test.deliverAll(first)
                test.render(96)
                await test.edit(() => swapFile(test.graph, device, next))
                expect(test.deliverAll(next)).toBe(1)
                test.render(steps)
                await test.edit(() => deleteConvolver(device))
                test.render(4)
            }
        }, 120000)

        it(`IR swap, deleted before the new IR arrives, delivered after (${label})`, async () => {
            const test = await rig()
            const first = makeIr(2, 2, RATE, 5)
            const next = makeSource()
            for (const steps of [0, 1, 8]) {
                const device = await test.edit(() => insertConvolver(test.graph, test.unit, fileFor(test.graph, first, "a")))
                test.deliverAll(first)
                test.render(64)
                await test.edit(() => swapFile(test.graph, device, next))
                const pending = test.requestedHandles()
                expect(pending.length).toBe(1)
                test.render(steps)
                await test.edit(() => deleteConvolver(device))
                pending.forEach(handle => test.deliver(handle, next))
                test.render(8)
            }
        }, 120000)

        it(`normalize/reverse retransform, deleted mid-load (${label})`, async () => {
            const test = await rig()
            const ir = makeSource()
            for (const steps of LOAD_STEPS) {
                const device = await test.edit(() => insertConvolver(test.graph, test.unit, fileFor(test.graph, ir, "ir")))
                test.deliverAll(ir)
                test.render(3)
                await test.edit(() => device.reverse.setValue(true))
                test.render(2)
                await test.edit(() => device.normalize.setValue(false))
                test.render(steps)
                await test.edit(() => deleteConvolver(device))
                test.render(4)
            }
        }, 120000)
    }

    it("seeded random edit stress across effects", async () => {
        const test = await rig()
        let seed = 1234567
        const random = (): number => {
            seed = (seed * 48271) % 2147483647
            return seed / 2147483647
        }
        const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]
        const irs = IRS.map(({ir}) => ir())
        const devices: Array<Effect> = []
        const convolvers = (): Array<ConvolverDeviceBox> =>
            devices.filter((device): device is ConvolverDeviceBox => device instanceof ConvolverDeviceBox)
        const reindex = (): void => devices.forEach((device, index) => device.index.setValue(index))
        const creators: ReadonlyArray<(index: number) => Effect> = [
            index => insertConvolver(test.graph, test.unit, fileFor(test.graph, pick(irs), "ir"), index),
            index => DelayDeviceBox.create(test.graph, UUID.generate(), box => {box.host.refer(test.unit.audioEffects); box.index.setValue(index)}),
            index => CompressorDeviceBox.create(test.graph, UUID.generate(), box => {box.host.refer(test.unit.audioEffects); box.index.setValue(index)}),
            index => ReverbDeviceBox.create(test.graph, UUID.generate(), box => {box.host.refer(test.unit.audioEffects); box.index.setValue(index)}),
            index => DattorroReverbDeviceBox.create(test.graph, UUID.generate(), box => {box.host.refer(test.unit.audioEffects); box.index.setValue(index)})
        ]
        let deliveries = 0
        for (let step = 0; step < 400; step++) {
            const action = random()
            if (action < 0.3 || devices.length === 0) {
                await test.edit(() => {
                    devices.splice(Math.floor(random() * (devices.length + 1)), 0, pick(creators)(devices.length))
                    reindex()
                })
            } else if (action < 0.55) {
                const victim = devices.splice(Math.floor(random() * devices.length), 1)[0]
                await test.edit(() => {
                    if (victim instanceof ConvolverDeviceBox) {deleteConvolver(victim)} else {victim.delete()}
                    reindex()
                })
            } else if (action < 0.75 && convolvers().length > 0) {
                const device = pick(convolvers())
                await test.edit(() => swapFile(test.graph, device, pick(irs)))
            } else if (action < 0.85 && convolvers().length > 0) {
                const device = pick(convolvers())
                await test.edit(() => random() < 0.5
                    ? device.reverse.setValue(!device.reverse.getValue())
                    : device.normalize.setValue(!device.normalize.getValue()))
            } else if (devices.length > 1) {
                const [moved] = devices.splice(Math.floor(random() * devices.length), 1)
                devices.splice(Math.floor(random() * (devices.length + 1)), 0, moved)
                await test.edit(() => reindex())
            }
            if (random() < 0.8) {deliveries += test.deliverAll(pick(irs))}
            test.render(Math.floor(random() * 24))
        }
        expect(deliveries).toBeGreaterThan(20)
        expect(test.check()).toBeGreaterThan(0)
    }, 300000)
})

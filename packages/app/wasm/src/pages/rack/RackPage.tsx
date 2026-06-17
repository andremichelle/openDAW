import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {MutableObservableOption} from "@opendaw/lib-std"
import {Env} from "../../Env"
import workletURL from "./rack-worklet.ts?worker&url"

// Comprehensive spike: four independent modules in one shared memory exercising every axis at once —
// shared memory, multiple distinct modules, two instances of one module (the filter), per-instance
// external state, the multi-input descriptor ABI (ring), a heap-allocating device (delay), and safe
// DSP via the abi shim.
type Device = { process: (descPtr: number) => void; heap_used?: () => number }
type EngineExports = {
    init: (sampleRate: number, sawHz: number, modHz: number,
           cutoff1: number, cutoff2: number, ringGain: number, feedback: number) => void
    out_ptr: () => number
    render: (frames: number) => void
}

const SAW = 220, MOD = 55, C1 = 0.15, C2 = 0.30, GAIN = 0.6, FB = 0.4, FRAMES = 128

export const RackPage: PageFactory<Env> = ({lifecycle}) => {
    const context = new MutableObservableOption<AudioContext>()
    const node = new MutableObservableOption<AudioWorkletNode>()
    const log: HTMLPreElement = <pre/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}
    const fetchAll = (): Promise<[ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer]> => Promise.all([
        fetch("/comp_engine.wasm").then(response => response.arrayBuffer()),
        fetch("/comp_filter.wasm").then(response => response.arrayBuffer()),
        fetch("/comp_ring.wasm").then(response => response.arrayBuffer()),
        fetch("/comp_delay.wasm").then(response => response.arrayBuffer())
    ])
    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const [engineBytes, filterBytes, ringBytes, delayBytes] = await fetchAll()
        const [engineModule, filterModule, ringModule, delayModule] = await Promise.all([
            WebAssembly.compile(engineBytes), WebAssembly.compile(filterBytes),
            WebAssembly.compile(ringBytes), WebAssembly.compile(delayBytes)
        ])
        const workletNode = new AudioWorkletNode(ctx, "rack", {
            processorOptions: {
                engineModule, filterModule, ringModule, delayModule, sampleRate: ctx.sampleRate,
                sawHz: SAW, modHz: MOD, cutoff1: C1, cutoff2: C2, ringGain: GAIN, feedback: FB
            }
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        await ctx.suspend()
        append(`booted @ ${ctx.sampleRate} Hz — engine + filter×2 + ring + heap delay, one memory`)
    }
    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {
            await context.unwrap().resume()
            append("playing — saw → 2 lowpass instances → ring mod → heap delay, all wasm-to-wasm")
        }
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {
            await context.unwrap().suspend()
            append("suspended")
        }
    }
    const measure = async (): Promise<void> => {
        const [engineBytes, filterBytes, ringBytes, delayBytes] = await fetchAll()
        const memory = new WebAssembly.Memory({initial: 256})
        const env = {memory}
        const filter = new WebAssembly.Instance(await WebAssembly.compile(filterBytes), {env}).exports as unknown as Device
        const ring = new WebAssembly.Instance(await WebAssembly.compile(ringBytes), {env}).exports as unknown as Device
        const delay = new WebAssembly.Instance(await WebAssembly.compile(delayBytes), {env}).exports as unknown as Device
        const engine = new WebAssembly.Instance(await WebAssembly.compile(engineBytes), {
            env, filter: {process: filter.process}, ring: {process: ring.process}, delay: {process: delay.process}
        }).exports as unknown as EngineExports
        engine.init(48000, SAW, MOD, C1, C2, GAIN, FB)
        const out = engine.out_ptr()
        const blocks = 128
        const full = new Float32Array(blocks * FRAMES)
        for (let block = 0; block < blocks; block++) {
            engine.render(FRAMES)
            full.set(new Float32Array(memory.buffer, out, FRAMES), block * FRAMES)
        }
        append(`heap: delay allocated ${delay.heap_used?.() ?? 0} bytes from its own arena`)
        const fround = Math.fround, PI = fround(3.1415927)
        const sine = (value: number): number => {
            const b = fround(4 / PI), c = fround(-4 / (PI * PI))
            const y = fround(fround(b * value) + fround(fround(c * value) * fround(Math.abs(value))))
            return fround(fround(0.225 * fround(fround(y * fround(Math.abs(y))) - y)) + y)
        }
        const incS = fround(SAW / 48000), incM = fround(MOD / 48000)
        const c1 = fround(C1), c2 = fround(C2), gain = fround(GAIN), fb = fround(FB)
        const line = new Float32Array(512)
        let ps = 0, pm = 0, y1a = 0, y1b = 0, pos = 0, error = 0
        for (let i = 0; i < full.length; i++) {
            let s = fround(0.5 * fround(fround(ps * 2) - 1)), m = sine(fround(fround(fround(pm * 2) - 1) * PI))
            ps = fround(ps + incS); if (ps >= 1) {ps = fround(ps - 1)}
            pm = fround(pm + incM); if (pm >= 1) {pm = fround(pm - 1)}
            y1a = fround(y1a + fround(c1 * fround(s - y1a))); s = y1a
            y1b = fround(y1b + fround(c2 * fround(m - y1b))); m = y1b
            let r = fround(fround(s * m) * gain)
            const echoed = fround(r + fround(fb * line[pos])); line[pos] = echoed; r = echoed; pos = (pos + 1) % 512
            error = Math.max(error, Math.abs(full[i] - r))
        }
        append(`full-rack parity vs f32 reference: ${error.toExponential(2)} ${error < 1e-5 ? "PASS" : "FAIL"}`)
        const iterations = 200000
        const start = performance.now()
        for (let i = 0; i < iterations; i++) {engine.render(FRAMES)}
        append(`bench: ${((performance.now() - start) * 1e6 / iterations).toFixed(0)} ns/block (whole rack)`)
    }
    lifecycle.own({
        terminate: () => {
            node.ifSome(workletNode => workletNode.disconnect())
            context.ifSome(ctx => void ctx.close())
        }
    })
    void boot()
    return (
        <div className="page">
            <h2>Comprehensive rack — every axis at once</h2>
            <p>Four independently compiled modules share one memory: the engine generates a saw and a
                sine, runs <strong>two instances</strong> of a lowpass (independent state), a
                ring modulator (<strong>two inputs</strong> via descriptor), and a feedback delay
                that <strong>allocates its line from its own heap</strong>. All DSP is safe Rust.</p>
            <button onclick={() => void play()}>▶ Play</button>
            <button onclick={() => void stop()}>■ Stop</button>
            <button onclick={() => void measure()}>Verify + benchmark</button>
            {log}
        </div>
    )
}

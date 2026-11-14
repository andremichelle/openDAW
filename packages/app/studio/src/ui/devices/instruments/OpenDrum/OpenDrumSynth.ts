import {clamp, int, Option, Terminable} from "@opendaw/lib-std"
import {WasmWorker} from "@opendaw/lib-wasm-worker"
import WasmWorkerUrl from "@opendaw/lib-wasm-worker/worker.js?worker&url"

export namespace OpenDrumSynth {
    export const SampleRate = 24000
    // the display draws every hit 6 dB down, so a loud hit stays inside it
    const Headroom = 0.5
    const ModuleUrl = `${import.meta.env.BASE_URL}wasm-engine/wasm/opendrum_wasm.wasm`

    /** What the display's pitch curve follows: the pitch falls by Pitch (and Drift) over Sweep. */
    export type Contour = { readonly pitch: number, readonly sweep: number, readonly drift?: number }
    const Engines = ["kick", "snare", "clap", "tom", "rim", "hat", "cymbal", "shaker", "bell", "perc"] as const
    export type Engine = typeof Engines[number]
    // the seconds each display shows, fixed so automation never rescales it
    const Spans: Record<Engine, number> = {
        kick: 1.0, snare: 0.5, clap: 0.5, tom: 0.5, rim: 0.125, hat: 0.5, cymbal: 1.0, shaker: 0.125, bell: 0.5,
        perc: 0.5
    }
    /** What to render: the engine, its values in box key order, and the curves to draw. */
    export type Request = {
        readonly engine: Engine
        readonly values: ReadonlyArray<number>
        readonly bpm: number
        readonly contour: Option<Contour>
    }
    /** The display's view of a hit: its trimmed length and a min and a max per column, curves per column. */
    export type Picture = {
        readonly length: int
        readonly span: number
        readonly peaks: Float32Array
        readonly envelope: Float32Array
        readonly pitch: Float32Array
    }
    /** One worker over the shared compiled module, whoever starts it terminates it. */
    export type Renderer = Terminable & {
        picture(request: Request, signal: AbortSignal): Promise<Picture>
    }
    // the display reduces every hit to this many min and max pairs over its span
    export const Columns = 1024
    export const OutOfDate = "engine out of date, rebuild the wasm"

    // the level curve holds the hit's peaks over this many seconds, longer than a period of its lowest tone
    const LevelWindow = 0.035

    const hold = (values: Float32Array, reach: int): Float32Array => values.map((_, column) => {
        let peak = 0.0
        const to = Math.min(values.length - 1, column + reach)
        for (let index = Math.max(0, column - reach); index <= to; index++) {peak = Math.max(peak, values[index])}
        return peak
    })

    const average = (values: Float32Array, reach: int): Float32Array => values.map((_, column) => {
        const from = Math.max(0, column - reach)
        const to = Math.min(values.length - 1, column + reach)
        let sum = 0.0
        for (let index = from; index <= to; index++) {sum += values[index]}
        return sum / (to - from + 1)
    })

    const level = (peaks: Float32Array, length: int, span: number): Float32Array => {
        const used = Math.min(Columns, Math.ceil(length / (span * SampleRate) * Columns))
        const reach = Math.max(1, Math.round(Math.min(LevelWindow, span / 32.0) / span * Columns / 2))
        const levels = new Float32Array(used).map((_, column) => clamp(peaks[column * 2 + 1], 0.0, 1.0))
        const envelope = new Float32Array(Columns)
        envelope.set(average(average(hold(levels, reach), reach), reach))
        return envelope
    }

    const pitchCurve = ({pitch: start, sweep, drift = 0}: Contour, length: int, span: number): Float32Array => {
        if (start === 0 && drift === 0) {return new Float32Array(0)}
        const pitch = new Float32Array(Columns)
        const range = Math.max(Math.abs(start) + drift, 1.0)
        const end = (length - 1) / SampleRate
        for (let column = 0; column < Columns; column++) {
            const seconds = Math.min(column / Columns * span, end)
            const bend = start * Math.exp(-seconds / Math.max(sweep, 0.0005))
                + drift * Math.exp(-seconds / Math.max(sweep * 10.0, 0.005))
            pitch[column] = bend / range
        }
        return pitch
    }

    export const followsTempo = (engine: Engine): boolean => engine === "kick"

    /** Equal for two requests that render the same hit. */
    export const keyOf = ({engine, values, bpm}: Request): string => `${engine}:${bpm}:${values.join(",")}`

    let compiled: Option<Promise<WebAssembly.Module>> = Option.None

    const compile = (): Promise<WebAssembly.Module> => {
        if (compiled.isEmpty()) {
            const module = fetch(ModuleUrl).then(response => response.ok
                ? WebAssembly.compileStreaming(response)
                : Promise.reject(new Error(`Could not load ${ModuleUrl} (${response.status})`)))
            module.catch(() => compiled = Option.None)
            compiled = Option.wrap(module)
        }
        return compiled.unwrap()
    }

    /** Starts a worker of its own for the caller, a device editor. */
    export const start = async (): Promise<Renderer> => {
        const module = await compile()
        const endpoint = WasmWorker.fromUrl(WasmWorkerUrl, "openDrum")
        const worker = WasmWorker.create({name: "openDrum", module, endpoint})
        const counted = await worker.call("param_counts", new ArrayBuffer(0), {maxResultBytes: 40})
            .catch((error: unknown) => {
                worker.terminate()
                return Promise.reject(error)
            })
        const counts = new Int32Array(counted)
        const input = ({engine, values, bpm}: Request): Promise<ArrayBuffer> =>
            values.length === counts[Engines.indexOf(engine)]
                ? Promise.resolve(
                    Float32Array.from([SampleRate, Spans[engine] * SampleRate, 0, Columns, bpm, ...values]).buffer)
                : Promise.reject(new Error(OutOfDate))
        return {
            picture: async (request: Request, signal: AbortSignal): Promise<Picture> => {
                const output = await worker.call(request.engine, await input(request),
                    {maxResultBytes: (2 + Columns * 2) * 4, signal})
                const floats = new Float32Array(output)
                const [length, display] = floats
                const span = display / SampleRate
                const peaks = floats.subarray(2).map(value => value * Headroom)
                const envelope = level(peaks, length, span)
                const pitch = request.contour.mapOr(contour => pitchCurve(contour, length, span), new Float32Array(0))
                return {length, span, peaks, envelope, pitch}
            },
            terminate: () => worker.terminate()
        }
    }
}

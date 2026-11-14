import {int, Option, Terminable} from "@opendaw/lib-std"
import {WasmWorker} from "@opendaw/lib-wasm-worker"
import WasmWorkerUrl from "@opendaw/lib-wasm-worker/worker.js?worker&url"

// the preview renders through the real engines (crates/opendrum), built as opendrum_wasm.wasm
export namespace OpenDrumSynth {
    // the display's picture renders at half the usual rate, about twice as fast and enough to draw it
    export const SampleRate = 24000
    export const MaxSeconds = 2.0
    // the display draws every hit 6 dB down, so a loud hit stays inside it
    const Headroom = 0.5
    const RumbleBars: ReadonlyArray<number> = [0.0625, 0.125, 0.25, 0.5, 1.0]
    const ModuleUrl = `${import.meta.env.BASE_URL}wasm-engine/wasm/opendrum_wasm.wasm`

    export type Kick = {
        tune: number, pitch: number, sweep: number, drift: number, decay: number, punch: number, shape: number
        click: number, tone: number, skin: number
        rumble: number, length: number, duck: number
        drive: number, velocity: number, play: number
        bright: number, volume: number, noise: number, glide: number
    }
    export type Snare = {
        tune: number, ratio: number, balance: number, pitch: number, sweep: number, decay: number, punch: number
        shape: number, level: number, wireDecay: number, width: number, curve: number
        click: number, tone: number, skin: number, drive: number
        volume: number, velocity: number, play: number, glide: number
    }
    export type Clap = {
        hands: number, gap: number, last: number, spread: number
        attack: number, decay: number, snap: number, drive: number
        tone: number, resonance: number
        room: number, roomDecay: number, tail: number
        volume: number, velocity: number, play: number
    }
    export type Tom = {
        tune: number, pitch: number, sweep: number, drift: number, decay: number, punch: number, shape: number
        drive: number, sub: number, ratio: number, top: number, length: number
        noise: number, noiseDecay: number, color: number, air: number
        volume: number, velocity: number, play: number, glide: number
    }
    export type Rim = {
        tune: number, ratio: number, balance: number, high: number, highRatio: number
        ring: number, ringHigh: number, decay: number, punch: number, drive: number, hard: number
        click: number, swell: number, cut: number, restart: number
        volume: number, velocity: number, play: number
    }
    export type Hat = {
        tune: number, color: number
        hold: number, decay: number
        spread: number, ring: number, reso: number, curve: number
        volume: number, velocity: number, play: number
    }
    export type Perc = {
        tune: number, ratio: number, index: number, bite: number
        pitch: number, sweep: number, decay: number, curve: number
        noise: number, drive: number
        volume: number, velocity: number, play: number
    }
    export type Bell = {
        tune: number, ratio: number, balance: number
        color: number, strike: number, decay: number
        volume: number, velocity: number, play: number
    }
    export type Shaker = {
        color: number, attack: number, decay: number, curve: number
        volume: number, velocity: number, play: number
    }
    export type Cymbal = {
        tune: number, tone: number, attack: number, decay: number
        volume: number, velocity: number, play: number
    }
    type Contour = {
        readonly pitch: number, readonly sweep: number, readonly drift: number, readonly decay: number
        readonly punch: number, readonly velocity: number
    }
    const Engines = ["kick", "snare", "clap", "tom", "rim", "hat", "cymbal", "shaker", "bell", "perc"] as const
    type Engine = typeof Engines[number]
    /** What to render: the engine, its values in the order the module reads them, and the curves to draw. */
    export type Request = {
        readonly engine: Engine
        readonly values: ReadonlyArray<number>
        readonly bpm: number
        readonly contour: Contour
    }
    /** The display's view of a hit: its trimmed length and a min and a max per column, curves per column. */
    export type Picture = {
        readonly length: int
        readonly peaks: Float32Array
        readonly envelope: Float32Array
        readonly pitch: Float32Array
        readonly softPitch: Float32Array
    }
    /** One worker over the shared compiled module, whoever starts it terminates it. */
    export type Renderer = Terminable & {
        picture(request: Request, signal: AbortSignal): Promise<Picture>
    }
    // the display reduces every hit to this many min and max pairs over MaxSeconds
    export const Columns = 1024
    // the render ends where the display ends
    const DisplayFrames = MaxSeconds * SampleRate
    export const OutOfDate = "engine out of date, rebuild the wasm"

    // the display curves follow the engine: the sweeps fall exponentially, the level blends exponential and linear
    const curves = (contour: Contour, length: int): Pick<Picture, "envelope" | "pitch" | "softPitch"> => {
        const envelope = new Float32Array(Columns)
        const pitch = new Float32Array(Columns)
        const softPitch = new Float32Array(Columns)
        const rate = Math.log(1000.0) / Math.max(contour.decay, 0.0001)
        const range = Math.max(Math.abs(contour.pitch) + contour.drift, 1.0)
        const soft = 1.0 - contour.velocity * 0.5
        const end = (length - 1) / SampleRate
        for (let column = 0; column < Columns; column++) {
            const seconds = Math.min(column / Columns * MaxSeconds, end)
            const bend = contour.pitch * Math.exp(-seconds / Math.max(contour.sweep, 0.0005))
                + contour.drift * Math.exp(-seconds / Math.max(contour.sweep * 10.0, 0.005))
            const exponential = Math.exp(-seconds * rate)
            const tail = 1.0 + (Math.sqrt(1000.0) - 1.0) * seconds / Math.max(contour.decay, 0.0001)
            const target = contour.punch >= 0.0 ? Math.max(0.0, 1.0 - seconds / contour.decay) : 1.0 / (tail * tail)
            envelope[column] = exponential + (target - exponential) * Math.abs(contour.punch)
            pitch[column] = bend / range
            softPitch[column] = bend * (0.5 + 0.5 * soft) / range
        }
        return {envelope, pitch, softPitch}
    }

    /** Equal for two requests that render the same hit. */
    export const keyOf = ({engine, values, bpm}: Request): string => `${engine}:${bpm}:${values.join(",")}`

    const request = (engine: Engine, values: ReadonlyArray<number>, contour: Contour,
                     bpm: number = 120): Request => ({engine, values, bpm, contour})

    export const kick = (kick: Kick, bpm: number): Request => request("kick", [kick.tune, kick.pitch, kick.sweep,
        kick.drift, kick.decay, kick.punch, kick.shape, kick.click, kick.tone, kick.skin, kick.rumble,
        RumbleBars[kick.length], kick.duck, kick.drive, kick.velocity, kick.play, kick.bright, kick.volume, kick.noise,
        kick.glide], kick, bpm)
    export const snare = (snare: Snare): Request => request("snare", [snare.tune, snare.ratio, snare.balance,
        snare.pitch, snare.sweep, snare.decay, snare.punch, snare.shape, snare.level, snare.wireDecay, snare.width,
        snare.curve, snare.click, snare.tone, snare.skin, snare.drive, snare.volume, snare.velocity, snare.play,
        snare.glide], {...snare, drift: 0})
    export const cymbal = (cymbal: Cymbal): Request => request("cymbal", [cymbal.tune, cymbal.tone, cymbal.attack,
        cymbal.decay, cymbal.volume, cymbal.velocity, cymbal.play],
        {pitch: 0, sweep: 0.001, drift: 0, decay: cymbal.decay, punch: 1, velocity: cymbal.velocity})
    export const perc = (perc: Perc): Request => request("perc", [perc.tune, perc.ratio, perc.index, perc.bite,
        perc.pitch, perc.sweep, perc.decay, perc.curve, perc.noise, perc.drive, perc.volume, perc.velocity, perc.play],
        {pitch: perc.pitch, sweep: perc.sweep, drift: 0, decay: perc.decay, punch: perc.curve, velocity: perc.velocity})
    export const bell = (bell: Bell): Request => request("bell", [bell.tune, bell.ratio, bell.balance, bell.color,
        bell.strike, bell.decay, bell.volume, bell.velocity, bell.play],
        {pitch: 0, sweep: 0.001, drift: 0, decay: bell.decay, punch: -bell.strike, velocity: bell.velocity})
    export const shaker = (shaker: Shaker): Request => request("shaker", [shaker.color, shaker.attack, shaker.decay,
        shaker.curve, shaker.volume, shaker.velocity, shaker.play], {pitch: 0, sweep: 0.001, drift: 0,
        decay: shaker.attack + shaker.decay, punch: shaker.curve, velocity: shaker.velocity})
    export const hat = (hat: Hat): Request => request("hat", [hat.tune, hat.color, hat.hold, hat.decay, hat.spread,
        hat.ring, hat.reso, hat.curve, hat.volume, hat.velocity, hat.play],
        {pitch: 0, sweep: 0.001, drift: 0, decay: hat.decay, punch: hat.curve, velocity: hat.velocity})
    export const rim = (rim: Rim): Request => request("rim", [rim.tune, rim.ratio, rim.balance, rim.high,
        rim.highRatio, rim.ring, rim.ringHigh, rim.decay, rim.punch, rim.drive, rim.hard, rim.click, rim.swell,
        rim.cut, rim.restart, rim.volume, rim.velocity, rim.play],
        {pitch: 0, sweep: 0.001, drift: 0, decay: rim.decay, punch: rim.punch, velocity: rim.velocity})
    export const tom = (tom: Tom): Request => request("tom", [tom.tune, tom.pitch, tom.sweep, tom.drift, tom.decay,
        tom.punch, tom.shape, tom.sub, tom.ratio, tom.top, tom.length, tom.drive, tom.noise, tom.noiseDecay, tom.color,
        tom.air, tom.volume, tom.velocity, tom.play, tom.glide], tom)
    export const clap = (clap: Clap): Request => request("clap", [clap.hands, clap.gap, clap.last, clap.spread,
        clap.attack, clap.decay, clap.snap, clap.drive, clap.tone, clap.resonance, clap.room, clap.roomDecay,
        clap.tail, clap.volume, clap.velocity, clap.play],
        {pitch: 0, sweep: 0.001, drift: 0, decay: clap.roomDecay, punch: 0, velocity: clap.velocity})

    let compiled: Option<Promise<WebAssembly.Module>> = Option.None

    // compiled once, every worker instantiates the same module
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

    /** Starts a worker of its own for the caller (a device editor, the preview page). */
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
        // the page and the served engine must agree on the number of values, a stale engine would shift them
        const input = ({engine, values, bpm}: Request): Promise<ArrayBuffer> =>
            values.length === counts[Engines.indexOf(engine)]
                ? Promise.resolve(
                    Float32Array.from([SampleRate, DisplayFrames, DisplayFrames, Columns, bpm, ...values]).buffer)
                : Promise.reject(new Error(OutOfDate))
        return {
            picture: async (request: Request, signal: AbortSignal): Promise<Picture> => {
                const output = await worker.call(request.engine, await input(request),
                    {maxResultBytes: (1 + Columns * 2) * 4, signal})
                const floats = new Float32Array(output)
                const length = floats[0]
                const peaks = floats.subarray(1).map(value => value * Headroom)
                return {length, peaks, ...curves(request.contour, length)}
            },
            terminate: () => worker.terminate()
        }
    }
}

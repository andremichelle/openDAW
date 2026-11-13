import {int} from "@opendaw/lib-std"

// the preview renders through the real engines (crates/opendrum), built as opendrum_wasm.wasm
export namespace OpenDrumSynth {
    export const SampleRate = 48000
    export const MaxSeconds = 2.0
    // every hit and every reference plays 6 dB down, so a loud hit never clips and levels stay comparable
    export const Headroom = 0.5
    export const PlayModes: ReadonlyArray<string> = ["Mono", "Poly", "Gate"]
    export const RumbleLengths: ReadonlyArray<string> = ["1/16", "1/8", "1/4", "1/2", "1/1"]
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
    type Contour = {
        readonly pitch: number, readonly sweep: number, readonly drift: number, readonly decay: number
        readonly punch: number, readonly velocity: number
    }
    export type Hit = {
        readonly samples: Float32Array
        readonly envelope: Float32Array
        readonly pitch: Float32Array
        readonly softPitch: Float32Array
    }
    export type Renderer = {
        renderKick(kick: Kick, bpm: number): Hit
        renderSnare(snare: Snare): Hit
        renderClap(clap: Clap): Hit
        renderTom(tom: Tom): Hit
    }

    type Exports = {
        memory: WebAssembly.Memory
        alloc_floats(count: int): int
        kick_param_count(): int
        snare_param_count(): int
        clap_param_count(): int
        tom_param_count(): int
        render_kick(params: int, velocity: number, bpm: number, sampleRate: number, output: int, frames: int): void
        render_snare(params: int, velocity: number, sampleRate: number, output: int, frames: int): void
        render_clap(params: int, velocity: number, sampleRate: number, output: int, frames: int): void
        render_tom(params: int, velocity: number, sampleRate: number, output: int, frames: int): void
    }

    const isExports = (value: WebAssembly.Exports): value is WebAssembly.Exports & Exports =>
        value.memory instanceof WebAssembly.Memory && typeof value.render_kick === "function"
        && typeof value.render_snare === "function" && typeof value.render_clap === "function"
        && typeof value.render_tom === "function"

    // the display curves follow the engine: the sweeps fall exponentially, the level blends exponential and linear
    const curves = (kick: Contour, frames: int): Pick<Hit, "envelope" | "pitch" | "softPitch"> => {
        const envelope = new Float32Array(frames)
        const pitch = new Float32Array(frames)
        const softPitch = new Float32Array(frames)
        const rate = Math.log(1000.0) / Math.max(kick.decay, 0.0001)
        const range = Math.max(kick.pitch + kick.drift, 1.0)
        const soft = 1.0 - kick.velocity * 0.5
        for (let index = 0; index < frames; index++) {
            const seconds = index / SampleRate
            const bend = kick.pitch * Math.exp(-seconds / Math.max(kick.sweep, 0.0005))
                + kick.drift * Math.exp(-seconds / Math.max(kick.sweep * 10.0, 0.005))
            const exponential = Math.exp(-seconds * rate)
            const tail = 1.0 + (Math.sqrt(1000.0) - 1.0) * seconds / Math.max(kick.decay, 0.0001)
            const target = kick.punch >= 0.0 ? Math.max(0.0, 1.0 - seconds / kick.decay) : 1.0 / (tail * tail)
            envelope[index] = exponential + (target - exponential) * Math.abs(kick.punch)
            pitch[index] = bend / range
            softPitch[index] = bend * (0.5 + 0.5 * soft) / range
        }
        return {envelope, pitch, softPitch}
    }

    export const load = async (): Promise<Renderer> => {
        const response = await fetch(ModuleUrl)
        if (!response.ok) {return Promise.reject(new Error(`Could not load ${ModuleUrl} (${response.status})`))}
        const {instance} = await WebAssembly.instantiate(await response.arrayBuffer(), {})
        const exports = instance.exports
        if (!isExports(exports)) {return Promise.reject(new Error(`${ModuleUrl} has unexpected exports`))}
        const count = Math.max(exports.kick_param_count(), exports.snare_param_count(), exports.clap_param_count(),
            exports.tom_param_count())
        const frames = MaxSeconds * SampleRate
        const params = exports.alloc_floats(count)
        const output = exports.alloc_floats(frames)
        const collect = (contour: Contour): Hit => {
            const rendered = new Float32Array(exports.memory.buffer, output, frames)
            let last = frames - 1
            while (last > 0 && Math.abs(rendered[last]) < 0.0001) {last--}
            const length = Math.min(frames, last + 1 + 480)
            const samples = rendered.slice(0, length)
            samples.forEach((value, index) => samples[index] = value * Headroom)
            return {samples, ...curves(contour, length)}
        }
        return {
            renderKick: (kick: Kick, bpm: number): Hit => {
                const values = [kick.tune, kick.pitch, kick.sweep, kick.drift, kick.decay, kick.punch, kick.shape, kick.click,
                    kick.tone, kick.skin, kick.rumble, RumbleBars[kick.length], kick.duck, kick.drive, kick.velocity,
                    kick.play, kick.bright, kick.volume, kick.noise, kick.glide]
                new Float32Array(exports.memory.buffer, params, values.length).set(values)
                exports.render_kick(params, 1.0, bpm, SampleRate, output, frames)
                return collect(kick)
            },
            renderSnare: (snare: Snare): Hit => {
                const values = [snare.tune, snare.ratio, snare.balance, snare.pitch, snare.sweep, snare.decay, snare.punch,
                    snare.shape, snare.level, snare.wireDecay, snare.width, snare.curve, snare.click,
                    snare.tone, snare.skin, snare.drive, snare.volume, snare.velocity, snare.play, snare.glide]
                new Float32Array(exports.memory.buffer, params, values.length).set(values)
                exports.render_snare(params, 1.0, SampleRate, output, frames)
                return collect({...snare, drift: 0})
            },
            renderTom: (tom: Tom): Hit => {
                const values = [tom.tune, tom.pitch, tom.sweep, tom.drift, tom.decay, tom.punch, tom.shape, tom.sub,
                    tom.ratio, tom.top, tom.length, tom.drive, tom.noise, tom.noiseDecay, tom.color, tom.air,
                    tom.volume, tom.velocity, tom.play, tom.glide]
                new Float32Array(exports.memory.buffer, params, values.length).set(values)
                exports.render_tom(params, 1.0, SampleRate, output, frames)
                return collect(tom)
            },
            renderClap: (clap: Clap): Hit => {
                const values = [clap.hands, clap.gap, clap.last, clap.spread, clap.attack, clap.decay, clap.snap,
                    clap.drive, clap.tone, clap.resonance, clap.room, clap.roomDecay, clap.tail, clap.volume, clap.velocity,
                    clap.play]
                new Float32Array(exports.memory.buffer, params, values.length).set(values)
                exports.render_clap(params, 1.0, SampleRate, output, frames)
                return collect({pitch: 0, sweep: 0.001, drift: 0, decay: clap.roomDecay, punch: 0, velocity: clap.velocity})
            }
        }
    }
}

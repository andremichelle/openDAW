// WASM CONTRACT: mirrors crates/matchering/src/exports.rs (exports, statuses, profile and result layouts).
import {panic, Procedure} from "@opendaw/lib-std"
import {Matchering} from "./Matchering"

interface Exports {
    memory: WebAssembly.Memory
    alloc_bytes(length: number): number
    free_bytes(pointer: number, length: number): void
    bins(): number
    analyse_reference(left: number, right: number, frames: number, output: number): number
    match_target(left: number, right: number, frames: number, profile: number, output: number): number
}

const Statuses: Record<number, string> = {1: "too short", 2: "too long", 3: "channel lengths differ"}
const Stages: ReadonlyArray<Matchering.Stage> = ["levels", "frequencies", "correction"]

export class MatcheringWasm {
    static async instantiate(bytes: BufferSource, progress: Procedure<Matchering.Stage>): Promise<MatcheringWasm> {
        const {instance} = await WebAssembly.instantiate(bytes, {env: {progress: (stage: number) => progress(Stages[stage])}})
        return new MatcheringWasm(instance.exports as unknown as Exports)
    }

    readonly #exports: Exports
    readonly #bins: number

    private constructor(exports: Exports) {
        this.#exports = exports
        this.#bins = exports.bins()
    }

    analyseReference(left: Float32Array, right: Float32Array): Matchering.ReferenceProfile {
        const output = this.#run(left, right, 2 + 2 * this.#bins, [], (leftPointer, rightPointer, outputPointer) =>
            this.#exports.analyse_reference(leftPointer, rightPointer, left.length, outputPointer))
        return {
            matchRms: output[0], finalAmplitude: output[1],
            midSpectrum: output.slice(2, 2 + this.#bins), sideSpectrum: output.slice(2 + this.#bins)
        }
    }

    matchTarget(left: Float32Array, right: Float32Array, profile: Matchering.ReferenceProfile): Matchering.MatchResult {
        const profileValues = [profile.matchRms, profile.finalAmplitude, ...profile.midSpectrum, ...profile.sideSpectrum]
        const output = this.#run(left, right, 2 + 2 * this.#bins, profileValues,
            (leftPointer, rightPointer, outputPointer, profilePointer) =>
                this.#exports.match_target(leftPointer, rightPointer, left.length, profilePointer, outputPointer))
        return {
            gain: output[0], finalAmplitude: output[1],
            midCurve: output.slice(2, 2 + this.#bins), sideCurve: output.slice(2 + this.#bins)
        }
    }

    #run(left: Float32Array, right: Float32Array, outputLength: number, input: ReadonlyArray<number>,
         call: (left: number, right: number, output: number, input: number) => number): Float64Array {
        const exports = this.#exports
        const channelBytes = left.length * Float32Array.BYTES_PER_ELEMENT
        const outputBytes = outputLength * Float64Array.BYTES_PER_ELEMENT
        const inputBytes = Math.max(1, input.length) * Float64Array.BYTES_PER_ELEMENT
        const leftPointer = exports.alloc_bytes(channelBytes)
        const rightPointer = exports.alloc_bytes(channelBytes)
        const outputPointer = exports.alloc_bytes(outputBytes)
        const inputPointer = exports.alloc_bytes(inputBytes)
        new Float32Array(exports.memory.buffer, leftPointer, left.length).set(left)
        new Float32Array(exports.memory.buffer, rightPointer, right.length).set(right)
        new Float64Array(exports.memory.buffer, inputPointer, input.length).set(input)
        const status = call(leftPointer, rightPointer, outputPointer, inputPointer)
        const output = new Float64Array(exports.memory.buffer, outputPointer, outputLength).slice()
        exports.free_bytes(leftPointer, channelBytes)
        exports.free_bytes(rightPointer, channelBytes)
        exports.free_bytes(outputPointer, outputBytes)
        exports.free_bytes(inputPointer, inputBytes)
        return status === 0 ? output : panic(`Matchering: audio is ${Statuses[status] ?? `invalid (${status})`}`)
    }
}

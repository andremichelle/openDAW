import {Option, SortedSet, Terminable} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"
import {AudioBuffer} from "@moises-ai/lib-dsp"
import {Processor} from "./processing"

export type AudioOutputBuffer = {
    readonly address: Address
    readonly buffer: AudioBuffer
    readonly processor: Processor
}

export class AudioOutputBufferRegistry {
    readonly #outputs: SortedSet<Address, AudioOutputBuffer>

    constructor() {
        this.#outputs = Address.newSet<AudioOutputBuffer>(({address}) => address)
    }

    register(address: Address, buffer: AudioBuffer, processor: Processor): Terminable {
        this.#outputs.add({address, buffer, processor})
        return {terminate: () => this.#outputs.removeByKey(address)}
    }

    resolve(address: Address): Option<AudioOutputBuffer> {
        return this.#outputs.opt(address)
    }
}

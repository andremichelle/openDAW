import {Option, SortedSet, Terminable} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AudioBuffer} from "@opendaw/lib-dsp"
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
        console.debug("register", address.toString(), processor)
        this.#outputs.add({address, buffer, processor})
        return {terminate: () => this.#outputs.removeByKey(address)}
    }

    resolve(address: Address): Option<AudioOutputBuffer> {
        return this.#outputs.opt(address)
    }
}

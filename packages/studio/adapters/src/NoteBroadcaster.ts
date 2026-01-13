import {LiveStreamBroadcaster} from "@moises-ai/lib-fusion"
import {Address} from "@moises-ai/lib-box"
import {Bits, int, Terminable, Terminator} from "@moises-ai/lib-std"

export class NoteBroadcaster implements Terminable {
    readonly #terminator = new Terminator()
    readonly #broadcaster: LiveStreamBroadcaster
    readonly #address: Address

    readonly #bits: Bits

    constructor(broadcaster: LiveStreamBroadcaster, address: Address) {
        this.#broadcaster = broadcaster
        this.#address = address

        this.#bits = new Bits(128)
        this.#terminator.own(
            this.#broadcaster.broadcastIntegers(this.#address, new Int32Array(this.#bits.buffer), (_hasSubscribers) => {})
        )
    }

    noteOn(note: int): void {
        if (note >= 0 && note < 128) {
            this.#bits.setBit(note, true)
        }
    }
    noteOff(note: int): void {
        if (note >= 0 && note < 128) {
            this.#bits.setBit(note, false)
        }
    }

    reset(): void {}
    clear(): void {this.#bits.clear()}
    terminate(): void {this.#terminator.terminate()}
    toString(): string {return `{${this.constructor.name}}`}
}
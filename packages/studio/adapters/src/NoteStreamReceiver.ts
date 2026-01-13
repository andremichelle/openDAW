import {Bits, byte, Notifier, Observer, Subscription, Terminable, Terminator} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"
import {LiveStreamReceiver} from "@moises-ai/lib-fusion"

export class NoteStreamReceiver implements Terminable {
    readonly #terminator = new Terminator()

    readonly #receiver: LiveStreamReceiver
    readonly #address: Address

    readonly #bits: Bits
    readonly #notifier: Notifier<this>

    constructor(receiver: LiveStreamReceiver, address: Address) {
        this.#receiver = receiver
        this.#address = address

        this.#bits = new Bits(128)
        this.#notifier = new Notifier<this>()
        this.#terminator.own(this.#receiver.subscribeIntegers(this.#address, (array: Int32Array) => {
            if (this.#bits.replace(array.buffer)) {
                this.#notifier.notify(this)
            }
        }))
    }

    isNoteOn(note: byte): boolean {return this.#bits.getBit(note)}
    isAnyNoteOn(): boolean {return this.#bits.nonEmpty()}

    subscribe(observer: Observer<this>): Subscription {return this.#notifier.subscribe(observer)}

    terminate(): void {this.#terminator.terminate()}
}
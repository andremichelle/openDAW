import {Bits, byte, Notifier, Observer, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"

export class NoteStreamReceiver implements Terminable {
    readonly #terminator = new Terminator()
    readonly #bits: Bits
    readonly #notifier: Notifier<this>

    #binding: Terminable = Terminable.Empty

    constructor(receiver: LiveStreamReceiver, address?: Address) {
        this.#bits = new Bits(128)
        this.#notifier = new Notifier<this>()
        if (address !== undefined) {
            this.#binding = this.#subscribe(receiver, address)
        }
    }

    bind(receiver: LiveStreamReceiver, address: Address): Terminable {
        this.#binding.terminate()
        this.#bits.clear()
        this.#binding = this.#subscribe(receiver, address)
        this.#notifier.notify(this)
        return this.#binding
    }

    isNoteOn(note: byte): boolean {return this.#bits.getBit(note)}
    isAnyNoteOn(): boolean {return this.#bits.nonEmpty()}

    subscribe(observer: Observer<this>): Subscription {return this.#notifier.subscribe(observer)}

    terminate(): void {
        this.#binding.terminate()
        this.#terminator.terminate()
    }

    #subscribe(receiver: LiveStreamReceiver, address: Address): Terminable {
        return receiver.subscribeIntegers(address, (array: Int32Array) => {
            if (this.#bits.replace(array.buffer)) {
                this.#notifier.notify(this)
            }
        })
    }
}
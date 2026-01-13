import {Notifier, Observer, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"
import {Event} from "@moises-ai/lib-dsp"
import {TransientMarkerBox} from "@moises-ai/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"

export class TransientMarkerBoxAdapter implements BoxAdapter, Event {
    readonly type = "transient-marker"
    readonly #terminator = new Terminator()

    readonly #box: TransientMarkerBox
    readonly #notifer: Notifier<void>

    constructor(box: TransientMarkerBox) {
        this.#box = box

        this.#notifer = new Notifier()
    }

    get box(): TransientMarkerBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): number {return this.#box.position.getValue()}

    subscribe(observer: Observer<void>): Subscription {return this.#notifer.subscribe(observer)}

    terminate(): void {this.#terminator.terminate()}
}
import {Notifier, Observer, Selectable, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {Address, Propagation} from "@opendaw/lib-box"
import {Event} from "@opendaw/lib-dsp"
import {TransientMarkerBox} from "@opendaw/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"

export class TransientMarkerBoxAdapter implements BoxAdapter, Event, Selectable {
    readonly type = "transient-marker"
    readonly #terminator = new Terminator()

    readonly #box: TransientMarkerBox
    readonly #notifer: Notifier<void>

    #isSelected: boolean = false

    constructor(box: TransientMarkerBox) {
        this.#box = box

        this.#notifer = new Notifier()
        this.#terminator.own(box.subscribe(Propagation.Children, () => this.#onChanged()))
    }

    onSelected(): void {
        this.#isSelected = true
        this.#onChanged()
    }

    onDeselected(): void {
        this.#isSelected = false
        this.#onChanged()
    }

    get box(): TransientMarkerBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): number {return this.#box.position.getValue()}
    get isSelected(): boolean {return this.#isSelected}

    subscribe(observer: Observer<void>): Subscription {return this.#notifer.subscribe(observer)}

    #onChanged(): void {this.#notifer.notify()}

    terminate(): void {this.#terminator.terminate()}
}
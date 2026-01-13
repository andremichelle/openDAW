import {Notifier, Observer, Option, Selectable, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {Address, Propagation} from "@moises-ai/lib-box"
import {Event} from "@moises-ai/lib-dsp"
import {WarpMarkerBox} from "@moises-ai/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"
import {AudioPitchStretchBoxAdapter} from "./AudioPitchStretchBoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {AudioTimeStretchBoxAdapter} from "./AudioTimeStretchBoxAdapter"
import {AudioPlayMode} from "./AudioPlayMode"

export class WarpMarkerBoxAdapter implements BoxAdapter, Event, Selectable {
    readonly type = "warp-marker"

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: WarpMarkerBox
    readonly #notifer: Notifier<void>

    #isSelected: boolean = false

    constructor(context: BoxAdaptersContext, box: WarpMarkerBox) {
        this.#context = context
        this.#box = box

        this.#notifer = new Notifier()
        this.#terminator.own(box.subscribe(Propagation.Children, () => this.#onChanged()))
    }

    onSelected(): void {
        this.#isSelected = true
        this.optWarping.ifSome(warping => warping.onChanged())
        this.#onChanged()
    }

    onDeselected(): void {
        this.#isSelected = false
        this.#onChanged()
    }

    get box(): WarpMarkerBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): number {return this.#box.position.getValue()}
    get seconds(): number {return this.#box.seconds.getValue()}
    get isSelected(): boolean {return this.#isSelected}
    get optWarping(): Option<AudioPitchStretchBoxAdapter | AudioTimeStretchBoxAdapter> {
        return this.#box.owner.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, AudioPlayMode.isAudioPlayMode))
    }

    get isAnchor(): boolean {
        return this.optWarping.mapOr(({warpMarkers}) =>
            this === warpMarkers.optAt(0) || this === warpMarkers.optAt(warpMarkers.length() - 1), false)
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifer.subscribe(observer)}

    terminate(): void {this.#terminator.terminate()}

    #onChanged(): void {
        this.#notifer.notify()
        this.optWarping.ifSome(warping => warping.onChanged())
    }
}
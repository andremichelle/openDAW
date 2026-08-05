import {AudioUnitBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {asDefined, DefaultObservableValue, Option, Terminable} from "@opendaw/lib-std"

export type Construct = {
    audioUnitBoxAdapter: AudioUnitBoxAdapter
    trackBoxAdapter: TrackBoxAdapter
    element: HTMLElement
    lifecycle: Terminable
    unitHead: DefaultObservableValue<boolean>
}

export class TrackContext {
    readonly #audioUnitBoxAdapter: AudioUnitBoxAdapter
    readonly #trackBoxAdapter: TrackBoxAdapter
    readonly #element: HTMLElement
    readonly #lifecycle: Terminable
    readonly #unitHead: DefaultObservableValue<boolean>

    // The header's [device, target] path as currently displayed, kept by TracksManager's path subscription
    // and read by its header dedup pass.
    path: Option<[string, string]> = Option.None

    constructor({audioUnitBoxAdapter, trackBoxAdapter, element, lifecycle, unitHead}: Construct) {
        this.#audioUnitBoxAdapter = audioUnitBoxAdapter
        this.#trackBoxAdapter = trackBoxAdapter
        this.#element = element
        this.#lifecycle = lifecycle
        this.#unitHead = unitHead
    }

    get audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.#audioUnitBoxAdapter}
    get trackBoxAdapter(): TrackBoxAdapter {return this.#trackBoxAdapter}
    get element(): HTMLElement {return this.#element}
    get lifecycle(): Terminable {return this.#lifecycle}
    get unitHead(): DefaultObservableValue<boolean> {return this.#unitHead}
    get size(): number {return this.#element.clientHeight}
    get position(): number {
        return asDefined(this.#element.parentElement, "Track has no parent.").offsetTop + this.#element.offsetTop
    }
}
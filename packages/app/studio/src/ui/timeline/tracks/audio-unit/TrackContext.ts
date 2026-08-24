import {AudioUnitBoxAdapter, ModulatorBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {asDefined, DefaultObservableValue, Option, Terminable} from "@opendaw/lib-std"

/// What a lane hangs off. A modulator owns the lanes of its own parameters, and those rows carry none of a
/// unit's duties (no channel controls, no unit drag, no collapse).
export type TrackOwner =
    { readonly type: "audio-unit", readonly adapter: AudioUnitBoxAdapter }
    | { readonly type: "modulator", readonly adapter: ModulatorBoxAdapter }

export type Construct = {
    owner: TrackOwner
    trackBoxAdapter: TrackBoxAdapter
    element: HTMLElement
    lifecycle: Terminable
    unitHead: DefaultObservableValue<boolean>
}

export class TrackContext {
    readonly #owner: TrackOwner
    readonly #trackBoxAdapter: TrackBoxAdapter
    readonly #element: HTMLElement
    readonly #lifecycle: Terminable
    readonly #unitHead: DefaultObservableValue<boolean>

    // The header's [device, target] path as currently displayed, kept by TracksManager's path subscription
    // and read by its header dedup pass.
    path: Option<[string, string]> = Option.None

    constructor({owner, trackBoxAdapter, element, lifecycle, unitHead}: Construct) {
        this.#owner = owner
        this.#trackBoxAdapter = trackBoxAdapter
        this.#element = element
        this.#lifecycle = lifecycle
        this.#unitHead = unitHead
    }

    get owner(): TrackOwner {return this.#owner}
    get audioUnitBoxAdapter(): Option<AudioUnitBoxAdapter> {
        return this.#owner.type === "audio-unit" ? Option.wrap(this.#owner.adapter) : Option.None
    }
    get trackBoxAdapter(): TrackBoxAdapter {return this.#trackBoxAdapter}
    get element(): HTMLElement {return this.#element}
    get lifecycle(): Terminable {return this.#lifecycle}
    get unitHead(): DefaultObservableValue<boolean> {return this.#unitHead}
    get size(): number {return this.#element.clientHeight}
    get position(): number {
        return asDefined(this.#element.parentElement, "Track has no parent.").offsetTop + this.#element.offsetTop
    }
}

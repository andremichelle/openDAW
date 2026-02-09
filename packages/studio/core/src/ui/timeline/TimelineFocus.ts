import {MutableObservableOption, Terminable, Terminator} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"

export class TimelineFocus implements Terminable {
    readonly #terminator = new Terminator()
    readonly #trackSubscription = this.#terminator.own(new Terminator())
    readonly #regionSubscription = this.#terminator.own(new Terminator())
    readonly #track: MutableObservableOption<TrackBoxAdapter>
    readonly #region: MutableObservableOption<AnyRegionBoxAdapter>

    constructor() {
        this.#track = this.#terminator.own(new MutableObservableOption<TrackBoxAdapter>())
        this.#region = this.#terminator.own(new MutableObservableOption<AnyRegionBoxAdapter>())
    }

    get track(): MutableObservableOption<TrackBoxAdapter> {return this.#track}
    get region(): MutableObservableOption<AnyRegionBoxAdapter> {return this.#region}

    focusTrack(track: TrackBoxAdapter): void {
        this.#trackSubscription.terminate()
        this.#trackSubscription.own(track.box.subscribeDeletion(() => {
            console.debug("TimelineFocus: track deleted")
            this.#trackSubscription.terminate()
            this.#track.clear()
        }))
        this.#track.wrap(track)
        this.clearRegionFocus()
    }

    focusRegion(region: AnyRegionBoxAdapter): void {
        region.trackBoxAdapter.ifSome(track => this.focusTrack(track))
        this.#regionSubscription.terminate()
        this.#regionSubscription.own(region.box.subscribeDeletion(() => {
            console.debug("TimelineFocus: region deleted")
            this.#regionSubscription.terminate()
            this.#region.clear()
        }))
        this.#region.wrap(region)
    }

    clearRegionFocus(): void {
        this.#regionSubscription.terminate()
        this.#region.clear()
    }

    clear(): void {
        this.#trackSubscription.terminate()
        this.#regionSubscription.terminate()
        this.#track.clear()
        this.#region.clear()
    }

    terminate(): void {this.#terminator.terminate()}
}
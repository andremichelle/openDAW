import {MutableObservableOption, Terminable, Terminator} from "@opendaw/lib-std"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"

export class TrackFocus implements Terminable {
    readonly #terminator = new Terminator()
    readonly #trackSubscription = this.#terminator.own(new Terminator())
    readonly #track: MutableObservableOption<TrackBoxAdapter>

    constructor() {
        this.#track = this.#terminator.own(new MutableObservableOption<TrackBoxAdapter>())
    }

    get track(): MutableObservableOption<TrackBoxAdapter> {return this.#track}

    focus(track: TrackBoxAdapter): void {
        this.#trackSubscription.terminate()
        this.#trackSubscription.own(track.box.subscribeDeletion(() => {
            console.debug("TrackFocus: track deleted")
            this.#trackSubscription.terminate()
            this.#track.clear()
        }))
        this.#track.wrap(track)
    }

    clear(): void {
        this.#trackSubscription.terminate()
        this.#track.clear()
    }

    terminate(): void {this.#terminator.terminate()}
}
import {Comparator, int, Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, Propagation, Update} from "@opendaw/lib-box"
import {Event, Harmony} from "@opendaw/lib-dsp"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ChordTrackAdapter} from "./ChordTrackAdapter"
import {TimelineBoxAdapter} from "./TimelineBoxAdapter"

export class ChordEventBoxAdapter implements BoxAdapter, Event {
    static readonly Comparator: Comparator<ChordEventBoxAdapter> = (a, b) => a.position - b.position

    readonly type = "chord-event"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: ChordEventBox

    constructor(context: BoxAdaptersContext, box: ChordEventBox) {
        this.#context = context
        this.#box = box
        this.#terminator.own(this.#box.subscribe(Propagation.Children, (update: Update) => {
            if (this.trackAdapter.isEmpty()) {return}
            if (update.type === "primitive" || update.type === "pointer") {
                const track = this.trackAdapter.unwrap()
                if (this.#box.position.address.equals(update.address)) {
                    track.onSortingChanged()
                } else {
                    track.dispatchChange()
                }
            }
        }))
    }

    get box(): ChordEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): int {return this.#box.position.getValue()}
    get duration(): int {return this.#box.duration.getValue()}
    get complete(): int {return this.position + this.duration}
    get degree(): int {return this.#box.degree.getValue()}
    get shift(): int {return this.#box.shift.getValue()}
    get shape(): int {return this.#box.shape.getValue()}
    get notes(): int {return this.#box.notes.getValue()}
    get inversion(): int {return this.#box.inversion.getValue()}
    get trackAdapter(): Option<ChordTrackAdapter> {
        return this.#box.track.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TimelineBoxAdapter).chordTrack)
    }

    resolve(key: Harmony.Key): Option<Harmony.Chord> {
        return Harmony.chord(key, this.degree, this.shift, this.shape, this.notes, this.inversion)
    }

    terminate() {this.#terminator.terminate()}
    toString(): string {return `{ChordEventBoxAdapter ${UUID.toString(this.#box.address.uuid).substring(0, 4)}, degree: ${this.degree}}`}
}

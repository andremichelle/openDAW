import {Comparator, int, Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, Propagation, Update} from "@opendaw/lib-box"
import {Event, Harmony} from "@opendaw/lib-dsp"
import {KeyEventBox} from "@opendaw/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {KeyTrackAdapter} from "./KeyTrackAdapter"
import {TimelineBoxAdapter} from "./TimelineBoxAdapter"

export class KeyEventBoxAdapter implements BoxAdapter, Event {
    static readonly Comparator: Comparator<KeyEventBoxAdapter> = (a, b) => a.position - b.position

    readonly type = "key-event"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: KeyEventBox

    constructor(context: BoxAdaptersContext, box: KeyEventBox) {
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

    get box(): KeyEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): int {return this.#box.position.getValue()}
    get root(): int {return this.#box.root.getValue()}
    get bits(): int {return this.#box.scale.getValue()}
    get key(): Harmony.Key {return {root: this.root, bits: this.bits}}
    get trackAdapter(): Option<KeyTrackAdapter> {
        return this.#box.track.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TimelineBoxAdapter).keyTrack)
    }

    terminate() {this.#terminator.terminate()}
    toString(): string {return `{KeyEventBoxAdapter ${UUID.toString(this.#box.address.uuid).substring(0, 4)}, ${Harmony.keyName(this.key)}}`}
}

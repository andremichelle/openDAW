import {Comparator, int, Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, Propagation, Update} from "@opendaw/lib-box"
import {SignatureEventBox} from "@opendaw/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {SignatureTrackAdapter} from "./SignatureTrackAdapter"
import {TimelineBoxAdapter} from "./TimelineBoxAdapter"

export class SignatureEventBoxAdapter implements BoxAdapter {
    static readonly Comparator: Comparator<SignatureEventBoxAdapter> = (a, b) => a.index - b.index

    readonly type = "signature-event"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: SignatureEventBox

    constructor(context: BoxAdaptersContext, box: SignatureEventBox) {
        this.#context = context
        this.#box = box

        this.#terminator.own(this.#box.subscribe(Propagation.Children, (update: Update) => {
            if (this.trackAdapter.isEmpty()) {return}
            if (update.type === "primitive" || update.type === "pointer") {
                const track = this.trackAdapter.unwrap()
                if (this.#box.index.address.equals(update.address)) {
                    track.onSortingChanged()
                } else {
                    track.dispatchChange()
                }
            }
        }))
    }

    get box(): SignatureEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get index(): int {return this.#box.index.getValue()}
    get relativePosition(): int {return this.#box.relativePosition.getValue()}
    get nominator(): int {return this.#box.nominator.getValue()}
    get denominator(): int {return this.#box.denominator.getValue()}
    get trackAdapter(): Option<SignatureTrackAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TimelineBoxAdapter).signatureTrack)
    }

    terminate() {this.#terminator.terminate()}
    toString(): string {return `{SignatureEventBoxAdapter ${UUID.toString(this.#box.address.uuid).substring(0, 4)}, ${this.nominator}/${this.denominator}}`}
}

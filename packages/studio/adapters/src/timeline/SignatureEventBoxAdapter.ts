import {Comparator, int, Option, Terminator, UUID} from "@moises-ai/lib-std"
import {Address, Int32Field, Propagation, Update} from "@moises-ai/lib-box"
import {SignatureEventBox} from "@moises-ai/studio-boxes"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {SignatureTrackAdapter} from "./SignatureTrackAdapter"
import {TimelineBoxAdapter} from "./TimelineBoxAdapter"
import {IndexedBoxAdapter} from "../IndexedBoxAdapterCollection"

export class SignatureEventBoxAdapter implements IndexedBoxAdapter {
    static readonly Comparator: Comparator<SignatureEventBoxAdapter> = (a, b) => a.index - b.index

    readonly type = "signature-event"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: SignatureEventBox

    constructor(context: BoxAdaptersContext, box: SignatureEventBox) {
        this.#context = context
        this.#box = box

        this.#terminator.own(this.#box.subscribe(Propagation.Children, (_update: Update) =>
            this.trackAdapter.ifSome(adapter => adapter.dispatchChange())))
    }

    get box(): SignatureEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get index(): int {return this.#box.index.getValue()}
    get indexField(): Int32Field {return this.#box.index}
    get relativePosition(): int {return this.#box.relativePosition.getValue()}
    get nominator(): int {return this.#box.nominator.getValue()}
    get denominator(): int {return this.#box.denominator.getValue()}
    get trackAdapter(): Option<SignatureTrackAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TimelineBoxAdapter).signatureTrack)
    }

    terminate() {this.#terminator.terminate()}
    toString(): string {return `{SignatureEventBoxAdapter ${this.nominator}/${this.denominator}}`}
}

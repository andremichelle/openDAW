import {Address, Int32Field, PointerField, Propagation, StringField} from "@opendaw/lib-box"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {GrooveOffsetBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {clamp, int, Notifier, Observer, Option, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {GrooveAdapter, GrooveKind} from "./GrooveBoxAdapter"

// Moves every position by a fixed number of ticks, earlier when negative
export class GrooveOffsetBoxAdapter implements GrooveAdapter {
    static readonly Limit: int = PPQN.fromSignature(1, 8)

    readonly type = "groove-adapter"

    readonly #terminator: Terminator = new Terminator()
    readonly #box: GrooveOffsetBox
    readonly #notifier: Notifier<GrooveAdapter>

    constructor(_context: BoxAdaptersContext, box: GrooveOffsetBox) {
        this.#box = box
        this.#notifier = this.#terminator.own(new Notifier<GrooveAdapter>())
        this.#terminator.own(box.subscribe(Propagation.Children, () => this.#notifier.notify(this)))
    }

    get kind(): GrooveKind {return "offset"}
    get box(): GrooveOffsetBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get labelField(): StringField {return this.#box.label}
    get indexField(): Int32Field {return this.#box.index}
    get offsetField(): Int32Field {return this.#box.offset}
    get amount(): Option<AutomatableParameterFieldAdapter<number>> {return Option.None}
    get duration(): Option<AutomatableParameterFieldAdapter<int>> {return Option.None}

    cellDuration(): ppqn {return 0}

    get ticks(): int {return clamp(this.#box.offset.getValue(), -GrooveOffsetBoxAdapter.Limit, GrooveOffsetBoxAdapter.Limit)}

    warp(position: ppqn): ppqn {return position + this.ticks}

    unwarp(position: ppqn): ppqn {return position - this.ticks}

    subscribeChange(observer: Observer<GrooveAdapter>): Subscription {return this.#notifier.subscribe(observer)}

    users(): ReadonlyArray<PointerField<Pointers.Groove>> {
        return this.#box.pointerHub.filter(Pointers.Groove) as ReadonlyArray<PointerField<Pointers.Groove>>
    }

    terminate(): void {this.#terminator.terminate()}
}

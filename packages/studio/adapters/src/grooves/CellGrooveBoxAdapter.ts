import {Address, Int32Field, PointerField, Propagation, StringField} from "@opendaw/lib-box"
import {GrooveFunction, GroovePattern, ppqn} from "@opendaw/lib-dsp"
import {GrooveFunctionBox, GrooveRandomBox, GrooveShuffleBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {
    int,
    Notifier,
    Nullable,
    Observer,
    Option,
    StringMapping,
    Subscription,
    Terminator,
    UUID,
    ValueMapping
} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {GrooveAdapter, GrooveKind} from "./GrooveBoxAdapter"
import {GrooveDurations} from "./GrooveDurations"

type CellGrooveBox = GrooveShuffleBox | GrooveFunctionBox | GrooveRandomBox

// A groove that bends every cell of its duration with one function
export abstract class CellGrooveBoxAdapter<BOX extends CellGrooveBox> implements GrooveAdapter {
    readonly type = "groove-adapter"

    protected readonly terminator: Terminator = new Terminator()
    protected readonly context: BoxAdaptersContext
    protected readonly parametric: ParameterAdapterSet

    readonly #box: BOX
    readonly #pattern: GroovePattern
    readonly #notifier: Notifier<GrooveAdapter>
    readonly #amount: AutomatableParameterFieldAdapter<number>
    readonly #duration: AutomatableParameterFieldAdapter<int>

    #function: Nullable<GrooveFunction> = null

    protected constructor(context: BoxAdaptersContext, box: BOX) {
        this.context = context
        this.#box = box
        this.parametric = this.terminator.own(new ParameterAdapterSet(context))
        this.#notifier = this.terminator.own(new Notifier<GrooveAdapter>())
        this.#amount = this.parametric.createParameter(box.amount,
            ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Amount", 0.5)
        this.#duration = this.parametric.createParameter(box.duration,
            ValueMapping.values(GrooveDurations.PPQNs),
            StringMapping.values("", GrooveDurations.PPQNs, GrooveDurations.Labels), "Duration")
        this.#pattern = new GroovePattern({
            duration: (): ppqn => this.#box.duration.getValue(),
            fx: x => this.#cellFunction().fx(x),
            fy: y => this.#cellFunction().fy(y)
        })
        this.terminator.own(box.subscribe(Propagation.Children, () => {
            this.#function = null
            this.#notifier.notify(this)
        }))
    }

    abstract get kind(): GrooveKind

    protected abstract createFunction(): GrooveFunction

    get box(): BOX {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get labelField(): StringField {return this.#box.label}
    get indexField(): Int32Field {return this.#box.index}
    get amount(): Option<AutomatableParameterFieldAdapter<number>> {return Option.wrap(this.#amount)}
    get duration(): Option<AutomatableParameterFieldAdapter<int>> {return Option.wrap(this.#duration)}
    get amountParameter(): AutomatableParameterFieldAdapter<number> {return this.#amount}
    get durationParameter(): AutomatableParameterFieldAdapter<int> {return this.#duration}

    cellDuration(): ppqn {return this.#box.duration.getValue()}

    warp(position: ppqn): ppqn {return this.#pattern.warp(position)}
    unwarp(position: ppqn): ppqn {return this.#pattern.unwarp(position)}

    subscribeChange(observer: Observer<GrooveAdapter>): Subscription {return this.#notifier.subscribe(observer)}

    users(): ReadonlyArray<PointerField<Pointers.Groove>> {
        return this.#box.pointerHub.filter(Pointers.Groove) as ReadonlyArray<PointerField<Pointers.Groove>>
    }

    terminate(): void {this.terminator.terminate()}

    #cellFunction(): GrooveFunction {
        if (this.#function === null) {this.#function = this.createFunction()}
        return this.#function
    }
}

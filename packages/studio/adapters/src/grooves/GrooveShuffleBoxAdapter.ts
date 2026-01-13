import {Address} from "@moises-ai/lib-box"
import {GrooveShuffleBox} from "@moises-ai/studio-boxes"
import {int, moebiusEase, squashUnit, StringMapping, Terminator, UUID, ValueMapping} from "@moises-ai/lib-std"
import {GroovePattern, GroovePatternFunction, ppqn, PPQN} from "@moises-ai/lib-dsp"
import {GrooveAdapter} from "./GrooveBoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"

export class GrooveShuffleBoxAdapter implements GrooveAdapter {
    static readonly Durations: ReadonlyArray<[int, int]> = [
        [1, 8], [1, 4], [1, 4], [1, 2], [1, 1], [2, 1], [4, 1], [8, 1], [16, 1]
    ]

    static readonly DurationPPQNs: ReadonlyArray<int> =
        GrooveShuffleBoxAdapter.Durations.map(([n, d]) => PPQN.fromSignature(n, d))
    static readonly DurationStrings: ReadonlyArray<string> =
        GrooveShuffleBoxAdapter.Durations.map(([n, d]) => (`${n}/${d}`))

    readonly type = "groove-adapter"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: GrooveShuffleBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    readonly #groove: GroovePattern = new GroovePattern({
        duration: (): ppqn => this.#duration,
        fx: x => moebiusEase(x, this.#amount),
        fy: y => moebiusEase(y, 1.0 - this.#amount)
    } satisfies GroovePatternFunction)

    #amount: number = 0.0
    #duration: ppqn = PPQN.SemiQuaver * 2

    constructor(context: BoxAdaptersContext, box: GrooveShuffleBox) {
        this.#context = context
        this.#box = box

        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = this.#wrapParameters(box)
        this.#terminator.ownAll(
            this.namedParameter.duration.catchupAndSubscribe(owner => this.#duration = owner.getValue()),
            this.namedParameter.amount.catchupAndSubscribe(owner => this.#amount = squashUnit(owner.getValue(), 0.01))
        )
    }

    unwarp(position: ppqn): ppqn {return this.#groove.unwarp(position)}
    warp(position: ppqn): ppqn {return this.#groove.warp(position)}

    get box(): GrooveShuffleBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}

    terminate(): void {this.#terminator.terminate()}

    #wrapParameters(box: GrooveShuffleBox) {
        return {
            duration: this.#parametric.createParameter(
                box.duration,
                ValueMapping.values(GrooveShuffleBoxAdapter.DurationPPQNs),
                StringMapping.values("", GrooveShuffleBoxAdapter.DurationPPQNs, GrooveShuffleBoxAdapter.DurationStrings),
                "duration"),
            amount: this.#parametric.createParameter(
                box.amount,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 0}), "amount")
        } as const
    }
}
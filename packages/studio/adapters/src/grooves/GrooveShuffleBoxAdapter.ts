import {GrooveShuffleBox} from "@opendaw/studio-boxes"
import {int, moebiusEase, squashUnit} from "@opendaw/lib-std"
import {GrooveFunction} from "@opendaw/lib-dsp"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {GrooveKind} from "./GrooveBoxAdapter"
import {GrooveDurations} from "./GrooveDurations"
import {CellGrooveBoxAdapter} from "./CellGrooveBoxAdapter"

export class GrooveShuffleBoxAdapter extends CellGrooveBoxAdapter<GrooveShuffleBox> {
    static readonly Durations: ReadonlyArray<[int, int]> = GrooveDurations.Signatures
    static readonly DurationPPQNs: ReadonlyArray<int> = GrooveDurations.PPQNs
    static readonly DurationStrings: ReadonlyArray<string> = GrooveDurations.Labels

    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: GrooveShuffleBox) {
        super(context, box)
        this.namedParameter = {amount: this.amountParameter, duration: this.durationParameter} as const
    }

    get kind(): GrooveKind {return "shuffle"}

    protected createFunction(): GrooveFunction {
        const amount = squashUnit(this.box.amount.getValue(), 0.01)
        return {fx: x => moebiusEase(x, amount), fy: y => moebiusEase(y, 1.0 - amount)}
    }
}

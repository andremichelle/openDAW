import {LfoModulatorBox} from "@opendaw/studio-boxes"
import {int, StringMapping, ValueMapping} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ModulatorBoxAdapter} from "./ModulatorBoxAdapter"

export enum LfoShape {Sine, Triangle, SawUp, SawDown, Square}

// WASM CONTRACT: `RatePPQNs` mirrors the engine's `modulation::RATES` (crates/engine/src/modulation.rs).
export class LfoModulatorBoxAdapter extends ModulatorBoxAdapter<LfoModulatorBox> {
    static readonly Rates: ReadonlyArray<[int, int]> = [
        [8, 1], [4, 1], [2, 1], [1, 1], [1, 2], [1, 4], [1, 6], [1, 8], [1, 12], [1, 16], [1, 24], [1, 32]
    ]
    static readonly MaxAbsoluteRate = 10.0
    static readonly ExponentRange = 8.0
    static readonly CenterAbsoluteRate = 1.0
    static readonly RatePPQNs: ReadonlyArray<ppqn> = [0, ...LfoModulatorBoxAdapter.Rates
        .map(([nominator, denominator]) => PPQN.fromSignature(nominator, denominator))]
    static readonly RateStrings: ReadonlyArray<string> = ["Off", ...LfoModulatorBoxAdapter.Rates
        .map(([nominator, denominator]) => denominator === 1
            ? (nominator === 1 ? "1 bar" : `${nominator} bars`)
            : `${nominator}/${denominator}`)]
    static readonly ShapeStrings: ReadonlyArray<string> = ["Sine", "Triangle", "Saw ↑", "Saw ↓", "Square"]

    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: LfoModulatorBox) {
        super(context, box)
        this.namedParameter = this.#wrapParameters(box)
        this.registerParameterTracks()
    }

    #wrapParameters(box: LfoModulatorBox) {
        return {
            shape: this.parametric.createParameter(box.shape,
                ValueMapping.linearInteger(0, LfoModulatorBoxAdapter.ShapeStrings.length - 1),
                StringMapping.indices("", LfoModulatorBoxAdapter.ShapeStrings), "Shape"),
            rateSync: this.parametric.createParameter(box.rateSync,
                ValueMapping.linearInteger(0, LfoModulatorBoxAdapter.RateStrings.length - 1),
                StringMapping.indices("", LfoModulatorBoxAdapter.RateStrings), "Sync"),
            rateAbsolute: this.parametric.createParameter(box.rateAbsolute,
                ValueMapping.powerByCenter(LfoModulatorBoxAdapter.CenterAbsoluteRate,
                    0.0, LfoModulatorBoxAdapter.MaxAbsoluteRate),
                StringMapping.numeric({unit: "Hz", fractionDigits: 2}), "Free"),
            phase: this.parametric.createParameter(box.phase,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Phase"),
            amount: this.parametric.createParameter(box.amount,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Amount"),
            exponent: this.parametric.createParameter(box.exponent,
                ValueMapping.bipolar(), StringMapping.percent({fractionDigits: 0}), "Pow")
        } as const
    }
}

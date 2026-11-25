import {GrooveRandomBox} from "@opendaw/studio-boxes"
import {int, StringMapping, unitValue, ValueMapping} from "@opendaw/lib-std"
import {GrooveCurves, GrooveFunction, QuantisedGrooveFunction} from "@opendaw/lib-dsp"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {GrooveKind} from "./GrooveBoxAdapter"
import {CellGrooveBoxAdapter} from "./CellGrooveBoxAdapter"

export class GrooveRandomBoxAdapter extends CellGrooveBoxAdapter<GrooveRandomBox> {
    static readonly MaxSeed = 999999

    readonly roughness: AutomatableParameterFieldAdapter<unitValue>
    readonly steps: AutomatableParameterFieldAdapter<int>

    constructor(context: BoxAdaptersContext, box: GrooveRandomBox) {
        super(context, box)
        this.roughness = this.parametric.createParameter(box.roughness,
            ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Roughness")
        this.steps = this.parametric.createParameter(box.steps,
            ValueMapping.linearInteger(2, 64), StringMapping.numeric({fractionDigits: 0}), "Steps")
    }

    get kind(): GrooveKind {return "random"}

    reseed(): void {this.box.seed.setValue(1 + Math.floor(Math.random() * GrooveRandomBoxAdapter.MaxSeed))}

    protected createFunction(): GrooveFunction {
        const {seed, steps, roughness, amount} = this.box
        const values = GrooveCurves.randomValues(seed.getValue(), steps.getValue(), roughness.getValue())
        return GrooveCurves.blend(new QuantisedGrooveFunction(values), amount.getValue())
    }
}

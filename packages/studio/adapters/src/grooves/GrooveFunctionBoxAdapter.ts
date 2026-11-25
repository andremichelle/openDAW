import {GrooveFunctionBox} from "@opendaw/studio-boxes"
import {GrooveCurves, GrooveFunction} from "@opendaw/lib-dsp"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {GrooveKind} from "./GrooveBoxAdapter"
import {CellGrooveBoxAdapter} from "./CellGrooveBoxAdapter"

export enum GrooveFunctionType {Power = 0, SCurve = 1}

export class GrooveFunctionBoxAdapter extends CellGrooveBoxAdapter<GrooveFunctionBox> {
    constructor(context: BoxAdaptersContext, box: GrooveFunctionBox) {super(context, box)}

    get kind(): GrooveKind {return this.box.function.getValue() === GrooveFunctionType.SCurve ? "s-curve" : "power"}

    protected createFunction(): GrooveFunction {
        const curve = this.box.function.getValue() === GrooveFunctionType.SCurve ? GrooveCurves.SCurve : GrooveCurves.Power
        return GrooveCurves.blend(curve, this.box.amount.getValue())
    }
}

import {Float32Field} from "@opendaw/lib-box"
import {StepsModulatorBox} from "@opendaw/studio-boxes"
import {int, StringMapping, unitValue, ValueMapping} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {LfoModulatorBoxAdapter} from "./LfoModulatorBoxAdapter"
import {ModulatorBoxAdapter} from "./ModulatorBoxAdapter"

// WASM CONTRACT: mirrors the engine's `modulation::DIRECTION_*` (crates/engine/src/modulation.rs).
export enum StepsDirection {Forward, Backward, PingPong, Alternate, Random}

export class StepsModulatorBoxAdapter extends ModulatorBoxAdapter<StepsModulatorBox> {
    static readonly MaxSteps = 64
    static readonly DirectionStrings: ReadonlyArray<string> = ["Forward", "Backward", "Ping-Pong", "Alternate", "Random"]

    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: StepsModulatorBox) {
        super(context, box)
        this.namedParameter = this.#wrapParameters(box)
    }

    get count(): int {return this.box.count.getValue()}
    get steps(): ReadonlyArray<Float32Field> {return this.box.steps.fields()}

    /// The drawn pattern at `step`, a continuous index into the sequence: the step under it, glided towards
    /// its NEIGHBOUR over the first `smooth` of its length. This is the picture, in step order, so the curve
    /// always agrees with the bars. What the engine plays walks that picture through the direction, which is
    /// why the playhead comes from the engine rather than being derived here.
    patternAt(step: number): unitValue {
        const count = Math.max(1, Math.min(this.count, StepsModulatorBoxAdapter.MaxSteps))
        const index = Math.floor(step)
        const current = this.steps[((index % count) + count) % count].getValue()
        const smooth = this.box.smooth.getValue()
        if (smooth <= 0.0) {return current}
        const previous = this.steps[(((index - 1) % count) + count) % count].getValue()
        const ramp = Math.min(1.0, (step - index) / smooth)
        return previous + (current - previous) * ramp * ramp * (3.0 - 2.0 * ramp)
    }

    /// Every mutation below runs inside an `editing.modify` and touches only the ACTIVE steps, so shortening
    /// the sequence and growing it again brings the old tail back.
    clear(): void {this.#activeSteps().forEach(step => step.setValue(0.0))}

    randomize(): void {this.#activeSteps().forEach(step => step.setValue(Math.random() * 2.0 - 1.0))}

    rotate(offset: int): void {
        const active = this.#activeSteps()
        const values = active.map(step => step.getValue())
        const count = values.length
        active.forEach((step, index) =>
            step.setValue(values[(((index - offset) % count) + count) % count]))
    }

    #activeSteps(): ReadonlyArray<Float32Field> {
        return this.steps.slice(0, Math.max(1, Math.min(this.count, StepsModulatorBoxAdapter.MaxSteps)))
    }

    #wrapParameters(box: StepsModulatorBox) {
        return {
            count: this.parametric.createParameter(box.count,
                ValueMapping.linearInteger(1, StepsModulatorBoxAdapter.MaxSteps),
                StringMapping.numeric({unit: ""}), "Steps"),
            rateSync: this.parametric.createParameter(box.rateSync,
                ValueMapping.linearInteger(0, LfoModulatorBoxAdapter.Rates.length - 1),
                StringMapping.indices("", LfoModulatorBoxAdapter.RateStrings), "Rate"),
            rateAbsolute: this.parametric.createParameter(box.rateAbsolute,
                ValueMapping.powerByCenter(LfoModulatorBoxAdapter.CenterAbsoluteRate,
                    0.0, LfoModulatorBoxAdapter.MaxAbsoluteRate),
                StringMapping.numeric({unit: "Hz", fractionDigits: 2}), "Free"),
            phase: this.parametric.createParameter(box.phase,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Phase"),
            amount: this.parametric.createParameter(box.amount,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Amount"),
            smooth: this.parametric.createParameter(box.smooth,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Smooth"),
            direction: this.parametric.createParameter(box.direction,
                ValueMapping.linearInteger(0, StepsModulatorBoxAdapter.DirectionStrings.length - 1),
                StringMapping.indices("", StepsModulatorBoxAdapter.DirectionStrings), "Mode")
        } as const
    }
}

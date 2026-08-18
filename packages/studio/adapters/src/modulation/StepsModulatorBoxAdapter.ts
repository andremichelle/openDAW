import {Float32Field} from "@opendaw/lib-box"
import {StepsModulatorBox} from "@opendaw/studio-boxes"
import {int, StringMapping, unitValue, ValueMapping} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {LfoModulatorBoxAdapter} from "./LfoModulatorBoxAdapter"
import {ModulatorBoxAdapter} from "./ModulatorBoxAdapter"

// WASM CONTRACT: mirrors the engine's `modulation::DIRECTION_*` (crates/engine/src/modulation.rs).
export enum StepsDirection {Forward, Backward, PingPong, Alternate, Random}

export type StepsPass = {ascending: boolean, from: int, to: int}

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

    /// The passes the sequence makes over the pattern, each covering the steps `[from, to)` it reaches.
    get passes(): ReadonlyArray<StepsPass> {
        const count = Math.max(1, Math.min(this.count, StepsModulatorBoxAdapter.MaxSteps))
        switch (this.box.direction.getValue() as StepsDirection) {
            case StepsDirection.Backward:
                return [{ascending: false, from: 0, to: count}]
            case StepsDirection.PingPong:
                return [{ascending: true, from: 0, to: count}, {ascending: false, from: 0, to: count}]
            case StepsDirection.Alternate:
                return count < 3
                    ? [{ascending: true, from: 0, to: count}]
                    : [{ascending: true, from: 0, to: count - 1}, {ascending: false, from: 1, to: count}]
            default:
                return [{ascending: true, from: 0, to: count}]
        }
    }

    patternAt(step: number, ascending: boolean): unitValue {
        const count = Math.max(1, Math.min(this.count, StepsModulatorBoxAdapter.MaxSteps))
        const index = ((Math.floor(step) % count) + count) % count
        const current = this.steps[index].getValue()
        const smooth = this.box.smooth.getValue()
        if (smooth <= 0.0) {return current}
        const local = step - Math.floor(step)
        const traversed = ascending ? local : 1.0 - local
        const previous = this.steps[this.#predecessor(index, count, ascending)].getValue()
        const ramp = Math.min(1.0, traversed / smooth)
        return previous + (current - previous) * ramp * ramp * (3.0 - 2.0 * ramp)
    }

    #predecessor(index: int, count: int, ascending: boolean): int {
        const wrap = (value: int) => ((value % count) + count) % count
        switch (this.box.direction.getValue() as StepsDirection) {
            case StepsDirection.PingPong:
                return ascending
                    ? (index === 0 ? 0 : index - 1)
                    : (index === count - 1 ? count - 1 : index + 1)
            case StepsDirection.Alternate:
                return ascending
                    ? (index === 0 ? Math.min(1, count - 1) : index - 1)
                    : (index === count - 1 ? Math.max(0, count - 2) : index + 1)
            default:
                return ascending ? wrap(index - 1) : wrap(index + 1)
        }
    }

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
                StringMapping.indices("", LfoModulatorBoxAdapter.RateStrings), "Sync"),
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

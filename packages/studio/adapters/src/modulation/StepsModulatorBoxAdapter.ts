import {Float32Field} from "@opendaw/lib-box"
import {StepsModulatorBox} from "@opendaw/studio-boxes"
import {int, StringMapping, unitValue, ValueMapping} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {LfoModulatorBoxAdapter} from "./LfoModulatorBoxAdapter"
import {ModulatorBoxAdapter} from "./ModulatorBoxAdapter"

// WASM CONTRACT: mirrors the engine's `modulation::DIRECTION_*` (crates/engine/src/modulation.rs).
export enum StepsDirection {Forward, Backward, PingPong, Random}

export class StepsModulatorBoxAdapter extends ModulatorBoxAdapter<StepsModulatorBox> {
    static readonly MaxSteps = 64
    static readonly DirectionStrings: ReadonlyArray<string> = ["Forward", "Backward", "Ping-Pong", "Random"]

    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: StepsModulatorBox) {
        super(context, box)
        this.namedParameter = this.#wrapParameters(box)
    }

    get count(): int {return this.box.count.getValue()}
    get steps(): ReadonlyArray<Float32Field> {return this.box.steps.fields()}

    /// The value the engine reads at `step`, a continuous index into the sequence: the step under it, folded
    /// through the direction, then glided towards its predecessor over the first `smooth` of its length.
    /// WASM CONTRACT: mirrors `StepsState::value_at` (crates/engine/src/modulation.rs).
    valueAt(step: number): unitValue {
        const count = Math.max(1, Math.min(this.count, StepsModulatorBoxAdapter.MaxSteps))
        const index = Math.floor(step)
        const previous = this.#stepAt(index - 1, count)
        const current = this.#stepAt(index, count)
        const smooth = this.box.smooth.getValue()
        if (smooth <= 0.0) {return current}
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

    #stepAt(index: int, count: int): unitValue {
        const cycle = Math.floor(index / count)
        const local = index - cycle * count
        const direction: StepsDirection = this.box.direction.getValue()
        const resolved = direction === StepsDirection.Backward ? count - 1 - local
            : direction === StepsDirection.PingPong ? (cycle % 2 === 0 ? local : count - 1 - local)
                : direction === StepsDirection.Random ? StepsModulatorBoxAdapter.randomIndex(cycle, local, count)
                    : local
        return this.steps[resolved].getValue()
    }

    /// A stable shuffle: the same (cycle, step) always lands on the same index, so the sequence stays a pure
    /// function of the position and a locate replays it identically.
    /// WASM CONTRACT: mirrors `random_index` (crates/engine/src/modulation.rs).
    static randomIndex(cycle: int, step: int, count: int): int {
        let hash = Math.imul(cycle, 0x9E3779B1) ^ Math.imul(step + 1, 0x85EBCA77)
        hash = Math.imul(hash ^ (hash >>> 15), 0x2545F491)
        hash = (hash ^ (hash >>> 13)) >>> 0
        return hash % count
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

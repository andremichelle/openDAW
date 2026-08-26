import {RandomModulatorBox} from "@opendaw/studio-boxes"
import {int, StringMapping, unitValue, ValueMapping} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {LfoModulatorBoxAdapter} from "./LfoModulatorBoxAdapter"
import {ModulatorBoxAdapter} from "./ModulatorBoxAdapter"

// WASM CONTRACT: `draw` and `quantize` mirror the engine's `modulation::hash_bipolar` / `quantize`.
export class RandomModulatorBoxAdapter extends ModulatorBoxAdapter<RandomModulatorBox> {
    static readonly MaxLoop = 64
    static readonly MaxLevels = 32
    static readonly MaxSeed = 999999

    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: RandomModulatorBox) {
        super(context, box)
        this.namedParameter = this.#wrapParameters(box)
        this.registerParameterTracks()
    }

    get loop(): int {return this.box.loop.getValue()}

    draw(index: int): unitValue {
        const seed = this.box.seed.getValue()
        const local = this.#localIndex(index)
        let hash = Math.imul(seed, 0x9E3779B1) ^ Math.imul(local, 0x85EBCA77)
        hash = Math.imul(hash ^ (hash >>> 15), 0x2545F491)
        hash ^= hash >>> 13
        return this.#quantize((hash >>> 0) / 4294967295.0 * 2.0 - 1.0)
    }

    valueAt(step: number): unitValue {
        const index = Math.floor(step)
        const current = this.draw(index)
        const smooth = this.box.smooth.getValue()
        if (smooth <= 0.0) {return current}
        const previous = this.draw(index - 1)
        const ramp = Math.min(1.0, (step - index) / smooth)
        return previous + (current - previous) * ramp * ramp * (3.0 - 2.0 * ramp)
    }

    reseed(): void {this.box.seed.setValue(Math.floor(Math.random() * RandomModulatorBoxAdapter.MaxSeed))}

    #localIndex(index: int): int {
        const length = this.loop
        return length > 0 ? ((index % length) + length) % length : index | 0
    }

    #quantize(value: unitValue): unitValue {
        const levels = this.box.levels.getValue()
        if (levels < 2) {return value}
        const steps = levels - 1
        return Math.min(steps, Math.max(0, Math.floor((value + 1.0) * 0.5 * steps + 0.5))) / steps * 2.0 - 1.0
    }

    #wrapParameters(box: RandomModulatorBox) {
        return {
            rateSync: this.parametric.createParameter(box.rateSync,
                ValueMapping.linearInteger(0, LfoModulatorBoxAdapter.RateStrings.length - 1),
                StringMapping.indices("", LfoModulatorBoxAdapter.RateStrings), "Sync"),
            rateAbsolute: this.parametric.createParameter(box.rateAbsolute,
                ValueMapping.powerByCenter(LfoModulatorBoxAdapter.CenterAbsoluteRate,
                    0.0, LfoModulatorBoxAdapter.MaxAbsoluteRate),
                StringMapping.numeric({unit: "Hz", fractionDigits: 2}), "Free"),
            phase: this.parametric.createParameter(box.phase,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Phase"),
            smooth: this.parametric.createParameter(box.smooth,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Smooth")
        } as const
    }
}

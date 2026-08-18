import {Address, Int32Field} from "@opendaw/lib-box"
import {LfoModulatorBox, ModulationBox} from "@opendaw/studio-boxes"
import {asInstanceOf, int, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {ModulationBoxAdapter} from "./ModulationBoxAdapter"

export enum LfoShape {Sine, Triangle, SawUp, SawDown, Square}

// WASM CONTRACT: `Rates` mirrors the engine's `modulation::RATES` (crates/engine/src/modulation.rs).
export class LfoModulatorBoxAdapter implements BoxAdapter {
    static readonly Rates: ReadonlyArray<[int, int]> = [
        [8, 1], [4, 1], [2, 1], [1, 1], [1, 2], [1, 4], [1, 6], [1, 8], [1, 12], [1, 16], [1, 24], [1, 32]
    ]
    static readonly MaxAbsoluteRate = 10.0
    static readonly CenterAbsoluteRate = 1.0
    static readonly RatePPQNs: ReadonlyArray<ppqn> = LfoModulatorBoxAdapter.Rates
        .map(([nominator, denominator]) => PPQN.fromSignature(nominator, denominator))
    static readonly RateStrings: ReadonlyArray<string> = LfoModulatorBoxAdapter.Rates
        .map(([nominator, denominator]) => denominator === 1
            ? (nominator === 1 ? "1 bar" : `${nominator} bars`)
            : `${nominator}/${denominator}`)
    static readonly ShapeStrings: ReadonlyArray<string> = ["Sine", "Triangle", "Saw ↑", "Saw ↓", "Square"]

    readonly #terminator: Terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #box: LfoModulatorBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: LfoModulatorBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): LfoModulatorBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get enabled(): boolean {return this.#box.enabled.getValue()}
    get indexField(): Int32Field {return this.#box.index}

    get assignments(): ReadonlyArray<ModulationBoxAdapter> {
        return this.#box.assignments.pointerHub.incoming()
            .map(({box}) => this.#context.boxAdapters.adapterFor(asInstanceOf(box, ModulationBox), ModulationBoxAdapter))
    }

    terminate(): void {this.#terminator.terminate()}

    #wrapParameters(box: LfoModulatorBox) {
        return {
            shape: this.#parametric.createParameter(box.shape,
                ValueMapping.linearInteger(0, LfoModulatorBoxAdapter.ShapeStrings.length - 1),
                StringMapping.indices("", LfoModulatorBoxAdapter.ShapeStrings), "Shape"),
            rateSync: this.#parametric.createParameter(box.rateSync,
                ValueMapping.linearInteger(0, LfoModulatorBoxAdapter.Rates.length - 1),
                StringMapping.indices("", LfoModulatorBoxAdapter.RateStrings), "Rate"),
            rateAbsolute: this.#parametric.createParameter(box.rateAbsolute,
                ValueMapping.powerByCenter(LfoModulatorBoxAdapter.CenterAbsoluteRate,
                    0.0, LfoModulatorBoxAdapter.MaxAbsoluteRate),
                StringMapping.numeric({unit: "Hz", fractionDigits: 2}), "Free"),
            phase: this.#parametric.createParameter(box.phase,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Phase"),
            amount: this.#parametric.createParameter(box.amount,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Amount")
        } as const
    }
}

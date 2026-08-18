import {Address} from "@opendaw/lib-box"
import {ModulationBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {isModulatorBoxAdapter, ModulatorBoxAdapter} from "./ModulatorBoxAdapter"
import {ParameterOwner} from "../ParameterOwner"

export class ModulationBoxAdapter implements BoxAdapter {
    readonly #terminator: Terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #box: ModulationBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: ModulationBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = {
            depth: this.#parametric.createParameter(box.depth, ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 0}), "Depth", 0.5)
        } as const
    }

    get box(): ModulationBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get enabled(): boolean {return this.#box.enabled.getValue()}
    get depth(): number {return this.#box.depth.getValue()}

    get source(): ModulatorBoxAdapter {
        return this.#context.boxAdapters.adapterFor(
            this.#box.source.targetVertex.unwrap("no modulator").box, isModulatorBoxAdapter)
    }

    /// `None` while the target field has no registered parameter adapter yet.
    get target(): Option<AutomatableParameterFieldAdapter> {
        return this.#box.target.targetVertex
            .flatMap(vertex => this.#context.parameterFieldAdapters.opt(vertex.address))
    }

    get targetOwner(): Option<string> {
        return this.#box.target.targetVertex.flatMap(vertex => ParameterOwner.nameOf(this.#context, vertex))
    }

    terminate(): void {this.#terminator.terminate()}
}

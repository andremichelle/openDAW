import {Address, Box, Int32Field} from "@opendaw/lib-box"
import {LfoModulatorBox, MacroModulatorBox, ModulationBox, StepsModulatorBox} from "@opendaw/studio-boxes"
import {asInstanceOf, AssertType, isInstanceOf, Terminator, UUID} from "@opendaw/lib-std"
import {IndexedBoxAdapter} from "../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {ModulationBoxAdapter} from "./ModulationBoxAdapter"

export type ModulatorBox = LfoModulatorBox | StepsModulatorBox | MacroModulatorBox

export const isModulatorBox = (box: Box): box is ModulatorBox => box.tags.type === "modulator"

export abstract class ModulatorBoxAdapter<BOX extends ModulatorBox = ModulatorBox> implements IndexedBoxAdapter {
    protected readonly terminator: Terminator = new Terminator()
    protected readonly context: BoxAdaptersContext
    protected readonly parametric: ParameterAdapterSet

    readonly #box: BOX

    protected constructor(context: BoxAdaptersContext, box: BOX) {
        this.context = context
        this.#box = box
        this.parametric = this.terminator.own(new ParameterAdapterSet(context))
    }

    get box(): BOX {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get enabled(): boolean {return this.#box.enabled.getValue()}
    get indexField(): Int32Field {return this.#box.index}

    get assignments(): ReadonlyArray<ModulationBoxAdapter> {
        return this.#box.assignments.pointerHub.incoming()
            .map(({box}) => this.context.boxAdapters.adapterFor(asInstanceOf(box, ModulationBox), ModulationBoxAdapter))
    }

    terminate(): void {this.terminator.terminate()}
}

export const isModulatorBoxAdapter: AssertType<ModulatorBoxAdapter> =
    (adapter: unknown): adapter is ModulatorBoxAdapter => isInstanceOf(adapter, ModulatorBoxAdapter)

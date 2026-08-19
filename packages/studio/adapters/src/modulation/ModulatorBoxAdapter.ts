import {Address, Box, Int32Field, StringField} from "@opendaw/lib-box"
import {
    LfoModulatorBox,
    MacroModulatorBox,
    ModulationBox,
    RandomModulatorBox,
    StepsModulatorBox
} from "@opendaw/studio-boxes"
import {asInstanceOf, AssertType, isInstanceOf, Terminator, UUID} from "@opendaw/lib-std"
import {IndexedBoxAdapter} from "../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {FieldParameterTracks} from "../timeline/ParameterTracks"
import {ModulationBoxAdapter} from "./ModulationBoxAdapter"

export type ModulatorBox = LfoModulatorBox | StepsModulatorBox | MacroModulatorBox | RandomModulatorBox

export const isModulatorBox = (box: Box): box is ModulatorBox => box.tags.type === "modulator"

export abstract class ModulatorBoxAdapter<BOX extends ModulatorBox = ModulatorBox> implements IndexedBoxAdapter {
    protected readonly terminator: Terminator = new Terminator()
    protected readonly context: BoxAdaptersContext
    protected readonly parametric: ParameterAdapterSet
    readonly tracks: FieldParameterTracks

    readonly #box: BOX

    protected constructor(context: BoxAdaptersContext, box: BOX) {
        this.context = context
        this.#box = box
        this.parametric = this.terminator.own(new ParameterAdapterSet(context))
        this.tracks = this.terminator.own(
            new FieldParameterTracks(box.graph, box.tracks, context.boxAdapters))
    }

    get box(): BOX {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get labelField(): StringField {return this.#box.label}
    get enabled(): boolean {return this.#box.enabled.getValue()}
    get indexField(): Int32Field {return this.#box.index}

    get assignments(): ReadonlyArray<ModulationBoxAdapter> {
        return this.#box.assignments.pointerHub.incoming()
            .map(({box}) => this.context.boxAdapters.adapterFor(asInstanceOf(box, ModulationBox), ModulationBoxAdapter))
    }

    /// The subclass creates its parameters, then hands them their lane owner: automation of a modulator's
    /// parameter lives on the modulator, not on an audio unit.
    protected registerParameterTracks(): void {
        this.parametric.parameters().forEach(parameter =>
            this.terminator.own(parameter.registerTracks(this.tracks)))
    }

    terminate(): void {this.terminator.terminate()}
}

export const isModulatorBoxAdapter: AssertType<ModulatorBoxAdapter> =
    (adapter: unknown): adapter is ModulatorBoxAdapter => isInstanceOf(adapter, ModulatorBoxAdapter)

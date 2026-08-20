import {Address, BooleanField, Box, Int32Field, StringField} from "@opendaw/lib-box"
import {
    LfoModulatorBox,
    MacroModulatorBox,
    ModulationBox,
    RandomModulatorBox,
    StepsModulatorBox
} from "@opendaw/studio-boxes"
import {
    asInstanceOf,
    AssertType,
    isInstanceOf,
    ParseResult,
    StringMapping,
    StringResult,
    Terminator,
    unitValue,
    UUID,
    ValueMapping
} from "@opendaw/lib-std"
import {IndexedBoxAdapter} from "../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {FieldParameterTracks} from "../timeline/ParameterTracks"
import {ModulationBoxAdapter} from "./ModulationBoxAdapter"

const percent = (value: number): string => (value * 100.0).toFixed(0)

export const rangeStringMapping = (bipolar: BooleanField): StringMapping<unitValue> => ({
    x: (value: unitValue): StringResult =>
        ({value: `${bipolar.getValue() ? "±" : "+"}${percent(value)}`, unit: "%"}),
    y: (text: string): ParseResult<unitValue> => {
        const value = parseFloat(text.replace("±", "").replace("+", "").trim())
        return isNaN(value) ? {type: "unknown", value: text.trim()} : {type: "explicit", value: value / 100.0}
    }
})

export const polarityStringMapping = (bipolar: BooleanField): StringMapping<unitValue> => ({
    x: (value: unitValue): StringResult =>
        ({value: percent(bipolar.getValue() ? value * 2.0 - 1.0 : value), unit: "%"}),
    y: (text: string): ParseResult<unitValue> => {
        const value = parseFloat(text.replace("%", "").trim())
        if (isNaN(value)) {return {type: "unknown", value: text.trim()}}
        return {type: "explicit", value: bipolar.getValue() ? value / 200.0 + 0.5 : value / 100.0}
    }
})

export type ModulatorBox = LfoModulatorBox | StepsModulatorBox | MacroModulatorBox | RandomModulatorBox

export const isModulatorBox = (box: Box): box is ModulatorBox => box.tags.type === "modulator"

export abstract class ModulatorBoxAdapter<BOX extends ModulatorBox = ModulatorBox> implements IndexedBoxAdapter {
    protected readonly terminator: Terminator = new Terminator()
    protected readonly context: BoxAdaptersContext
    protected readonly parametric: ParameterAdapterSet
    readonly tracks: FieldParameterTracks
    readonly amount: AutomatableParameterFieldAdapter<unitValue>

    readonly #box: BOX

    protected constructor(context: BoxAdaptersContext, box: BOX) {
        this.context = context
        this.#box = box
        this.parametric = this.terminator.own(new ParameterAdapterSet(context))
        this.tracks = this.terminator.own(
            new FieldParameterTracks(box.graph, box.tracks, context.boxAdapters))
        this.amount = this.parametric.createParameter(box.amount,
            ValueMapping.unipolar(), rangeStringMapping(box.bipolar), "Range")
    }

    get box(): BOX {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get labelField(): StringField {return this.#box.label}
    get enabled(): boolean {return this.#box.enabled.getValue()}
    get indexField(): Int32Field {return this.#box.index}
    get bipolarField(): BooleanField {return this.#box.bipolar}

    get assignments(): ReadonlyArray<ModulationBoxAdapter> {
        return this.#box.assignments.pointerHub.incoming()
            .map(({box}) => this.context.boxAdapters.adapterFor(asInstanceOf(box, ModulationBox), ModulationBoxAdapter))
    }

    /// The subclass creates its parameters, then hands them their lane owner: automation of a modulator's
    /// parameter lives on the modulator, not on an audio unit.
    protected registerParameterTracks(): void {
        const parameters = this.parametric.parameters()
        parameters.forEach(parameter => this.terminator.own(parameter.registerTracks(this.tracks)))
        this.terminator.own(this.#box.bipolar.subscribe(() =>
            parameters.forEach(parameter => parameter.notifyPrinting())))
    }

    terminate(): void {this.terminator.terminate()}
}

export const isModulatorBoxAdapter: AssertType<ModulatorBoxAdapter> =
    (adapter: unknown): adapter is ModulatorBoxAdapter => isInstanceOf(adapter, ModulatorBoxAdapter)

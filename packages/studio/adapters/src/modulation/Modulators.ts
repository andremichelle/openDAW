import {LfoModulatorBox, MacroModulatorBox, ModulationBox, RootBox, StepsModulatorBox} from "@opendaw/studio-boxes"
import {Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Strings, unitValue, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ModulatorBox} from "./ModulatorBoxAdapter"

/// Every caller is inside an `editing.modify`, so nothing here opens a transaction.
export namespace Modulators {
    export const createLfo = (context: BoxAdaptersContext, label?: string): LfoModulatorBox =>
        LfoModulatorBox.create(context.boxGraph, UUID.generate(), box => attach(context, box, label ?? "LFO"))

    export const createSteps = (context: BoxAdaptersContext, label?: string): StepsModulatorBox =>
        StepsModulatorBox.create(context.boxGraph, UUID.generate(), box => attach(context, box, label ?? "Steps"))

    export const createMacro = (context: BoxAdaptersContext, label?: string): MacroModulatorBox =>
        MacroModulatorBox.create(context.boxGraph, UUID.generate(), box => attach(context, box, label ?? "Macro"))

    const attach = (context: BoxAdaptersContext, box: ModulatorBox, label: string): void => {
        const rootBox: RootBox = context.rootBoxAdapter.box
        const existing = context.rootBoxAdapter.modulators.adapters()
        box.collection.refer(rootBox.modulators)
        box.index.setValue(existing.length)
        box.label.setValue(Strings.getUniqueName(existing.map(adapter => adapter.label), label))
    }

    /// A parameter accepts several assignments, so this never replaces an existing one. `depth` is signed.
    export const assign = (context: BoxAdaptersContext,
                           modulator: ModulatorBox,
                           target: Field<Pointers.Modulation>,
                           depth: unitValue = 0.25): ModulationBox =>
        ModulationBox.create(context.boxGraph, UUID.generate(), box => {
            box.source.refer(modulator.assignments)
            box.target.refer(target)
            box.index.setValue(modulator.assignments.pointerHub.incoming().length)
            box.depth.setValue(depth)
        })
}

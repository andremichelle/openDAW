import {LfoModulatorBox, ModulationBox, RootBox} from "@opendaw/studio-boxes"
import {Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Strings, unitValue, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"

/// Every caller is inside an `editing.modify`, so nothing here opens a transaction.
export namespace Modulators {
    export const createLfo = (context: BoxAdaptersContext, label?: string): LfoModulatorBox => {
        const rootBox: RootBox = context.rootBoxAdapter.box
        const existing = context.rootBoxAdapter.modulators.adapters()
        const unique = Strings.getUniqueName(existing.map(adapter => adapter.label), label ?? "LFO")
        return LfoModulatorBox.create(context.boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.index.setValue(existing.length)
            box.label.setValue(unique)
        })
    }

    /// A parameter accepts several assignments, so this never replaces an existing one. `depth` is signed.
    export const assign = (context: BoxAdaptersContext,
                           modulator: LfoModulatorBox,
                           target: Field<Pointers.Modulation>,
                           depth: unitValue = 0.25): ModulationBox =>
        ModulationBox.create(context.boxGraph, UUID.generate(), box => {
            box.source.refer(modulator.assignments)
            box.target.refer(target)
            box.index.setValue(modulator.assignments.pointerHub.incoming().length)
            box.depth.setValue(depth)
        })
}

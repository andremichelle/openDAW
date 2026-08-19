import {
    BoxIO,
    BoxVisitor,
    LfoModulatorBox,
    MacroModulatorBox,
    ModulationBox,
    RandomModulatorBox,
    RootBox,
    StepsModulatorBox
} from "@opendaw/studio-boxes"
import {Box, Field, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ByteArrayInput, Func, panic, Strings, unitValue, UUID} from "@opendaw/lib-std"
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

    export const createRandom = (context: BoxAdaptersContext, label?: string): RandomModulatorBox =>
        RandomModulatorBox.create(context.boxGraph, UUID.generate(), box => attach(context, box, label ?? "Random"))

    export type Kind = {
        readonly label: string
        readonly boxName: string
        readonly create: Func<BoxAdaptersContext, ModulatorBox>
    }

    export const Kinds: ReadonlyArray<Kind> = [
        {label: "LFO", boxName: "LfoModulatorBox", create: createLfo},
        {label: "Steps", boxName: "StepsModulatorBox", create: createSteps},
        {label: "Macro", boxName: "MacroModulatorBox", create: createMacro},
        {label: "Random", boxName: "RandomModulatorBox", create: createRandom}
    ]

    /// Becomes another kind in place: the assignments move over first, so they never see the old box die.
    export const replace = (context: BoxAdaptersContext, modulator: ModulatorBox, kind: Kind): ModulatorBox => {
        const replacement = kind.create(context)
        modulator.assignments.pointerHub.incoming().slice()
            .forEach((pointer: PointerField) => pointer.refer(replacement.assignments))
        const label = modulator.label.getValue()
        const index = modulator.index.getValue()
        const enabled = modulator.enabled.getValue()
        modulator.delete()
        replacement.label.setValue(label)
        replacement.index.setValue(index)
        replacement.enabled.setValue(enabled)
        return replacement
    }

    /// Same kind and settings, no targets. The copy reads the original's own bytes, so every kind is covered.
    export const duplicate = (context: BoxAdaptersContext, modulator: ModulatorBox): ModulatorBox => {
        const existing = context.rootBoxAdapter.modulators.adapters()
        const input = new ByteArrayInput(modulator.toArrayBuffer())
        const copy = asModulatorBox(context.boxGraph.createBox(modulator.name as keyof BoxIO.TypeMap,
            UUID.generate(), box => box.read(input)))
        copy.index.setValue(existing.length)
        copy.label.setValue(Strings.getUniqueName(existing.map(adapter => adapter.label), modulator.label.getValue()))
        return copy
    }

    const asModulatorBox = (box: Box): ModulatorBox => box.accept<BoxVisitor<ModulatorBox>>({
        visitLfoModulatorBox: (box: LfoModulatorBox) => box,
        visitStepsModulatorBox: (box: StepsModulatorBox) => box,
        visitMacroModulatorBox: (box: MacroModulatorBox) => box,
        visitRandomModulatorBox: (box: RandomModulatorBox) => box
    }) ?? panic(`${box.name} is no modulator`)

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

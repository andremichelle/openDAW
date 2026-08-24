import {
    BoxIO,
    BoxVisitor,
    LfoModulatorBox,
    MacroModulatorBox,
    ModulationBox,
    RandomModulatorBox,
    RootBox,
    StepsModulatorBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {Box, Field, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ByteArrayInput, Func, isInstanceOf, panic, Strings, unitValue, UUID} from "@opendaw/lib-std"
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
        // An assignment's depth lane is parented to its SOURCE, so it would die with the old box while the
        // assignment it belongs to survives. The old kind's own parameter lanes have no meaning in the new
        // kind and are left to the cascade.
        modulator.tracks.pointerHub.incoming().slice()
            .map((pointer: PointerField) => pointer.box)
            .filter((box: Box) => isInstanceOf(box, TrackBox))
            .filter((track: TrackBox) => track.target.targetVertex
                .mapOr(vertex => isInstanceOf(vertex.box, ModulationBox), false))
            .forEach((track: TrackBox) => track.tracks.refer(replacement.tracks))
        const label = modulator.label.getValue()
        const index = modulator.index.getValue()
        const enabled = modulator.enabled.getValue()
        const bipolar = modulator.bipolar.getValue()
        const amount = modulator.amount.getValue()
        modulator.delete()
        replacement.label.setValue(label)
        replacement.index.setValue(index)
        replacement.enabled.setValue(enabled)
        replacement.bipolar.setValue(bipolar)
        replacement.amount.setValue(amount)
        return replacement
    }

    /// Same kind and settings, no targets. The copy reads the original's own bytes, so every kind is covered.
    export const duplicate = (context: BoxAdaptersContext, modulator: ModulatorBox): ModulatorBox =>
        duplicateAll(context, [modulator])[0]

    /// Several at once, appended in their list order, each with its own unique name. A box created in THIS
    /// transaction is not in the collection yet (its edges resolve on commit), so index and name are counted
    /// forward here rather than re-read per copy.
    export const duplicateAll = (context: BoxAdaptersContext,
                                 modulators: ReadonlyArray<ModulatorBox>): ReadonlyArray<ModulatorBox> => {
        const existing = context.rootBoxAdapter.modulators.adapters()
        const taken = existing.map(adapter => adapter.label)
        return modulators.slice()
            .sort((a, b) => a.index.getValue() - b.index.getValue())
            .map((modulator, offset) => {
                const input = new ByteArrayInput(modulator.toArrayBuffer())
                const copy = asModulatorBox(context.boxGraph.createBox(modulator.name as keyof BoxIO.TypeMap,
                    UUID.generate(), box => box.read(input)))
                const label = Strings.getUniqueName(taken, modulator.label.getValue())
                taken.push(label)
                copy.index.setValue(existing.length + offset)
                copy.label.setValue(label)
                return copy
            })
    }

    /// Delete a whole selection and close the gaps it leaves, so the remaining indices stay 0..n-1.
    export const deleteAll = (context: BoxAdaptersContext, modulators: ReadonlyArray<ModulatorBox>): void => {
        const doomed = new Set<ModulatorBox>(modulators)
        const remaining = context.rootBoxAdapter.modulators.adapters()
            .filter(adapter => !doomed.has(adapter.box))
        doomed.forEach(modulator => modulator.delete())
        reindex(remaining.map(adapter => adapter.box))
    }

    /// Move a set to `target`'s place, keeping the moved ones in their own order. Dropping onto a member of
    /// the set itself is a no-op, so a drag that ends where it started changes nothing.
    export const move = (context: BoxAdaptersContext,
                         modulators: ReadonlyArray<ModulatorBox>,
                         target: ModulatorBox): void => {
        const moved = new Set<ModulatorBox>(modulators)
        if (moved.has(target) || moved.size === 0) {return}
        const ordered = context.rootBoxAdapter.modulators.adapters().map(adapter => adapter.box)
        const stationary = ordered.filter(box => !moved.has(box))
        const insertAt = stationary.indexOf(target)
        if (insertAt < 0) {return}
        const dragged = ordered.filter(box => moved.has(box))
        const before = ordered.indexOf(dragged[0]) < ordered.indexOf(target)
        stationary.splice(before ? insertAt + 1 : insertAt, 0, ...dragged)
        reindex(stationary)
    }

    const reindex = (modulators: ReadonlyArray<ModulatorBox>): void =>
        modulators.forEach((modulator, index) => modulator.index.setValue(index))

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

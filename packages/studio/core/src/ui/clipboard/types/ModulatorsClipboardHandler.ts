import {
    ByteArrayInput,
    ByteArrayOutput,
    Editing,
    int,
    isInstanceOf,
    Option,
    Optional,
    Provider,
    Strings,
    UUID
} from "@opendaw/lib-std"
import {Box, BoxGraph} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {RootBox} from "@opendaw/studio-boxes"
import {
    BoxAdapters,
    FilteredSelection,
    isModulatorBox,
    isModulatorBoxAdapter,
    ModulatorBox,
    ModulatorBoxAdapter,
    RootBoxAdapter
} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"

type ClipboardModulators = ClipboardEntry<"modulators">

type ModulatorsMetadata = { count: int }

/// The modulation panel's copy / cut / paste, the device chain's model applied to the modulator list.
///
/// A modulator travels ALONE: its assignments (`ModulationBox`) point at parameters of devices that the
/// destination project may not have, and its automation lanes belong to the tracks of the project it was
/// copied from. This is the same content `Modulators.duplicate` produces, so a copy-paste and a duplicate
/// give the same result.
export namespace ModulatorsClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly editing: Editing
        readonly selection: FilteredSelection<ModulatorBoxAdapter>
        readonly boxGraph: BoxGraph
        readonly boxAdapters: BoxAdapters
        readonly rootBoxAdapter: Provider<RootBoxAdapter>
    }

    const encodeMetadata = ({count}: ModulatorsMetadata): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeInt(count)
        return output.toArrayBuffer()
    }

    const decodeMetadata = (buffer: ArrayBufferLike): ModulatorsMetadata =>
        ({count: new ByteArrayInput(buffer).readInt()})

    export const findRootBox = (boxGraph: BoxGraph): Option<RootBox> =>
        Option.wrap(boxGraph.boxes().find(box => isInstanceOf(box, RootBox)) as Optional<RootBox>)

    /// Duplicate the selection in place, leaving the OS clipboard untouched.
    export const duplicate = (context: Context): void => {
        const handler = createHandler(context)
        handler.copy().ifSome(entry => handler.paste(entry))
    }

    export const createHandler = ({
                                      getEnabled,
                                      editing,
                                      selection,
                                      boxGraph,
                                      boxAdapters,
                                      rootBoxAdapter
                                  }: Context): ClipboardHandler<ClipboardModulators> => {
        const selectedInOrder = (): ReadonlyArray<ModulatorBoxAdapter> => selection.selected()
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())
        const copyModulators = (): Option<ClipboardModulators> => {
            editing.mark()
            const selected = selectedInOrder()
            if (selected.length === 0) {return Option.None}
            const data = ClipboardUtils.serializeBoxes(selected.map(adapter => adapter.box),
                encodeMetadata({count: selected.length}))
            return Option.wrap({type: "modulators", data, count: selected.length})
        }
        return {
            canCopy: (): boolean => getEnabled() && selection.selected().length > 0,
            canCut: (): boolean => getEnabled() && selection.selected().length > 0,
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "modulators",
            copy: copyModulators,
            cut: (): Option<ClipboardModulators> => {
                const result = copyModulators()
                result.ifSome(() => {
                    const doomed = selectedInOrder().map(adapter => adapter.box)
                    const remaining = rootBoxAdapter().modulators.adapters()
                        .filter(adapter => !doomed.includes(adapter.box))
                    editing.modify(() => {
                        selection.deselectAll()
                        doomed.forEach(box => box.delete())
                        remaining.forEach((adapter, index) => adapter.indexField.setValue(index))
                    })
                })
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "modulators" || !getEnabled()) {return}
                const adapter = rootBoxAdapter()
                const existing = adapter.modulators.adapters()
                const {count} = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                // The copies land right after the selection, the way a pasted device does; with nothing
                // selected they go to the end of the list.
                const insertIndex = selection.selected().length === 0
                    ? existing.length
                    : selection.selected()
                        .reduce((max, entry) => Math.max(max, entry.indexField.getValue()), -1) + 1
                editing.modify(() => {
                    selection.deselectAll()
                    existing.forEach(entry => {
                        const index = entry.indexField.getValue()
                        if (index >= insertIndex) {entry.indexField.setValue(index + count)}
                    })
                    const boxes = ClipboardUtils.deserializeBoxes(entry.data, boxGraph, {
                        mapPointer: (pointer, address) => {
                            if (pointer.pointerType === Pointers.ModulatorCollection) {
                                return findRootBox(boxGraph).map(rootBox => rootBox.modulators.address)
                            }
                            return address
                        }
                    })
                    const pasted = boxes.filter((box: Box): box is ModulatorBox => isModulatorBox(box))
                        .toSorted((a, b) => a.index.getValue() - b.index.getValue())
                    // The labels of the copies must not collide with the ones already in the list, and a
                    // multi-paste must not have its own copies collide either, so names are taken one by one.
                    const taken = existing.map(entry => entry.label)
                    pasted.forEach((box, index) => {
                        box.index.setValue(insertIndex + index)
                        const label = Strings.getUniqueName(taken, box.label.getValue())
                        taken.push(label)
                        box.label.setValue(label)
                    })
                    selection.select(...pasted.map(box =>
                        boxAdapters.adapterFor(box, isModulatorBoxAdapter)))
                })
            }
        }
    }

    /// The uuids a drag carries, i.e. the whole selection when the dragged modulator is part of it.
    export const dragUuids = (selection: FilteredSelection<ModulatorBoxAdapter>,
                              source: ModulatorBoxAdapter): ReadonlyArray<UUID.String> => {
        const selected = selection.selected()
        const dragged = selected.includes(source) ? selected : [source]
        return dragged
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())
            .map(adapter => UUID.toString(adapter.uuid))
    }
}

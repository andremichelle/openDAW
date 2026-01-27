import {ByteArrayInput, ByteArrayOutput, Option, Procedure, Provider, Selection} from "@opendaw/lib-std"
import {Address, BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {ValueEventBox} from "@opendaw/studio-boxes"
import {BoxAdapters, ValueEventBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"

type ClipboardValues = ClipboardEntry<"values">

export namespace ValuesClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly getPosition: Provider<ppqn>
        readonly setPosition: Procedure<ppqn>
        readonly editing: BoxEditing
        readonly selection: Selection<ValueEventBoxAdapter>
        readonly collection: ValueEventCollectionBoxAdapter
        readonly targetAddress: Address
        readonly boxGraph: BoxGraph
        readonly boxAdapters: BoxAdapters
    }

    const encodeMetadata = (min: ppqn, max: ppqn): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeFloat(min)
        output.writeFloat(max)
        return output.toArrayBuffer()
    }

    const decodeMetadata = (buffer: ArrayBufferLike): { min: ppqn, max: ppqn } => {
        const input = new ByteArrayInput(buffer)
        return {min: input.readFloat(), max: input.readFloat()}
    }

    // At pastedMin: push pasted after existing → keep first (existing, index 0) and last (pasted, index 1)
    // At pastedMax: unshift pasted before existing → keep first (pasted, index 0) and last (existing, index 1)
    // Delete middle events, all pasted events survive
    const resolveIndexConflicts = (existingAdapters: ReadonlyArray<ValueEventBoxAdapter>,
                                   pastedAdapters: ReadonlyArray<ValueEventBoxAdapter>,
                                   pastedMin: ppqn,
                                   pastedMax: ppqn): ReadonlyArray<ValueEventBoxAdapter> => {
        const sortedPasted = pastedAdapters.slice().sort((a, b) => {
            const positionDiff = a.position - b.position
            return positionDiff !== 0 ? positionDiff : a.index - b.index
        })
        const deletedSet = new Set<ValueEventBoxAdapter>()
        const handleBoundary = (position: ppqn, pastedFirst: boolean): void => {
            const existingAtPos = existingAdapters
                .filter(adapter => adapter.position === position)
                .sort((a, b) => a.index - b.index)
            const pastedAtPos = sortedPasted.filter(adapter => adapter.position === position)
            const combined = pastedFirst
                ? [...pastedAtPos, ...existingAtPos]
                : [...existingAtPos, ...pastedAtPos]
            if (combined.length <= 1) {return}
            for (let i = 1; i < combined.length - 1; i++) {
                combined[i].box.delete()
                deletedSet.add(combined[i])
            }
            combined[0].box.index.setValue(0)
            combined[combined.length - 1].box.index.setValue(1)
        }
        handleBoundary(pastedMin, false)
        if (pastedMax !== pastedMin) {
            handleBoundary(pastedMax, true)
        }
        return sortedPasted.filter(adapter => !deletedSet.has(adapter))
    }

    export const createHandler = ({
                                      getEnabled,
                                      getPosition,
                                      setPosition,
                                      editing,
                                      selection,
                                      collection,
                                      targetAddress,
                                      boxGraph,
                                      boxAdapters
                                  }: Context): ClipboardHandler<ClipboardValues> => {
        const copyValues = (): Option<ClipboardValues> => {
            const selected = selection.selected()
            if (selected.length === 0) {return Option.None}
            const sorted = selected.slice().sort((a, b) => {
                const positionDiff = a.position - b.position
                return positionDiff !== 0 ? positionDiff : a.index - b.index
            })
            const min = sorted[0].position
            const max = sorted[sorted.length - 1].position
            const eventBoxes = sorted.map(adapter => adapter.box)
            const dependencies = eventBoxes.flatMap(box =>
                Array.from(boxGraph.dependenciesOf(box, {
                    alwaysFollowMandatory: true,
                    excludeBox: dep => dep.ephemeral
                }).boxes))
            const allBoxes = [...eventBoxes, ...dependencies]
            const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(min, max))
            setPosition(max)
            return Option.wrap({type: "values", data})
        }
        return {
            canCopy: (): boolean => getEnabled() && selection.nonEmpty(),
            canCut: (): boolean => getEnabled() && selection.nonEmpty(),
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "values",
            copy: copyValues,
            cut: (): Option<ClipboardValues> => {
                const result = copyValues()
                result.ifSome(() => editing.modify(() => selection.selected().forEach(adapter => adapter.box.delete())))
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "values" || !getEnabled()) {return}
                const position = getPosition()
                const {min, max} = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                const positionOffset = Math.max(0, position) - min
                const pastedMin = min + positionOffset
                const pastedMax = max + positionOffset
                editing.modify(() => {
                    selection.deselectAll()
                    const existingAdapters: Array<ValueEventBoxAdapter> = []
                    for (const adapter of collection.events.asArray()) {
                        if (pastedMin < adapter.position && adapter.position < pastedMax) {
                            adapter.box.delete()
                        } else {
                            existingAdapters.push(adapter)
                        }
                    }
                    const boxes = ClipboardUtils.deserializeBoxes(
                        entry.data,
                        boxGraph,
                        {
                            mapPointer: pointer => pointer.pointerType === Pointers.ValueEvents
                                ? Option.wrap(targetAddress)
                                : Option.None,
                            modifyBox: box => {
                                if (box instanceof ValueEventBox) {
                                    box.position.setValue(box.position.getValue() + positionOffset)
                                }
                            }
                        }
                    )
                    const valueEventBoxes = boxes.filter((box): box is ValueEventBox => box instanceof ValueEventBox)
                    const pastedAdapters = valueEventBoxes.map(box => boxAdapters.adapterFor(box, ValueEventBoxAdapter))
                    const survivingPasted = resolveIndexConflicts(existingAdapters, pastedAdapters, pastedMin, pastedMax)
                    selection.select(...survivingPasted)
                    setPosition(pastedMax)
                })
            }
        }
    }
}
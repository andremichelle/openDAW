import {ByteArrayInput, ByteArrayOutput, Option, Procedure, Provider, Selection} from "@opendaw/lib-std"
import {Address, Box, BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {NoteEventBox} from "@opendaw/studio-boxes"
import {BoxAdapters, NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"

type ClipboardNotes = ClipboardEntry<"notes">

export namespace NotesClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly getPosition: Provider<ppqn>
        readonly setPosition: Procedure<ppqn>
        readonly editing: BoxEditing
        readonly selection: Selection<NoteEventBoxAdapter>
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

    export const createHandler = ({
                                      getEnabled,
                                      getPosition,
                                      setPosition,
                                      editing,
                                      selection,
                                      targetAddress,
                                      boxGraph,
                                      boxAdapters
                                  }: Context): ClipboardHandler<ClipboardNotes> => {
        const copyNotes = (): Option<ClipboardNotes> => {
            const selected = selection.selected()
            if (selected.length === 0) {return Option.None}
            const min = selected.reduce((acc, {position}) => Math.min(acc, position), Number.POSITIVE_INFINITY)
            const max = selected.reduce((acc, {complete}) => Math.max(acc, complete), Number.NEGATIVE_INFINITY)
            const eventBoxes = selected.map(adapter => adapter.box)
            const dependencies = eventBoxes.flatMap(box =>
                Array.from(boxGraph.dependenciesOf(box, {
                    alwaysFollowMandatory: true,
                    excludeBox: (dep: Box) => dep.ephemeral
                }).boxes))
            const allBoxes = [...eventBoxes, ...dependencies]
            const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(min, max))
            setPosition(max)
            return Option.wrap({type: "notes", data})
        }
        return {
            canCopy: (): boolean => getEnabled() && selection.nonEmpty(),
            canCut: (): boolean => getEnabled() && selection.nonEmpty(),
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "notes",
            copy: copyNotes,
            cut: (): Option<ClipboardNotes> => {
                const result = copyNotes()
                result.ifSome(() => editing.modify(() => selection.selected().forEach(adapter => adapter.box.delete())))
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "notes" || !getEnabled()) {return}
                const position = getPosition()
                const {min, max} = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                const positionOffset = Math.max(0, position) - min
                editing.modify(() => {
                    selection.deselectAll()
                    const boxes = ClipboardUtils.deserializeBoxes(
                        entry.data,
                        boxGraph,
                        {
                            mapPointer: pointer => pointer.pointerType === Pointers.NoteEvents
                                ? Option.wrap(targetAddress)
                                : Option.None,
                            modifyBox: box => {
                                if (box instanceof NoteEventBox) {
                                    box.position.setValue(box.position.getValue() + positionOffset)
                                }
                            }
                        }
                    )
                    const noteEventBoxes = boxes.filter((box): box is NoteEventBox => box instanceof NoteEventBox)
                    selection.select(...noteEventBoxes.map(box => boxAdapters.adapterFor(box, NoteEventBoxAdapter)))
                    setPosition(Math.max(0, position) + (max - min))
                })
            }
        }
    }
}
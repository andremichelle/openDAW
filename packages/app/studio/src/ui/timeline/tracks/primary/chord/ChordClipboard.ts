import {ByteArrayInput, ByteArrayOutput, Editing, Option, Procedure, Provider, Selection} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {BoxAdapters, ChordEventBoxAdapter, ChordTrackAdapter} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler, ClipboardUtils} from "@opendaw/studio-core"
import {ChordOverlaps} from "@/ui/timeline/tracks/primary/chord/ChordOverlaps"

type ClipboardChords = ClipboardEntry<"chords">

export namespace ChordClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly getPosition: Provider<ppqn>
        readonly setPosition: Procedure<ppqn>
        readonly editing: Editing
        readonly selection: Selection<ChordEventBoxAdapter>
        readonly chordTrack: ChordTrackAdapter
        readonly boxGraph: BoxGraph
        readonly boxAdapters: BoxAdapters
    }

    export const extent = (adapters: ReadonlyArray<ChordEventBoxAdapter>): { min: ppqn, max: ppqn } => ({
        min: Math.min(...adapters.map(({position}) => position)),
        max: Math.max(...adapters.map(({complete}) => complete))
    })

    export const insert = ({selection, chordTrack, boxGraph, boxAdapters}: Context,
                           data: ArrayBufferLike, offset: ppqn): ReadonlyArray<ChordEventBoxAdapter> => {
        const boxes = ClipboardUtils.deserializeBoxes(data, boxGraph, {
            mapPointer: pointer => pointer.pointerType === Pointers.ChordTrack
                ? Option.wrap(chordTrack.object.events.address) : Option.None,
            modifyBox: box => {
                if (box instanceof ChordEventBox) {box.position.setValue(box.position.getValue() + offset)}
            }
        })
        const pasted = boxes.filter((box): box is ChordEventBox => box instanceof ChordEventBox)
            .map(box => boxAdapters.adapterFor(box, ChordEventBoxAdapter))
        pasted.forEach(adapter => ChordOverlaps.resolve(chordTrack, adapter, pasted))
        selection.deselectAll()
        selection.select(...pasted)
        return pasted
    }

    export const serialize = (adapters: ReadonlyArray<ChordEventBoxAdapter>): ArrayBufferLike => {
        const {min, max} = extent(adapters)
        const output = ByteArrayOutput.create()
        output.writeInt(min)
        output.writeInt(max)
        return ClipboardUtils.serializeBoxes(adapters.map(({box}) => box), output.toArrayBuffer())
    }

    export const createHandler = (context: Context): ClipboardHandler<ClipboardChords> => {
        const {getEnabled, getPosition, setPosition, editing, selection} = context
        const copyChords = (): Option<ClipboardChords> => {
            const selected = selection.selected()
            if (selected.length === 0) {return Option.None}
            setPosition(extent(selected).max)
            return Option.wrap({type: "chords", data: serialize(selected), count: selected.length})
        }
        return {
            canCopy: (): boolean => getEnabled() && selection.nonEmpty(),
            canCut: (): boolean => getEnabled() && selection.nonEmpty(),
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "chords",
            copy: copyChords,
            cut: (): Option<ClipboardChords> => {
                const result = copyChords()
                result.ifSome(() => editing.modify(() => selection.selected().forEach(({box}) => box.delete())))
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "chords" || !getEnabled()) {return}
                const input = new ByteArrayInput(ClipboardUtils.extractMetadata(entry.data))
                const min = input.readInt()
                const max = input.readInt()
                const offset = Math.max(0, Math.floor(getPosition())) - min
                editing.modify(() => insert(context, entry.data, offset))
                setPosition(max + offset)
            }
        }
    }
}

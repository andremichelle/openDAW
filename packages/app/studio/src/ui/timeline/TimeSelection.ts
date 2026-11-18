import {ppqn} from "@opendaw/lib-dsp"
import {SortedSet, UUID} from "@opendaw/lib-std"

export type TimeSelection = Readonly<{
    position: ppqn, complete: ppqn, rows: SortedSet<UUID.Bytes, UUID.Bytes>, global: boolean
}>

export namespace TimeSelection {
    export type Row = Readonly<{key: UUID.Bytes, element: HTMLElement}>

    export const rowIndexAt = (rows: ReadonlyArray<Row>, clientY: number): number => {
        const index = rows.findIndex(({element}) => clientY < element.getBoundingClientRect().bottom)
        return index === -1 ? rows.length - 1 : index
    }
}

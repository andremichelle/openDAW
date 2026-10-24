import {AudioUnitLayout} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Client, isDefined, Option, Optional, Rect} from "@opendaw/lib-std"

export namespace GroupDropLayout {
    export type Row = {readonly unit: AudioUnitBox, readonly bounds: Rect, readonly header: Rect}
    export type Target = {
        readonly parent: Optional<AudioUnitBox>
        readonly before: Optional<AudioUnitBox>
        readonly row: Row
        readonly inside: boolean
        readonly after: boolean
        readonly indent: number
    }
    export const resolve = (layout: AudioUnitLayout, rows: ReadonlyArray<Row>, pointer: Client,
                            horizontal: boolean): Option<Target> => {
        const coordinate = horizontal ? pointer.clientX : pointer.clientY
        const start = (bounds: Rect): number => horizontal ? bounds.x : bounds.y
        const size = (bounds: Rect): number => horizontal ? bounds.width : bounds.height
        const hit = rows.find(row => coordinate < start(row.bounds) + size(row.bounds)) ?? rows.at(-1)
        if (!isDefined(hit)) {return Option.None}
        const model = layout.row(hit.unit).unwrap()
        const headerOffset = coordinate - start(hit.header)
        const inside = model.isGroup && headerOffset > size(hit.header) * 0.25
            && headerOffset < size(hit.header) * 0.75
            && (horizontal || pointer.clientX >= hit.header.x && pointer.clientX < hit.header.x + hit.header.width)
        if (inside) {
            return Option.wrap({parent: hit.unit, before: undefined, row: hit, inside: true, after: false,
                indent: model.indent + AudioUnitLayout.Indent})
        }
        const bounds = model.isGroup ? hit.header : hit.bounds
        const after = coordinate >= start(bounds) + size(bounds) / 2
        let parent = model.parent
        if (!horizontal) {
            const depth = Math.max(0, Math.floor((pointer.clientX - hit.bounds.x - 12) / AudioUnitLayout.Indent))
            while (isDefined(parent) && layout.row(parent).unwrap().depth >= depth) {
                parent = layout.row(parent).unwrap().parent
            }
        }
        let sibling = hit.unit
        while (layout.row(sibling).unwrap().parent !== parent) {
            const next = layout.row(sibling).unwrap().parent
            if (!isDefined(next)) {break}
            sibling = next
        }
        const siblings = layout.rows.filter(row => row.parent === parent).map(row => row.unit)
        const before = after ? siblings[siblings.indexOf(sibling) + 1] : sibling
        let marker = rows.find(row => row.unit === before)
        if (!isDefined(marker)) {
            const boundary = layout.boundaries.find(span => span.unit === parent)
            const last = isDefined(boundary)
                ? rows.findLast(row => {
                    const index = layout.row(row.unit).unwrap().visibleIndex
                    return index >= boundary.start && index < boundary.end
                }) : rows.at(-1)
            if (!isDefined(last)) {return Option.None}
            marker = rows[rows.indexOf(last) + 1]
            if (!isDefined(marker)) {
                return Option.wrap({parent, before, row: last, inside: false, after: true,
                    indent: isDefined(parent) ? layout.row(parent).unwrap().indent + AudioUnitLayout.Indent : 0})
            }
        }
        return Option.wrap({parent, before, row: marker, inside: false, after: false,
            indent: isDefined(parent) ? layout.row(parent).unwrap().indent + AudioUnitLayout.Indent : 0})
    }
}

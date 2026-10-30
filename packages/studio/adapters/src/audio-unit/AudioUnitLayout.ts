import {asDefined, Optional, Option} from "@opendaw/lib-std"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitGroups} from "./AudioUnitGroups"

/** Immutable channel order and visibility, independent of either view. */
export class AudioUnitLayout {
    readonly rows: ReadonlyArray<AudioUnitLayout.Row>
    readonly visibleRows: ReadonlyArray<AudioUnitLayout.Row>
    readonly boundaries: ReadonlyArray<AudioUnitLayout.Boundary>
    readonly #byUnit: ReadonlyMap<AudioUnitBox, AudioUnitLayout.Row>
    constructor(root: RootBox) {
        const rows: AudioUnitLayout.Row[] = []
        const visible: AudioUnitLayout.Row[] = []
        const boundaries: AudioUnitLayout.Boundary[] = []
        const byUnit = new Map<AudioUnitBox, AudioUnitLayout.Row>()
        AudioUnitGroups.visit(root, (unit, ancestors) => {
            const hidden = ancestors.some(ancestor => byUnit.get(ancestor)?.collapsed)
            const depth = ancestors.length
            const row: AudioUnitLayout.Row = {
                unit, parent: ancestors.at(-1), ancestors, depth, indent: depth * AudioUnitLayout.Indent,
                order: rows.length, visibleIndex: hidden ? -1 : visible.length,
                collapsed: unit.groupCollapsed.getValue(), isGroup: unit.isGroup.getValue()
            }
            rows.push(row)
            byUnit.set(unit, row)
            if (!hidden) {visible.push(row)}
        })
        const stack: number[] = []
        visible.forEach(row => {
            while (stack.length > 0 && boundaries[stack[stack.length - 1]].depth >= row.depth) {
                const index = asDefined(stack.pop())
                boundaries[index] = {...boundaries[index], end: row.visibleIndex}
            }
            if (row.isGroup) {
                stack.push(boundaries.length)
                boundaries.push({unit: row.unit, start: row.visibleIndex, end: visible.length, depth: row.depth, indent: row.indent})
            }
        })
        this.rows = rows
        this.visibleRows = visible
        this.boundaries = boundaries
        this.#byUnit = byUnit
    }
    row(unit: AudioUnitBox): Option<AudioUnitLayout.Row> {return Option.wrap(this.#byUnit.get(unit))}
}

export namespace AudioUnitLayout {
    export const Indent = 5
    export const RailWidth = 4
    export type Row = {
        readonly unit: AudioUnitBox
        readonly parent: Optional<AudioUnitBox>
        readonly ancestors: ReadonlyArray<AudioUnitBox>
        readonly depth: number
        readonly indent: number
        readonly order: number
        readonly visibleIndex: number
        readonly collapsed: boolean
        readonly isGroup: boolean
    }
    export type Boundary = {
        readonly unit: AudioUnitBox
        readonly start: number
        readonly end: number
        readonly depth: number
        readonly indent: number
    }
}

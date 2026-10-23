import {isDefined, Optional, Option} from "@opendaw/lib-std"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitGroups} from "./AudioUnitGroups"

/** Immutable channel order and visibility, independent of either view. */
export class AudioUnitLayout {
    readonly rows: ReadonlyArray<AudioUnitLayout.Row>
    readonly visibleRows: ReadonlyArray<AudioUnitLayout.Row>
    readonly boundaries: ReadonlyArray<AudioUnitLayout.Boundary>
    readonly #byUnit: ReadonlyMap<AudioUnitBox, AudioUnitLayout.Row>
    constructor(root: RootBox) {
        const units = AudioUnitGroups.all(root)
        const members = new Set(units)
        const children = new Map<Optional<AudioUnitBox>, AudioUnitBox[]>()
        units.forEach(unit => {
            const candidate = AudioUnitGroups.parent(unit)
            const parent = isDefined(candidate) && members.has(candidate) ? candidate : undefined
            const siblings = children.get(parent) ?? []
            if (!children.has(parent)) {children.set(parent, siblings)}
            siblings.push(unit)
        })
        children.forEach(siblings => siblings.sort(AudioUnitGroups.compareCategories))
        const rows: AudioUnitLayout.Row[] = [], visible: AudioUnitLayout.Row[] = []
        const boundaries: AudioUnitLayout.Boundary[] = []
        const byUnit = new Map<AudioUnitBox, AudioUnitLayout.Row>()
        const visit = (unit: AudioUnitBox, ancestors: ReadonlyArray<AudioUnitBox>, hidden: boolean): void => {
            if (byUnit.has(unit)) {return}
            const depth = ancestors.length
            const row: AudioUnitLayout.Row = {
                unit, parent: ancestors.at(-1), ancestors, depth, indent: depth * AudioUnitLayout.Indent,
                order: rows.length, visibleIndex: hidden ? -1 : visible.length,
                collapsed: unit.groupCollapsed.getValue(), isGroup: unit.isGroup.getValue()
            }
            rows.push(row)
            byUnit.set(unit, row)
            if (!hidden) {visible.push(row)}
            const boundaryIndex = boundaries.length
            if (!hidden && row.isGroup) {
                boundaries.push({unit, start: row.visibleIndex, end: 0, depth, indent: row.indent})
            }
            children.get(unit)?.forEach(child => visit(child, [...ancestors, unit], hidden || row.collapsed && row.isGroup))
            if (!hidden && row.isGroup) {
                boundaries[boundaryIndex] = {...boundaries[boundaryIndex], end: visible.length}
            }
        }
        children.get(undefined)?.forEach(unit => visit(unit, [], false))
        units.forEach(unit => visit(unit, [], false))
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

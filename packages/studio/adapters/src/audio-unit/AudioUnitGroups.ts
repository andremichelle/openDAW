import {asDefined, Optional, isDefined} from "@opendaw/lib-std"
import {AudioUnitType} from "@opendaw/studio-enums"
import {IndexedBox} from "@opendaw/lib-box"
import {AudioBusBox, AudioUnitBox, RootBox} from "@opendaw/studio-boxes"

/** Folder membership is independent of audio routing. Indices are a depth-first display order. */
export namespace AudioUnitGroups {
    export const all = (root: RootBox): ReadonlyArray<AudioUnitBox> => IndexedBox.collectIndexedBoxes(root.audioUnits, AudioUnitBox)
    export const parent = (unit: AudioUnitBox): Optional<AudioUnitBox> => {
        const box = unit.groupParent.targetVertex.unwrapOrNull()?.box
        return box instanceof AudioUnitBox && box.isGroup.getValue() ? box : undefined
    }
    // Only Output has a fixed section; folders and other channels keep their saved positions.
    export const category = (unit: AudioUnitBox): number => unit.type.getValue() === AudioUnitType.Output ? 1 : 0
    export const compareCategories = (left: AudioUnitBox, right: AudioUnitBox): number => category(left) - category(right)
    export const children = (root: RootBox, group?: AudioUnitBox): AudioUnitBox[] =>
        (isDefined(group)
            ? IndexedBox.collectIndexedBoxes(group.groupChildren, AudioUnitBox).filter(unit => parent(unit) === group)
            : all(root).filter(unit => !isDefined(parent(unit)))).sort(compareCategories)
    export const ancestors = (unit: AudioUnitBox): AudioUnitBox[] => {
        const result: AudioUnitBox[] = []
        const seen = new Set([unit])
        for (let next = parent(unit); isDefined(next) && !seen.has(next); next = parent(next)) {
            seen.add(next)
            result.push(next)
        }
        return result
    }
    export const depth = (unit: AudioUnitBox): number => ancestors(unit).length
    export const hidden = (unit: AudioUnitBox): boolean => ancestors(unit).some(group => group.groupCollapsed.getValue())
    export const bus = (unit: AudioUnitBox): Optional<AudioBusBox> =>
        unit.input.pointerHub.incoming().map(pointer => pointer.box).find((box): box is AudioBusBox => box instanceof AudioBusBox)
    export const ordered = (root: RootBox): AudioUnitBox[] => {
        const units = all(root), result: AudioUnitBox[] = [], seen = new Set<AudioUnitBox>()
        const byParent = new Map<Optional<AudioUnitBox>, AudioUnitBox[]>()
        units.forEach(unit => {
            const key = parent(unit)
            const siblings = byParent.get(key) ?? []
            if (!byParent.has(key)) {byParent.set(key, siblings)}
            siblings.push(unit)
        })
        byParent.forEach(siblings => siblings.sort(compareCategories))
        const visit = (unit: AudioUnitBox): void => {
            if (seen.has(unit)) {return}
            seen.add(unit)
            result.push(unit)
            byParent.get(unit)?.forEach(visit)
        }
        byParent.get(undefined)?.forEach(visit)
        units.forEach(visit) // malformed imported membership must not lose tracks
        return result
    }
    export type Span = {unit: AudioUnitBox, start: number, end: number, depth: number}
    export const spans = (visible: ReadonlyArray<AudioUnitBox>): Span[] => {
        const result: Span[] = [], stack: Span[] = []
        visible.forEach((unit, index) => {
            const level = depth(unit)
            while (stack.length > 0 && stack[stack.length - 1].depth >= level) {
                asDefined(stack.pop()).end = index
            }
            if (unit.isGroup.getValue()) {
                const span = {unit, start: index, end: visible.length, depth: level}
                result.push(span)
                stack.push(span)
            }
        })
        return result
    }
    export const roots = (units: ReadonlyArray<AudioUnitBox>): AudioUnitBox[] => {
        const selected = new Set(units)
        return [...selected].filter(unit => !ancestors(unit).some(group => selected.has(group)))
    }
    export const subtree = (root: RootBox, unit: AudioUnitBox): AudioUnitBox[] => {
        const result: AudioUnitBox[] = [], seen = new Set<AudioUnitBox>()
        const visit = (child: AudioUnitBox): void => {
            if (seen.has(child)) {return}
            seen.add(child)
            result.push(child)
            children(root, child).forEach(visit)
        }
        visit(unit)
        return result
    }
}

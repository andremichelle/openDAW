import {isDefined, Option, Optional} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {AudioBusBox, AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"

/** Folder membership follows the primary output into a group bus. */
export namespace AudioUnitGroups {
    export const all = (root: RootBox): ReadonlyArray<AudioUnitBox> => IndexedBox.collectIndexedBoxes(root.audioUnits, AudioUnitBox)
    export const parent = (unit: AudioUnitBox): Option<AudioUnitBox> => {
        const output = unit.output.targetVertex.unwrapOrNull()?.box
        if (!(output instanceof AudioBusBox)) {return Option.None}
        const box = output.output.targetVertex.unwrapOrNull()?.box
        return box instanceof AudioUnitBox && box !== unit && box.isGroup.getValue() ? Option.wrap(box) : Option.None
    }
    // Only Output has a fixed section; folders and other channels keep their saved positions.
    export const category = (unit: AudioUnitBox): number => unit.type.getValue() === AudioUnitType.Output ? 1 : 0
    export const compareCategories = (left: AudioUnitBox, right: AudioUnitBox): number => category(left) - category(right)
    export const children = (root: RootBox, group?: AudioUnitBox): AudioUnitBox[] => {
        const members = isDefined(group) ? bus(group).mapOr(bus => bus.input.pointerHub.incoming().flatMap(pointer => {
            const box = pointer.box
            return box instanceof AudioUnitBox && pointer === box.output && parent(box).contains(group) ? [box] : []
        }), []).sort((left, right) => left.index.getValue() - right.index.getValue())
            : all(root).filter(unit => parent(unit).isEmpty())
        return members.sort(compareCategories)
    }
    export const ancestors = (unit: AudioUnitBox): AudioUnitBox[] => {
        const result: AudioUnitBox[] = []
        const seen = new Set([unit])
        for (let next = parent(unit).unwrapOrUndefined(); isDefined(next) && !seen.has(next); next = parent(next).unwrapOrUndefined()) {
            seen.add(next)
            result.push(next)
        }
        return result
    }
    export const depth = (unit: AudioUnitBox): number => ancestors(unit).length
    export const hidden = (unit: AudioUnitBox): boolean => ancestors(unit).some(group => group.groupCollapsed.getValue())
    export const bus = (unit: AudioUnitBox): Option<AudioBusBox> => Option.wrap(
        unit.input.pointerHub.incoming().map(pointer => pointer.box).find((box): box is AudioBusBox => box instanceof AudioBusBox))
    export const visit = (root: RootBox, visitor: (unit: AudioUnitBox, ancestors: ReadonlyArray<AudioUnitBox>) => void,
                          overrides: ReadonlyMap<Optional<AudioUnitBox>, ReadonlyArray<AudioUnitBox>> = new Map()): void => {
        const units = all(root)
        const members = new Set(units)
        const byParent = new Map<Optional<AudioUnitBox>, AudioUnitBox[]>()
        const seen = new Set<AudioUnitBox>()
        units.forEach(unit => {
            const candidate = parent(unit).unwrapOrUndefined()
            const key = isDefined(candidate) && members.has(candidate) ? candidate : undefined
            const siblings = byParent.get(key) ?? []
            if (!byParent.has(key)) {byParent.set(key, siblings)}
            siblings.push(unit)
        })
        byParent.forEach(siblings => siblings.sort(compareCategories))
        const walk = (unit: AudioUnitBox, ancestors: ReadonlyArray<AudioUnitBox>): void => {
            if (seen.has(unit)) {return}
            seen.add(unit)
            visitor(unit, ancestors)
            const children = overrides.get(unit) ?? byParent.get(unit)
            children?.forEach(child => walk(child, [...ancestors, unit]))
        }
        const roots = overrides.get(undefined) ?? byParent.get(undefined)
        roots?.forEach(unit => walk(unit, []))
        units.forEach(unit => walk(unit, [])) // malformed imported routes must not lose tracks
    }
    export const ordered = (root: RootBox): AudioUnitBox[] => {
        const result: AudioUnitBox[] = []
        visit(root, unit => result.push(unit))
        return result
    }
    export const roots = (units: ReadonlyArray<AudioUnitBox>): AudioUnitBox[] => {
        const selected = new Set(units)
        return [...selected].filter(unit => !ancestors(unit).some(group => selected.has(group)))
    }
    export const subtree = (root: RootBox, unit: AudioUnitBox): AudioUnitBox[] => {
        const result: AudioUnitBox[] = []
        const seen = new Set<AudioUnitBox>()
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

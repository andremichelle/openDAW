import {IndexedBox} from "@opendaw/lib-box"
import {AudioBusBox, AudioUnitBox, RootBox} from "@opendaw/studio-boxes"

/** Folder membership is independent of audio routing. Indices are a depth-first display order. */
export namespace AudioUnitGroups {
    export const all = (root: RootBox): ReadonlyArray<AudioUnitBox> => IndexedBox.collectIndexedBoxes(root.audioUnits, AudioUnitBox)
    export const parent = (unit: AudioUnitBox): AudioUnitBox | undefined => {
        const box = unit.groupParent.targetVertex.unwrapOrNull()?.box
        return box instanceof AudioUnitBox && box.isGroup.getValue() ? box : undefined
    }
    export const children = (root: RootBox, group?: AudioUnitBox): AudioUnitBox[] =>
        all(root).filter(unit => parent(unit) === group)
    export const ancestors = (unit: AudioUnitBox): AudioUnitBox[] => {
        const result: AudioUnitBox[] = []
        const seen = new Set([unit])
        for (let next = parent(unit); next && !seen.has(next); next = parent(next)) {
            seen.add(next)
            result.push(next)
        }
        return result
    }
    export const depth = (unit: AudioUnitBox): number => ancestors(unit).length
    export const hidden = (unit: AudioUnitBox): boolean => ancestors(unit).some(group => group.groupCollapsed.getValue())
    export const bus = (unit: AudioUnitBox): AudioBusBox | undefined =>
        unit.input.pointerHub.incoming().map(pointer => pointer.box).find((box): box is AudioBusBox => box instanceof AudioBusBox)
    export const ordered = (root: RootBox): AudioUnitBox[] => {
        const units = all(root), result: AudioUnitBox[] = [], seen = new Set<AudioUnitBox>()
        const visit = (unit: AudioUnitBox): void => {
            if (seen.has(unit)) {return}
            seen.add(unit)
            result.push(unit)
            units.filter(child => parent(child) === unit).forEach(visit)
        }
        units.filter(unit => !parent(unit)).forEach(visit)
        units.forEach(visit) // malformed imported membership must not lose tracks
        return result
    }
    export const roots = (units: ReadonlyArray<AudioUnitBox>): AudioUnitBox[] => {
        const selected = new Set(units)
        return [...selected].filter(unit => !ancestors(unit).some(group => selected.has(group)))
    }
    export const subtree = (root: RootBox, unit: AudioUnitBox): AudioUnitBox[] =>
        ordered(root).filter(candidate => candidate === unit || ancestors(candidate).includes(unit))
}

import {AudioBusFactory, AudioUnitGroups, TransferAudioUnits} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import type {Project} from "./Project"

/** Call mutations inside one editing.modify transaction. */
export class AudioUnitGrouping {
    constructor(readonly project: Project) {}

    canMove(units: ReadonlyArray<AudioUnitBox>, parent?: AudioUnitBox): boolean {
        if (units.length === 0 || units.some(unit => !unit.isAttached() || unit.type.getValue() === AudioUnitType.Output)) {return false}
        if (parent && (!parent.isAttached() || !parent.isGroup.getValue())) {return false}
        const roots = AudioUnitGroups.roots(units)
        if (parent && roots.some(unit => unit === parent || AudioUnitGroups.ancestors(parent).includes(unit))) {return false}
        // Follow primary routes and sends from the destination: adding a route must never feed itself.
        const visited = new Set<AudioUnitBox>()
        const reachesSource = (unit: AudioUnitBox): boolean => {
            if (roots.includes(unit)) {return true}
            if (visited.has(unit)) {return false}
            visited.add(unit)
            const pointers = [unit.output, ...unit.auxSends.pointerHub.incoming().map(pointer =>
                (pointer.box as import("@opendaw/studio-boxes").AuxSendBox).targetBus)]
            return pointers.some(pointer => {
                const bus = pointer.targetVertex.unwrapOrNull()?.box
                if (!bus || bus.name !== "AudioBusBox") {return false}
                const target = (bus as import("@opendaw/studio-boxes").AudioBusBox).output.targetVertex.unwrapOrNull()?.box
                return target instanceof AudioUnitBox && reachesSource(target)
            })
        }
        return !parent || !reachesSource(parent)
    }

    create(units: ReadonlyArray<AudioUnitBox>): AudioUnitBox | undefined {
        const {rootBox, skeleton} = this.project
        const selected = AudioUnitGroups.ordered(rootBox).filter(unit => AudioUnitGroups.roots(units).includes(unit))
        if (!this.canMove(selected)) {return undefined}
        let parent = AudioUnitGroups.parent(selected[0])
        while (parent && !selected.every(unit => AudioUnitGroups.ancestors(unit).includes(parent!))) {
            parent = AudioUnitGroups.parent(parent)
        }
        let anchor = selected[0]
        while (AudioUnitGroups.parent(anchor) !== parent) {anchor = AudioUnitGroups.parent(anchor)!}
        const bus = AudioBusFactory.create(skeleton, "Group", IconSymbol.Folder, AudioUnitType.Bus, Colors.blue,
            parent ? AudioUnitGroups.bus(parent) : undefined)
        const group = bus.output.targetVertex.unwrap().box as AudioUnitBox
        group.isGroup.setValue(true)
        group.volume.setValue(0) // unity gain: grouping alone must not change the level
        this.move([group], parent, anchor)
        this.move(selected, group)
        return group
    }

    move(units: ReadonlyArray<AudioUnitBox>, parent?: AudioUnitBox, before?: AudioUnitBox): boolean {
        const {rootBox, primaryAudioBusBox} = this.project
        const moving = AudioUnitGroups.ordered(rootBox).filter(unit => AudioUnitGroups.roots(units).includes(unit))
        if (!this.canMove(moving, parent)) {return false}
        if (before && AudioUnitGroups.parent(before) !== parent) {return false}
        const destination = parent ? AudioUnitGroups.bus(parent) : primaryAudioBusBox
        if (!destination) {return false}
        const siblings = AudioUnitGroups.children(rootBox, parent).filter(unit => !moving.includes(unit))
        if (before && moving.includes(before)) {return false}
        const slot = before ? siblings.indexOf(before) : siblings.findIndex(unit => unit.type.getValue() === AudioUnitType.Output)
        siblings.splice(slot < 0 ? siblings.length : slot, 0, ...moving)
        moving.forEach(unit => {
            const changedParent = AudioUnitGroups.parent(unit) !== parent
            parent ? unit.groupParent.refer(parent.groupChildren) : unit.groupParent.defer()
            if (changedParent) {unit.output.refer(destination.input)}
        })
        const ordered: AudioUnitBox[] = []
        const append = (unit: AudioUnitBox): void => {
            ordered.push(unit)
            AudioUnitGroups.children(rootBox, unit).forEach(append)
        }
        const top = parent ? AudioUnitGroups.children(rootBox) : siblings
        const walk = (unit: AudioUnitBox): void => {
            ordered.push(unit)
            const children = unit === parent ? siblings : AudioUnitGroups.children(rootBox, unit)
            children.forEach(walk)
        }
        if (parent) {top.forEach(walk)} else {top.forEach(append)}
        ordered.forEach((unit, index) => unit.index.setValue(index))
        return true
    }

    /** Duplicate each sibling selection as one block after its last source, preserving folder membership. */
    duplicate(units: ReadonlyArray<AudioUnitBox>): AudioUnitBox[] {
        const {rootBox, skeleton} = this.project
        const ordered = AudioUnitGroups.ordered(rootBox)
        const selected = new Set(AudioUnitGroups.roots(units))
        const roots = ordered.filter(unit => selected.has(unit) && unit.type.getValue() !== AudioUnitType.Output)
        if (roots.length === 0) {return []}
        // Snapshot the tree before cloning: new-box pointers settle at transaction end, so do not query
        // the new hierarchy to place its rows in the same transaction.
        const children = new Map<AudioUnitBox | undefined, AudioUnitBox[]>([
            [undefined, AudioUnitGroups.children(rootBox)],
            ...ordered.map(unit => [unit, AudioUnitGroups.children(rootBox, unit)] as [AudioUnitBox, AudioUnitBox[]])
        ])
        const expanded = roots.flatMap(unit => AudioUnitGroups.subtree(rootBox, unit))
        const copies = TransferAudioUnits.transfer(roots, skeleton, {preserveExternalConnections: true})
        const mapping = new Map(expanded.map((source, index) => [source, copies[index]]))
        expanded.forEach(source => children.set(mapping.get(source)!, children.get(source)!.map(child => mapping.get(child)!)))
        const parents = new Set(roots.map(unit => AudioUnitGroups.parent(unit)))
        parents.forEach(parent => {
            const siblings = children.get(parent)!
            const last = siblings.findLastIndex(unit => roots.includes(unit))
            const block = roots.filter(unit => AudioUnitGroups.parent(unit) === parent).map(unit => mapping.get(unit)!)
            siblings.splice(last + 1, 0, ...block)
        })
        let index = 0
        const walk = (parent?: AudioUnitBox): void => children.get(parent)?.forEach(unit => {
            unit.index.setValue(index++)
            walk(unit)
        })
        walk()
        return roots.map(unit => mapping.get(unit)!)
    }

    deleteGroup(group: AudioUnitBox): void {
        if (!group.isAttached() || !group.isGroup.getValue()) {return}
        const {rootBox} = this.project
        // Delete leaves before their parents so folder membership cannot promote surviving children.
        AudioUnitGroups.subtree(rootBox, group).toReversed().forEach(unit => unit.delete())
        AudioUnitGroups.ordered(rootBox).forEach((unit, index) => unit.index.setValue(index))
    }

    ungroup(group: AudioUnitBox): void {
        if (!group.isAttached() || !group.isGroup.getValue()) {return}
        const {rootBox} = this.project
        const parent = AudioUnitGroups.parent(group)
        this.move(AudioUnitGroups.children(rootBox, group), parent, group)
        group.delete()
        AudioUnitGroups.ordered(rootBox).forEach((unit, index) => unit.index.setValue(index))
    }
}

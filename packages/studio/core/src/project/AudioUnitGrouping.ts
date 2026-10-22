import {AudioBusFactory, AudioUnitGroups, TransferAudioUnits} from "@opendaw/studio-adapters"
import {asDefined, asInstanceOf, isDefined, Optional} from "@opendaw/lib-std"
import {AudioBusBox, AuxSendBox, AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import type {Project} from "./Project"

/** Call mutations inside one editing.modify transaction. */
export class AudioUnitGrouping {
    constructor(readonly project: Project) {}

    canMove(units: ReadonlyArray<AudioUnitBox>, parent?: AudioUnitBox, before?: AudioUnitBox): boolean {
        if (units.length === 0 || units.some(unit => !unit.isAttached() || unit.type.getValue() === AudioUnitType.Output)) {return false}
        if (isDefined(parent) && (!parent.isAttached() || !parent.isGroup.getValue())) {return false}
        const roots = AudioUnitGroups.roots(units)
        if (isDefined(before) && (!before.isAttached() || AudioUnitGroups.parent(before) !== parent || roots.includes(before))) {return false}
        if (isDefined(parent) && roots.some(unit => unit === parent || AudioUnitGroups.ancestors(parent).includes(unit))) {return false}
        // Follow primary routes and sends from the destination: adding a route must never feed itself.
        const visited = new Set<AudioUnitBox>()
        const reachesSource = (unit: AudioUnitBox): boolean => {
            if (roots.includes(unit)) {return true}
            if (visited.has(unit)) {return false}
            visited.add(unit)
            const pointers = [unit.output, ...unit.auxSends.pointerHub.incoming().map(pointer =>
                asInstanceOf(pointer.box, AuxSendBox).targetBus)]
            return pointers.some(pointer => {
                const bus = pointer.targetVertex.unwrapOrNull()?.box
                if (!(bus instanceof AudioBusBox)) {return false}
                const target = bus.output.targetVertex.unwrapOrNull()?.box
                return target instanceof AudioUnitBox && reachesSource(target)
            })
        }
        return !isDefined(parent) || !reachesSource(parent)
    }

    /** Boundary drops must retain their exact sibling slot. */
    canDrop(units: ReadonlyArray<AudioUnitBox>, parent?: AudioUnitBox, before?: AudioUnitBox): boolean {
        if (!this.canMove(units, parent, before)) {return false}
        const roots = AudioUnitGroups.roots(units)
        const siblings = AudioUnitGroups.children(this.project.rootBox, parent).filter(unit => !roots.includes(unit))
        const index = isDefined(before) ? siblings.indexOf(before) : siblings.length
        const previous = siblings[index - 1], next = siblings[index]
        const categories = roots.map(AudioUnitGroups.category)
        return (!isDefined(previous) || AudioUnitGroups.category(previous) <= Math.min(...categories))
            && (!isDefined(next) || Math.max(...categories) <= AudioUnitGroups.category(next))
    }

    create(units: ReadonlyArray<AudioUnitBox>): Optional<AudioUnitBox> {
        const {rootBox, skeleton} = this.project
        const roots = new Set(AudioUnitGroups.roots(units))
        const selected = AudioUnitGroups.ordered(rootBox).filter(unit => roots.has(unit))
        if (!this.canMove(selected)) {return undefined}
        let parent = AudioUnitGroups.parent(selected[0])
        while (isDefined(parent) && !selected.every(unit => AudioUnitGroups.ancestors(unit).includes(asDefined(parent)))) {
            parent = AudioUnitGroups.parent(parent)
        }
        let anchor = selected[0]
        while (AudioUnitGroups.parent(anchor) !== parent) {anchor = asDefined(AudioUnitGroups.parent(anchor))}
        const bus = AudioBusFactory.create(skeleton, "Group", IconSymbol.Folder, AudioUnitType.Bus, Colors.blue,
            isDefined(parent) ? AudioUnitGroups.bus(parent) : undefined)
        const group = asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox)
        group.isGroup.setValue(true)
        group.volume.setValue(0) // unity gain: grouping alone must not change the level
        this.move([group], parent, anchor)
        this.move(selected, group)
        return group
    }

    move(units: ReadonlyArray<AudioUnitBox>, parent?: AudioUnitBox, before?: AudioUnitBox): boolean {
        const {rootBox, primaryAudioBusBox} = this.project
        const roots = new Set(AudioUnitGroups.roots(units))
        const moving = AudioUnitGroups.ordered(rootBox).filter(unit => roots.has(unit))
        if (!this.canMove(moving, parent, before)) {return false}
        const destination = isDefined(parent) ? AudioUnitGroups.bus(parent) : primaryAudioBusBox
        if (!isDefined(destination)) {return false}
        const siblings = AudioUnitGroups.children(rootBox, parent).filter(unit => !moving.includes(unit))
        const slot = isDefined(before) ? siblings.indexOf(before) : siblings.findIndex(unit => unit.type.getValue() === AudioUnitType.Output)
        const outputIndex = siblings.findIndex(unit => unit.type.getValue() === AudioUnitType.Output)
        const position = slot < 0 ? siblings.length : slot
        siblings.splice(outputIndex < 0 ? position : Math.min(position, outputIndex), 0, ...moving)
        siblings.sort(AudioUnitGroups.compareCategories)
        moving.forEach(unit => {
            const previous = AudioUnitGroups.parent(unit)
            const previousBus = isDefined(previous) ? AudioUnitGroups.bus(previous) : primaryAudioBusBox
            const followsParent = unit.output.targetVertex.unwrapOrUndefined()?.box === previousBus
            const changedParent = previous !== parent
            isDefined(parent) ? unit.groupParent.refer(parent.groupChildren) : unit.groupParent.defer()
            if (changedParent && followsParent) {unit.output.refer(destination.input)}
        })
        const ordered: AudioUnitBox[] = []
        const append = (unit: AudioUnitBox): void => {
            ordered.push(unit)
            AudioUnitGroups.children(rootBox, unit).forEach(append)
        }
        const top = isDefined(parent) ? AudioUnitGroups.children(rootBox) : siblings
        const walk = (unit: AudioUnitBox): void => {
            ordered.push(unit)
            const children = unit === parent ? siblings : AudioUnitGroups.children(rootBox, unit)
            children.forEach(walk)
        }
        if (isDefined(parent)) {top.forEach(walk)} else {top.forEach(append)}
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
        // New-box pointers settle at transaction end; placement uses the original tree.
        const children = new Map<Optional<AudioUnitBox>, AudioUnitBox[]>([
            [undefined, AudioUnitGroups.children(rootBox)],
            ...ordered.map(unit => [unit, AudioUnitGroups.children(rootBox, unit)] as [AudioUnitBox, AudioUnitBox[]])
        ])
        const expanded = roots.flatMap(unit => AudioUnitGroups.subtree(rootBox, unit))
        const copies = TransferAudioUnits.transfer(roots, skeleton, {preserveExternalConnections: true})
        const mapping = new Map(expanded.map((source, index) => [source, copies[index]]))
        expanded.forEach(source => children.set(asDefined(mapping.get(source)), asDefined(children.get(source)).map(child => asDefined(mapping.get(child)))))
        const parents = new Set(roots.map(unit => AudioUnitGroups.parent(unit)))
        parents.forEach(parent => {
            const siblings = asDefined(children.get(parent))
            const categories = new Set(roots.filter(unit => AudioUnitGroups.parent(unit) === parent).map(AudioUnitGroups.category))
            categories.forEach(category => {
                const sources = roots.filter(unit => AudioUnitGroups.parent(unit) === parent && AudioUnitGroups.category(unit) === category)
                const last = siblings.findLastIndex(unit => sources.includes(unit))
                siblings.splice(last + 1, 0, ...sources.map(unit => asDefined(mapping.get(unit))))
            })
        })
        let index = 0
        const walk = (parent?: AudioUnitBox): void => children.get(parent)?.forEach(unit => {
            unit.index.setValue(index++)
            walk(unit)
        })
        walk()
        return roots.map(unit => asDefined(mapping.get(unit)))
    }

    moveOutOfGroup(unit: AudioUnitBox, selection: ReadonlyArray<AudioUnitBox> = [unit]): boolean {
        const parent = AudioUnitGroups.parent(unit)
        if (!isDefined(parent)) {return false}
        const outer = AudioUnitGroups.parent(parent)
        const siblings = AudioUnitGroups.children(this.project.rootBox, outer)
        const members = selection.filter(selected => AudioUnitGroups.parent(selected) === parent)
        return this.move(members, outer, siblings[siblings.indexOf(parent) + 1])
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

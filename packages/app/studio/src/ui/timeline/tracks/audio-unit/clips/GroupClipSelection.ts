import {EmptyExec, int, MutableObservableOption, Terminable, Terminator} from "@opendaw/lib-std"
import {UnionBoxTypes} from "@opendaw/studio-adapters"
import type {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"

/** A group column is a UI selection, not a clip box or a selection of its descendant clips. */
export class GroupClipSelection implements Terminable {
    readonly value = new MutableObservableOption<{unit: AudioUnitBox, index: int}>()
    readonly #lifecycle = new Terminator()
    readonly #selectedUnit = this.#lifecycle.own(new Terminator())
    constructor(readonly project: Project) {
        this.#lifecycle.ownAll(this.value, project.selection.subscribe({
            onSelected: vertex => {if (UnionBoxTypes.isClipBox(vertex.box)) {this.clear()}},
            onDeselected: EmptyExec
        }))
    }
    select(unit: AudioUnitBox, index: int): void {
        if (!unit.isAttached() || !unit.isGroup.getValue()) {return}
        this.project.selection.deselect(...this.project.selection.selected()
            .filter(vertex => UnionBoxTypes.isClipBox(vertex.box)))
        this.#selectedUnit.terminate()
        this.#selectedUnit.own(unit.subscribeDeletion(() => this.clear()))
        this.value.wrap({unit, index})
    }
    isSelected(unit: AudioUnitBox, index: int): boolean {
        return this.value.mapOr(selected => selected.unit === unit && selected.index === index, false)
    }
    clear(): void {
        this.#selectedUnit.terminate()
        this.value.clear()
    }
    terminate(): void {this.#lifecycle.terminate()}
}

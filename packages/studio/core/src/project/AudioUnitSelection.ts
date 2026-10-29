import {DefaultObservableValue, isDefined, Optional, Terminator} from "@opendaw/lib-std"
import {Devices} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import type {Project} from "./Project"

/** Track selection is local UI state, separate from clip/device selection and the active editor. */
export class AudioUnitSelection {
    readonly value: DefaultObservableValue<ReadonlyArray<AudioUnitBox>>
    readonly #subscriptions: Terminator
    #anchor: Optional<AudioUnitBox>
    constructor(readonly project: Project) {
        this.value = new DefaultObservableValue<ReadonlyArray<AudioUnitBox>>([])
        this.#subscriptions = new Terminator()
        this.#anchor = undefined
    }
    get hasExplicitSelection(): boolean {return this.selected.length > 0}
    get selected(): ReadonlyArray<AudioUnitBox> {return this.value.getValue().filter(unit => unit.isAttached())}
    get commandTargets(): ReadonlyArray<AudioUnitBox> {
        const selected = this.selected
        if (selected.length > 0) {return selected}
        return this.project.userEditingManager.audioUnit.get().mapOr(vertex => {
            const unit = this.project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box
            return unit.isAttached() && unit.type.getValue() !== AudioUnitType.Output ? [unit] : []
        }, [])
    }
    has(unit: AudioUnitBox): boolean {return this.selected.includes(unit)}
    isHighlighted(unit: AudioUnitBox): boolean {
        const selected = this.selected
        if (selected.length > 0) {return selected.includes(unit)}
        return this.isEdited(unit)
    }
    isEdited(unit: AudioUnitBox): boolean {
        return this.project.userEditingManager.audioUnit.get().mapOr(vertex =>
            this.project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box === unit, false)
    }
    isLineHighlighted(unit: AudioUnitBox): boolean {
        return this.project.userEditingManager.audioUnit.get().mapOr(vertex => {
            const edited = this.project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box
            return edited === unit || this.project.audioUnitLayout.snapshot.row(edited)
                .mapOr(row => row.ancestors.includes(unit), false)
        }, false)
    }
    set(units: ReadonlyArray<AudioUnitBox>): void {
        this.#subscriptions.terminate()
        const next = [...new Set(units)].filter(unit => unit.isAttached() && unit.type.getValue() !== AudioUnitType.Output)
        next.forEach(unit => this.#subscriptions.own(unit.subscribeDeletion(() => this.set(this.selected.filter(item => item !== unit)))))
        if (isDefined(this.#anchor) && !next.includes(this.#anchor)) {this.#anchor = undefined}
        this.value.setValue(next)
    }
    click(unit: AudioUnitBox, {shiftKey, metaKey, ctrlKey}: {shiftKey: boolean, metaKey: boolean, ctrlKey: boolean}): void {
        const order = this.project.audioUnitLayout.snapshot.visibleRows.map(row => row.unit)
        const anchorIndex = isDefined(this.#anchor) ? order.indexOf(this.#anchor) : -1
        const end = order.indexOf(unit)
        if (shiftKey && anchorIndex >= 0 && end >= 0) {
            const range = order.slice(Math.min(anchorIndex, end), Math.max(anchorIndex, end) + 1)
            this.set(metaKey || ctrlKey ? [...this.selected, ...range] : range)
        } else if (metaKey || ctrlKey) {
            this.set(this.has(unit) ? this.selected.filter(item => item !== unit) : [...this.selected, unit])
            this.#anchor = this.has(unit) ? unit : undefined
        } else {
            this.set([unit])
            this.#anchor = unit
        }
    }
    terminate(): void {this.#subscriptions.terminate(); this.value.terminate()}
}

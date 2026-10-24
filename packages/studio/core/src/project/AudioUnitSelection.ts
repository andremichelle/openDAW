import {DefaultObservableValue, isDefined, Optional, Terminator} from "@opendaw/lib-std"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Devices} from "@opendaw/studio-adapters"
import {AudioUnitType} from "@opendaw/studio-enums"
import type {Project} from "./Project"

/** Track selection is local UI state, separate from clip/device selection and the active editor. */
export class AudioUnitSelection {
    readonly value: DefaultObservableValue<ReadonlyArray<AudioUnitBox>>
    readonly #subscriptions: Terminator
    #anchor: Optional<AudioUnitBox>
    #hasExplicitSelection = false
    constructor(readonly project: Project) {
        this.value = new DefaultObservableValue<ReadonlyArray<AudioUnitBox>>([])
        this.#subscriptions = new Terminator()
    }
    get hasExplicitSelection(): boolean {return this.#hasExplicitSelection}
    get selected(): ReadonlyArray<AudioUnitBox> {return this.value.getValue().filter(unit => unit.isAttached())}
    has(unit: AudioUnitBox): boolean {return this.selected.includes(unit)}
    isHighlighted(unit: AudioUnitBox): boolean {
        const selected = this.selected
        if (selected.length > 0) {return selected.includes(unit)}
        return this.project.userEditingManager.audioUnit.get().mapOr(vertex =>
            this.project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box === unit, false)
    }
    set(units: ReadonlyArray<AudioUnitBox>): void {
        this.#hasExplicitSelection = true
        this.#subscriptions.terminate()
        const next = [...new Set(units)].filter(unit => unit.isAttached() && unit.type.getValue() !== AudioUnitType.Output)
        next.forEach(unit => this.#subscriptions.own(unit.subscribeDeletion(() => this.set(this.selected.filter(item => item !== unit)))))
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
            this.#anchor = unit
        } else {
            this.set([unit])
            this.#anchor = unit
        }
    }
    terminate(): void {this.#subscriptions.terminate(); this.value.terminate()}
}

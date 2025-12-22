import {Subscription} from "./terminable"
import {int} from "./lang"

export type Coordinates<U, V> = { u: U, v: V }

export interface Selectable {
    onSelected(): void
    onDeselected(): void
}

export interface SelectionListener<SELECTABLE> {
    onSelected(selectable: SELECTABLE): void
    onDeselected(selectable: SELECTABLE): void
}

export interface Selection<SELECTABLE> {
    select(...selectables: Array<SELECTABLE>): void
    deselect(...selectables: Array<SELECTABLE>): void
    deselectAll(): void
    isSelected(selectable: SELECTABLE): boolean
    isEmpty(): boolean
    nonEmpty(): boolean
    count(): int
    selected(): ReadonlyArray<SELECTABLE>
    distance(inventory: ReadonlyArray<SELECTABLE>): ReadonlyArray<SELECTABLE>
    subscribe(listener: SelectionListener<SELECTABLE>): Subscription
    catchupAndSubscribe(listener: SelectionListener<SELECTABLE>): Subscription
}

export interface SelectableLocator<SELECTABLE, U, V> {
    selectableAt(coordinates: Coordinates<U, V>): Iterable<SELECTABLE>
    selectablesBetween(selectionBegin: Coordinates<U, V>, selectionEnd: Coordinates<U, V>): Iterable<SELECTABLE>
    selectable(): Iterable<SELECTABLE>
}
import {Provider} from "@opendaw/lib-std"

export interface ResourceSelection<T> {
    requestDevice(): void
    selected(): ReadonlyArray<T>
    deleteItems(items: ReadonlyArray<T>): Promise<ReadonlyArray<T>>
}

// A right click acts on the selection when the clicked row is part of it, and on that row alone otherwise,
// which is what every file manager does.
export const contextTargets = <T>(element: Element,
                                  item: T,
                                  selected: Provider<ReadonlyArray<T>>): ReadonlyArray<T> =>
    element.classList.contains("selected") ? selected() : [item]

export const truncateList = (items: ReadonlyArray<string>, limit: number = 3): string =>
    items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")}, ...`

// What the browser renders: folders holding folders and items, in authored order. The browser never learns
// where the structure came from, so a published index and a locally derived grouping render identically.
export type ResourceFolder<T> = {
    readonly name: string
    readonly folders: ReadonlyArray<ResourceFolder<T>>
    readonly items: ReadonlyArray<T>
}

export namespace ResourceFolder {
    export const flatten = <T>(folder: ResourceFolder<T>): ReadonlyArray<T> => {
        const items: Array<T> = []
        const collect = (current: ResourceFolder<T>): void => {
            items.push(...current.items)
            current.folders.forEach(collect)
        }
        collect(folder)
        return items
    }

    export const countItems = <T>(folder: ResourceFolder<T>): number =>
        folder.items.length + folder.folders.reduce((sum, sub) => sum + countItems(sub), 0)
}

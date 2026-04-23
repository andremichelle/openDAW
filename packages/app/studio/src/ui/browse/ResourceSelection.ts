export interface ResourceSelection {
    deleteSelected(): Promise<void>
    requestDevice(): void
}

export const truncateList = (items: ReadonlyArray<string>, limit: number = 3): string =>
    items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")}, ...`
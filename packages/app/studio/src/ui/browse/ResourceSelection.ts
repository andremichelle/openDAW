export interface ResourceSelection {
    deleteSelected(): Promise<void>
    requestDevice(): void
}
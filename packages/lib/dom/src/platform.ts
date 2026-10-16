import {isDefined, Nullable, Option, Provider} from "@opendaw/lib-std"
import {Browser} from "./browser"
import {FilesBrowser} from "./files-browser"

export namespace Platform {
    export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">

    export interface Strategies {
        isDevelopment(): boolean
        hasStorage(): boolean
        storage(): KeyValueStore
        saveFile(arrayBuffer: ArrayBuffer, options?: SaveFilePickerOptions): Promise<string>
        openFiles(options?: OpenFilePickerOptions): Promise<ReadonlyArray<File>>
        canSaveStream(): boolean
        saveStream(options: SaveFilePickerOptions): Promise<Option<WritableStream>>
        writeClipboardText(text: string): Promise<void>
        readClipboardText(): Promise<string>
        isFullscreenAvailable(element: Element): boolean
        requestFullscreen(element: Element): Promise<void>
        fullscreenElement(document: Document): Nullable<Element>
        exitFullscreen(document: Document): Promise<void>
        alert(message: string): void
        reload(): void
        guardClose(hasUnsavedWork: Provider<boolean>): void
        openAuthWindow(url: string, target: string): Nullable<Pick<Window, "close">>
    }

    const browser: Strategies = {
        isDevelopment: () => Browser.isLocalHost(),
        hasStorage: () => typeof localStorage !== "undefined",
        storage: () => localStorage,
        saveFile: FilesBrowser.save,
        openFiles: FilesBrowser.open,
        canSaveStream: FilesBrowser.canSaveStream,
        saveStream: FilesBrowser.saveStream,
        writeClipboardText: (text: string) => navigator.clipboard.writeText(text),
        readClipboardText: () => navigator.clipboard.readText(),
        isFullscreenAvailable: (element: Element) =>
            element.ownerDocument.fullscreenEnabled && isDefined(element.requestFullscreen),
        requestFullscreen: (element: Element) => element.requestFullscreen(),
        fullscreenElement: (document: Document) => document.fullscreenElement,
        exitFullscreen: (document: Document) => document.exitFullscreen(),
        alert: (message: string) => window.alert(message),
        reload: () => location.reload(),
        // offline, a reload would not bring the page back
        guardClose: (hasUnsavedWork: Provider<boolean>) => window.addEventListener("beforeunload", (event: Event) => {
            if (!navigator.onLine || hasUnsavedWork()) {event.preventDefault()}
        }),
        openAuthWindow: (url: string, target: string) => window.open(url, target)
    }

    const installed: Strategies = {...browser}

    export const install = (strategies: Partial<Strategies>): void => {Object.assign(installed, strategies)}

    export const isDevelopment = (): boolean => installed.isDevelopment()
    export const hasStorage = (): boolean => installed.hasStorage()
    export const storage = (): KeyValueStore => installed.storage()
    export const saveFile = (arrayBuffer: ArrayBuffer, options?: SaveFilePickerOptions): Promise<string> =>
        installed.saveFile(arrayBuffer, options)
    export const openFiles = (options?: OpenFilePickerOptions): Promise<ReadonlyArray<File>> => installed.openFiles(options)
    export const canSaveStream = (): boolean => installed.canSaveStream()
    export const saveStream = (options: SaveFilePickerOptions): Promise<Option<WritableStream>> =>
        installed.saveStream(options)
    export const writeClipboardText = (text: string): Promise<void> => installed.writeClipboardText(text)
    export const readClipboardText = (): Promise<string> => installed.readClipboardText()
    export const isFullscreenAvailable = (element: Element): boolean => installed.isFullscreenAvailable(element)
    export const requestFullscreen = (element: Element): Promise<void> => installed.requestFullscreen(element)
    export const fullscreenElement = (document: Document): Nullable<Element> => installed.fullscreenElement(document)
    export const exitFullscreen = (document: Document): Promise<void> => installed.exitFullscreen(document)
    export const alert = (message: string): void => installed.alert(message)
    export const reload = (): void => installed.reload()
    export const guardClose = (hasUnsavedWork: Provider<boolean>): void => installed.guardClose(hasUnsavedWork)
    export const openAuthWindow = (url: string, target: string): Nullable<Pick<Window, "close">> =>
        installed.openAuthWindow(url, target)
}

import {isDefined, Option, tryCatch} from "@opendaw/lib-std"

// the last zoom of a plugin's window, by CLAP id, so every window of it opens where the user left it
export namespace WclapZoomMemory {
    const Key = "wclap-zoom"

    type Zooms = Record<string, number>

    const isZooms = (value: unknown): value is Zooms => typeof value === "object" && isDefined(value)
        && !Array.isArray(value) && Object.values(value).every(zoom => typeof zoom === "number" && zoom > 0)

    const read = (): Zooms => {
        const result = tryCatch(() => JSON.parse(localStorage.getItem(Key) ?? "{}") as unknown)
        return result.status === "success" && isZooms(result.value) ? result.value : {}
    }

    export const get = (clapId: string): Option<number> => Option.wrap(read()[clapId])

    export const set = (clapId: string, zoom: number): void => {
        tryCatch(() => localStorage.setItem(Key, JSON.stringify({...read(), [clapId]: zoom})))
    }
}

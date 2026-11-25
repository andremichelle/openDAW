import {Bytes, Exec, int, RuntimeNotifier, Terminable, TimeSpan} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {RouteLocation} from "@opendaw/lib-jsx"
import {AssetCache, OpfsQuota} from "@opendaw/studio-core"

export namespace StorageFull {
    const count = (value: int, singular: string, plural: string): string => `${value} ${value === 1 ? singular : plural}`

    export const describe = ({freeable, freeableSize}: AssetCache.Scan): string => {
        const samples = freeable.filter(({kind}) => kind === "sample").length
        const soundfonts = freeable.filter(({kind}) => kind === "soundfont").length
        const parts = [
            samples > 0 ? count(samples, "library sample", "library samples") : "",
            soundfonts > 0 ? count(soundfonts, "soundfont", "soundfonts") : ""
        ].filter(part => part.length > 0).join(" and ")
        return `openDAW can delete ${parts} (${Bytes.toString(freeableSize)}) that none of your projects, `
            + "templates or presets use. They download again from the openDAW library if you ever need them. "
            + "Your own imports and recordings are never deleted."
    }

    export const install = (cache: AssetCache, onCleared: Exec): Terminable => {
        const Full = "openDAW could not save to the browser storage because it is full."
        return OpfsQuota.install(async ({path, cached}) => {
            if (cached) {
                console.debug(`[StorageFull] '${path}' is kept in memory only, it downloads again when needed`)
                return false
            }
            const progress = RuntimeNotifier.progress({headline: "Storage Full", message: "Looking for library files to delete"})
            const scan = await Promises.tryCatch(Promises.timeout(cache.scan(), TimeSpan.seconds(60), "The storage scan took too long"))
            progress.terminate()
            if (scan.status === "rejected") {
                console.warn("[StorageFull] scan failed", scan.error)
                await RuntimeNotifier.info({headline: "Storage Full", message: `${Full} (${String(scan.error)})`})
                return false
            }
            const {freeable, unreadable} = scan.value
            if (freeable.length === 0) {
                const reason = unreadable.length > 0
                    ? `${count(unreadable.length, "project, template or preset", "projects, templates or presets")} `
                    + "could not be read, so no library file is deleted."
                    : "There are no library files that can be deleted."
                if (await RuntimeNotifier.approve({
                    headline: "Storage Full",
                    message: `${Full}\n${reason}\nOpen the Storage page to delete your own data.`,
                    approveText: "Open Storage", cancelText: "Cancel"
                })) {RouteLocation.get().navigateTo("/storage")}
                return false
            }
            if (!await RuntimeNotifier.approve({
                headline: "Storage Full",
                message: `${Full}\n${describe(scan.value)}`,
                approveText: "Delete & Retry", cancelText: "Cancel"
            })) {return false}
            const deleting = RuntimeNotifier.progress({headline: "Storage Full", message: "Deleting library files"})
            const cleared = await Promises.tryCatch(Promises.timeout(cache.clear(freeable), TimeSpan.seconds(60),
                "Deleting the library files took too long"))
            deleting.terminate()
            onCleared()
            if (cleared.status === "rejected") {
                console.warn("[StorageFull] clearing failed", cleared.error)
                return false
            }
            const {removed, size} = cleared.value
            console.debug(`[StorageFull] deleted ${removed.length} library files (${Bytes.toString(size)})`)
            return removed.length > 0
        })
    }
}

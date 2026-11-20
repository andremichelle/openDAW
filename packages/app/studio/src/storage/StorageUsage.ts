import {EmptyExec, EmptyProcedure, int, MutableObservableOption, ObservableOption} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StorageWalk} from "@opendaw/lib-fusion"

export namespace StorageUsage {
    export const WarnBytes = 2_000_000_000

    const usage = new MutableObservableOption<int>()
    let running: Promise<void> = Promise.resolve()
    let queued = false

    export const observable = (): ObservableOption<int> => usage

    // estimate() leaves out what sync access handles wrote before a browser restart
    export const refresh = (): Promise<void> => {
        if (queued) {return running}
        queued = true
        running = running.then(EmptyExec, EmptyExec).then(async () => {
            queued = false
            const root = await Promises.tryCatch(navigator.storage.getDirectory())
            if (root.status === "rejected") {
                usage.clear()
                return
            }
            const walk = await Promises.tryCatch(StorageWalk.walk(root.value, EmptyProcedure))
            if (walk.status === "rejected") {
                usage.clear()
                return
            }
            usage.wrap(StorageWalk.totalSize(walk.value.files))
        }).catch(reason => {
            console.warn("[StorageUsage] could not measure the storage", reason)
            usage.clear()
        })
        return running
    }

    export const format = (bytes: int): string => bytes >= 1_000_000_000
        ? `${(bytes / 1_000_000_000).toFixed(2)}GB`
        : bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)}MB` : `${Math.round(bytes / 1_000)}kB`
}

import {
    DefaultObservableValue,
    EmptyExec,
    EmptyProcedure,
    int,
    MutableObservableOption,
    ObservableOption,
    ObservableValue
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StorageWalk} from "@opendaw/lib-fusion"

export namespace StorageUsage {
    export const WarnBytes = 2_000_000_000

    const usage = new MutableObservableOption<int>()
    const scanning = new DefaultObservableValue<boolean>(false)
    let running: Promise<void> = Promise.resolve()
    let queued = false

    export const observable = (): ObservableOption<int> => usage
    export const isScanning = (): ObservableValue<boolean> => scanning

    // estimate() leaves out what sync access handles wrote before a browser restart
    export const refresh = (): Promise<void> => {
        if (queued) {return running}
        queued = true
        running = running.then(EmptyExec, EmptyExec).then(async () => {
            queued = false
            scanning.setValue(true)
            const start = performance.now()
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
            const bytes = StorageWalk.totalSize(walk.value.files)
            usage.wrap(bytes)
            console.debug(`[StorageUsage] scanned ${walk.value.files.length} files, ${format(bytes)} in ${Math.round(performance.now() - start)}ms`)
        }).catch(reason => {
            console.warn("[StorageUsage] could not measure the storage", reason)
            usage.clear()
        }).finally(() => scanning.setValue(false))
        return running
    }

    export const format = (bytes: int): string => bytes >= 1_000_000_000
        ? `${(bytes / 1_000_000_000).toFixed(2)}GB`
        : bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)}MB` : `${Math.round(bytes / 1_000)}kB`
}

import {EmptyProcedure, int, Procedure, unitValue} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {StorageWalk} from "@opendaw/lib-fusion"
import {StorageInspectorProtocol, StorageScan} from "@opendaw/studio-adapters"

// the scan decodes projects with every box class, so it runs in its own worker that exists only while it runs
export namespace StorageInspector {
    const run = async <R>(job: (protocol: StorageInspectorProtocol) => Promise<R>): Promise<R> => {
        const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), {type: "module"})
        const protocol = Communicator.sender<StorageInspectorProtocol>(Messenger.for(worker).channel("storage"),
            router => new class implements StorageInspectorProtocol {
                scan(walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report> {
                    return router.dispatchAndReturn(this.scan, walkProgress, scanProgress)
                }
            })
        return job(protocol).finally(() => worker.terminate())
    }

    export const scan = (walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report> =>
        run(protocol => protocol.scan(walkProgress, scanProgress))

    // sizes only, no decoding, so it walks on the main thread without the worker
    export const folderSize = async (path: string): Promise<int> => {
        const folder = await path.split("/").reduce((parent, segment) =>
            parent.then(handle => handle.getDirectoryHandle(segment)), navigator.storage.getDirectory())
        return StorageWalk.totalSize((await StorageWalk.walk(folder, EmptyProcedure)).files)
    }
}

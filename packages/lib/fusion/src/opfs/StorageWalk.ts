import {int, Procedure} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace StorageWalk {
    export type File = { path: string, size: int }
    export type Result = { files: ReadonlyArray<File>, failures: ReadonlyArray<string> }

    const ProgressInterval = 64

    export const walk = async (root: FileSystemDirectoryHandle, progress: Procedure<int>): Promise<Result> => {
        const files: Array<File> = []
        const failures: Array<string> = []
        const visit = async (folder: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
            for await (const handle of folder.values()) {
                const path = `${prefix}${handle.name}`
                if (handle.kind === "directory") {
                    await visit(handle as FileSystemDirectoryHandle, `${path}/`)
                    continue
                }
                const {status, value} = await Promises.tryCatch((handle as FileSystemFileHandle).getFile())
                if (status === "rejected") {
                    failures.push(path)
                    continue
                }
                files.push({path, size: value.size})
                if (files.length % ProgressInterval === 0) {progress(files.length)}
            }
        }
        await visit(root, "")
        progress(files.length)
        return {files, failures}
    }

    export const totalSize = (files: ReadonlyArray<File>): int =>
        files.reduce((sum, {size}) => sum + size, 0)
}

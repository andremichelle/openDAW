import {Arrays, asDefined, isNotUndefined, panic} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {OpfsProtocol} from "./OpfsProtocol"

export namespace OpfsWorker {
    const DEBUG = false

    export const init = (messenger: Messenger) =>
        Communicator.executor(messenger.channel("opfs"), new class implements OpfsProtocol {
            readonly #locks = new Map<string, Promise<void>>()

            async write(path: string, data: Uint8Array): Promise<void> {
                await this.#acquireLock(path, async () => {
                    if (DEBUG) {console.debug(`write ${data.length}b to ${path}`)}
                    const handle = await this.#resolveFile(path, {create: true})
                    try {
                        handle.truncate(data.length)
                        handle.write(data.buffer as ArrayBuffer, {at: 0})
                        handle.flush()
                    } catch (reason: any) {
                        console.error("OPFS write failed:",
                            reason?.name, reason?.message, reason?.stack ?? "(no stack trace)")
                        throw reason
                    } finally {
                        handle.close()
                    }
                })
            }

            async read(path: string): Promise<Uint8Array> {
                return await this.#acquireLock(path, async () => {
                    if (DEBUG) {console.debug(`read ${path}`)}
                    const handle = await this.#resolveFile(path)
                    try {
                        const size = handle.getSize()
                        const buffer = new Uint8Array(size)
                        handle.read(buffer)
                        return buffer
                    } finally {
                        handle.close()
                    }
                })
            }

            async delete(path: string): Promise<void> {
                await this.#acquireLock(path, async () => {
                    const segments = pathToSegments(path)
                    if (segments.length === 0) {return this.clear()}
                    return this.#resolveFolder(segments.slice(0, -1))
                        .then(folder => folder.removeEntry(asDefined(segments.at(-1)), {recursive: true}))
                })
            }

            async list(path: string): Promise<ReadonlyArray<OpfsProtocol.Entry>> {
                const segments = pathToSegments(path)
                const {status, value: folder} = await Promises.tryCatch(this.#resolveFolder(segments))
                if (status === "rejected") {return Arrays.empty()}
                const result: Array<OpfsProtocol.Entry> = []
                for await (const {name, kind} of folder.values()) {
                    result.push({name, kind})
                }
                return result
            }

            async clear(): Promise<void> {
                const root = await navigator.storage.getDirectory()
                for await (const [name, handle] of root.entries()) {
                    if (handle.kind === "file") {
                        await root.removeEntry(name)
                    } else if (handle.kind === "directory") {
                        await root.removeEntry(name, {recursive: true})
                    }
                }
            }

            async #acquireLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
                while (true) {
                    const existingLock = this.#locks.get(path)
                    if (isNotUndefined(existingLock)) {
                        await existingLock
                        continue
                    }
                    let releaseLock: () => void = () => panic("Lock not acquired")
                    const lockPromise = new Promise<void>(resolve => releaseLock = resolve)
                    this.#locks.set(path, lockPromise)
                    try {
                        return await operation()
                    } finally {
                        if (this.#locks.get(path) === lockPromise) {
                            this.#locks.delete(path)
                        }
                        releaseLock()
                    }
                }
            }

            async #resolveFile(path: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemSyncAccessHandle> {
                const segments = pathToSegments(path)
                const folder = await this.#resolveFolder(segments.slice(0, -1), options)
                const fileHandle = await folder.getFileHandle(asDefined(segments.at(-1)), options)
                return await fileHandle.createSyncAccessHandle()
            }

            async #resolveFolder(segments: ReadonlyArray<string>,
                                 options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
                let folder: FileSystemDirectoryHandle = await navigator.storage.getDirectory()
                for (const segment of segments) {folder = await folder.getDirectoryHandle(segment, options)}
                return folder
            }
        })

    const pathToSegments = (path: string): ReadonlyArray<string> => {
        const noSlashes = path.replace(/^\/+|\/+$/g, "")
        return noSlashes === "" ? [] : noSlashes.split("/")
    }
}
import {Arrays, asDefined, EmptyProcedure, isNotUndefined, panic, Procedure} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {OpfsProtocol} from "./OpfsProtocol"

export namespace OpfsWorker {
    const DEBUG = false
    const LockWarnMillis = 2000
    const HoldWarnMillis = 5000

    type LockHolder = { readonly operation: string, readonly since: number, step: string }

    export const init = (messenger: Messenger) =>
        Communicator.executor(messenger.channel("opfs"), new class implements OpfsProtocol {
            readonly #locks = new Map<string, Promise<void>>()
            readonly #holders = new Map<string, LockHolder>()

            async write(path: string, data: Uint8Array): Promise<void> {
                await this.#acquireLock("write", path, async step => {
                    if (DEBUG) {console.debug(`write ${data.length}b to ${path}`)}
                    const handle = await this.#resolveFile(path, step, {create: true})
                    step("write")
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
                return await this.#acquireLock("read", path, async step => {
                    if (DEBUG) {console.debug(`read ${path}`)}
                    const handle = await this.#resolveFile(path, step)
                    step("read")
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

            async exists(path: string): Promise<boolean> {
                return await this.#acquireLock("exists", path, async step => {
                    if (DEBUG) {console.debug(`exists ${path}`)}
                    const segments = pathToSegments(path)
                    const {status: folderStatus} = await Promises.tryCatch(this.#resolveFolder(segments, step))
                    if (folderStatus === "resolved") {return true}
                    const {status: fileStatus, value: handle} = await Promises.tryCatch(this.#resolveFile(path, step))
                    if (fileStatus === "rejected") {return false}
                    try {
                        return handle.getSize() > 0
                    } finally {
                        handle.close()
                    }
                })
            }

            async delete(path: string): Promise<void> {
                await this.#acquireLock("delete", path, async step => {
                    const segments = pathToSegments(path)
                    if (segments.length === 0) {return this.clear()}
                    const {status} = await Promises.tryCatch(this.#resolveFolder(segments.slice(0, -1), step)
                        .then(folder => {
                            step("remove entry")
                            return folder.removeEntry(asDefined(segments.at(-1)), {recursive: true})
                        }))
                    if (status === "rejected") {return}
                })
            }

            async list(path: string): Promise<ReadonlyArray<OpfsProtocol.Entry>> {
                const segments = pathToSegments(path)
                const {status, value: folder} = await Promises.tryCatch(this.#resolveFolder(segments, EmptyProcedure))
                if (status === "rejected") {return Arrays.empty()}
                const result: Array<OpfsProtocol.Entry> = []
                for await (const {name, kind} of folder.values()) {
                    result.push({name, kind})
                }
                return result
            }

            async isAvailable(): Promise<boolean> {
                const {status} = await Promises.tryCatch(getOpfsRoot())
                return status === "resolved"
            }

            async clear(): Promise<void> {
                const root = await getOpfsRoot()
                for await (const [name, handle] of root.entries()) {
                    if (handle.kind === "file") {
                        await root.removeEntry(name)
                    } else if (handle.kind === "directory") {
                        await root.removeEntry(name, {recursive: true})
                    }
                }
            }

            async #acquireLock<T>(operation: string, path: string,
                                  task: (step: Procedure<string>) => Promise<T>): Promise<T> {
                while (true) {
                    const existingLock = this.#locks.get(path)
                    if (isNotUndefined(existingLock)) {
                        const waitStart = performance.now()
                        const warning = setTimeout(() => {
                            const holder = this.#holders.get(path)
                            const now = performance.now()
                            console.warn(`[OPFS] ${operation} '${path}' waits ${((now - waitStart) / 1000).toFixed(1)}s for ${
                                isNotUndefined(holder)
                                    ? `${holder.operation} held for ${((now - holder.since) / 1000).toFixed(1)}s at '${holder.step}'`
                                    : "an unknown holder"}`)
                        }, LockWarnMillis)
                        await existingLock
                        clearTimeout(warning)
                        continue
                    }
                    let releaseLock: () => void = () => panic("Lock not acquired")
                    const lockPromise = new Promise<void>(resolve => releaseLock = resolve)
                    const holder: LockHolder = {operation, since: performance.now(), step: "start"}
                    this.#locks.set(path, lockPromise)
                    this.#holders.set(path, holder)
                    const holdWarning = setTimeout(() => console.warn(`[OPFS] ${operation} '${path}' runs for ${
                        ((performance.now() - holder.since) / 1000).toFixed(1)}s at '${holder.step}'`), HoldWarnMillis)
                    try {
                        return await task(step => holder.step = step)
                    } finally {
                        clearTimeout(holdWarning)
                        if (this.#locks.get(path) === lockPromise) {
                            this.#locks.delete(path)
                        }
                        if (this.#holders.get(path) === holder) {
                            this.#holders.delete(path)
                        }
                        releaseLock()
                    }
                }
            }

            async #resolveFile(path: string, step: Procedure<string>,
                               options?: FileSystemGetDirectoryOptions): Promise<FileSystemSyncAccessHandle> {
                const segments = pathToSegments(path)
                const folder = await this.#resolveFolder(segments.slice(0, -1), step, options)
                step("get file handle")
                const fileHandle = await folder.getFileHandle(asDefined(segments.at(-1)), options)
                step("create sync access handle")
                return await fileHandle.createSyncAccessHandle()
            }

            async #resolveFolder(segments: ReadonlyArray<string>, step: Procedure<string>,
                                 options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
                step("get root")
                let folder: FileSystemDirectoryHandle = await getOpfsRoot()
                for (const segment of segments) {
                    step(`get directory '${segment}'`)
                    folder = await folder.getDirectoryHandle(segment, options)
                }
                return folder
            }
        })

    const getOpfsRoot = async (): Promise<FileSystemDirectoryHandle> => {
        const result = await Promises.tryCatch(navigator.storage.getDirectory())
        if (result.status === "rejected") {
            const {error} = result
            const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            throw new Error(`Storage not available (${reason})`)
        }
        return result.value
    }

    const pathToSegments = (path: string): ReadonlyArray<string> => {
        const noSlashes = path.replace(/^\/+|\/+$/g, "")
        return noSlashes === "" ? [] : noSlashes.split("/")
    }
}
import {Arrays, asDefined, EmptyProcedure, Errors, isNotUndefined, panic, Procedure, tryCatch} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {OpfsProtocol} from "./OpfsProtocol"

export namespace OpfsWorker {
    const DEBUG = false
    const LockWarnMillis = 2000
    const SnapshotLimit = 256 << 20
    const HoldWarnMillis = 5000
    const OpenTimeoutMillis = 10_000
    const OpenRetries = 3

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
                    const previous = tryCatch(() => {
                        const size = handle.getSize()
                        if (size > SnapshotLimit) {throw new Error(`'${path}' is too large to keep a copy`)}
                        const bytes = new Uint8Array(size)
                        const count = handle.read(bytes, {at: 0})
                        if (count < bytes.byteLength) {throw new Error(`Read ${count} of ${bytes.byteLength} bytes of '${path}'`)}
                        return bytes
                    })
                    const sized = tryCatch(() => handle.truncate(data.byteLength))
                    const written = sized.status === "success" ? tryCatch(() => {
                        writeWhole(handle, data, path)
                        handle.flush()
                    }) : sized
                    if (written.status === "failure") {
                        if (sized.status === "success") {
                            restoreOrEmpty(handle, previous.status === "success" ? previous.value : new Uint8Array(0), path)
                        }
                        handle.close()
                        const {error} = written
                        console.error("OPFS write failed:", error instanceof Error
                            ? `${error.name}: ${error.message}` : String(error))
                        throw error
                    }
                    handle.close()
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
                    await Promises.tryCatch(this.#resolveFolder(segments.slice(0, -1), step)
                        .then(folder => {
                            step("remove entry")
                            return removeChild(folder, asDefined(segments.at(-1)))
                        }))
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
                for (const handle of await listHandles(root)) {
                    await removeHandle(root, handle)
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
                for (let attempt = 0; ; attempt++) {
                    step(attempt === 0 ? "create sync access handle" : `create sync access handle (retry ${attempt})`)
                    const result = await Promises.tryCatch(openSyncAccessHandle(fileHandle, path))
                    if (result.status === "resolved") {return result.value}
                    if (!Errors.isTimeout(result.error) || attempt === OpenRetries) {throw result.error}
                    console.warn(`[OPFS] '${path}' did not open within ${OpenTimeoutMillis / 1000}s, retry ${attempt + 1} of ${OpenRetries}`)
                }
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

    // Chrome sometimes never settles createSyncAccessHandle under heavy load, a new request succeeds
    const openSyncAccessHandle = async (fileHandle: FileSystemFileHandle,
                                        path: string): Promise<FileSystemSyncAccessHandle> => {
        const opening = fileHandle.createSyncAccessHandle()
        const {promise: timeout, reject} = Promise.withResolvers<never>()
        const timer = setTimeout(() => reject(new DOMException(
            `OPFS could not open '${path}' within ${OpenTimeoutMillis / 1000}s`, "TimeoutError")), OpenTimeoutMillis)
        const result = await Promises.tryCatch(Promise.race([opening, timeout]))
        clearTimeout(timer)
        if (result.status === "rejected") {
            opening.then(handle => handle.close(), EmptyProcedure)
            throw result.error
        }
        return result.value
    }

    const getOpfsRoot = async (): Promise<FileSystemDirectoryHandle> => {
        const result = await Promises.tryCatch(navigator.storage.getDirectory())
        if (result.status === "rejected") {
            const {error} = result
            const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            throw new Error(`Storage not available (${reason})`, {cause: error})
        }
        return result.value
    }

    const listHandles = async (folder: FileSystemDirectoryHandle): Promise<ReadonlyArray<FileSystemHandle>> => {
        const handles: Array<FileSystemHandle> = []
        for await (const handle of folder.values()) {handles.push(handle)}
        return handles
    }

    // Chrome subtracts a removed file's size from usage it never added for sync-handle writes (#527)
    const emptyFile = async (handle: FileSystemFileHandle): Promise<void> => {
        const opened = await Promises.tryCatch(handle.createSyncAccessHandle())
        if (opened.status === "rejected") {
            console.warn(`[OPFS] could not open '${handle.name}' to empty it before removal`, opened.error)
            return
        }
        const access = opened.value
        const result = tryCatch(() => {
            access.truncate(0)
            access.flush()
        })
        access.close()
        if (result.status === "failure") {console.warn(`[OPFS] could not empty '${handle.name}' before removal`, result.error)}
    }

    // with some room left Chrome writes what fits and returns the count instead of throwing
    const writeWhole = (access: FileSystemSyncAccessHandle, data: Uint8Array, path: string): void => {
        const count = access.write(data as Uint8Array<ArrayBuffer>, {at: 0})
        if (count < data.byteLength) {
            throw new DOMException(`Wrote ${count} of ${data.byteLength} bytes to '${path}'`, "QuotaExceededError")
        }
    }

    const restoreOrEmpty = (access: FileSystemSyncAccessHandle, previous: Uint8Array, path: string): void => {
        if (previous.byteLength > 0) {
            const restored = tryCatch(() => {
                access.truncate(previous.byteLength)
                writeWhole(access, previous, path)
                access.flush()
            })
            if (restored.status === "success") {return}
            console.warn(`[OPFS] could not restore '${path}' after a failed write`, restored.error)
        }
        const emptied = tryCatch(() => {
            access.truncate(0)
            access.flush()
        })
        if (emptied.status === "failure") {console.warn(`[OPFS] could not empty '${path}' after a failed write`, emptied.error)}
    }

    const MetaFileName = "meta.json"

    const removeHandle = async (folder: FileSystemDirectoryHandle, handle: FileSystemHandle): Promise<void> => {
        if (handle.kind === "file") {
            await emptyFile(handle as FileSystemFileHandle)
            return folder.removeEntry(handle.name)
        }
        const directory = handle as FileSystemDirectoryHandle
        const children = await listHandles(directory)
        const ordered = [
            ...children.filter(child => child.kind === "file" && child.name === MetaFileName),
            ...children.filter(child => !(child.kind === "file" && child.name === MetaFileName))]
        for (const child of ordered) {
            await Promises.tryCatch(removeHandle(directory, child))
        }
        return folder.removeEntry(handle.name, {recursive: true})
    }

    const removeChild = async (folder: FileSystemDirectoryHandle, name: string): Promise<void> => {
        const file = await Promises.tryCatch(folder.getFileHandle(name))
        if (file.status === "resolved") {return removeHandle(folder, file.value)}
        if (!(file.error instanceof DOMException && file.error.name === "TypeMismatchError")) {throw file.error}
        return removeHandle(folder, await folder.getDirectoryHandle(name))
    }

    const pathToSegments = (path: string): ReadonlyArray<string> => {
        const noSlashes = path.replace(/^\/+|\/+$/g, "")
        return noSlashes === "" ? [] : noSlashes.split("/")
    }
}
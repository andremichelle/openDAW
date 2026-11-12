import {EmptyProcedure, int, Procedure, unitValue} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {StorageWalk} from "@opendaw/lib-fusion"
import {StorageInspectorProtocol} from "./StorageInspectorProtocol"
import {StorageScan} from "./StorageScan"
import {SampleFormats} from "./SampleFormats"

const read = (root: FileSystemDirectoryHandle) => async (path: string): Promise<Uint8Array> => {
    const segments = path.split("/")
    const folder = await segments.slice(0, -1)
        .reduce((parent, segment) => parent.then(handle => handle.getDirectoryHandle(segment)), Promise.resolve(root))
    const file = await (await folder.getFileHandle(segments[segments.length - 1])).getFile()
    return new Uint8Array(await file.arrayBuffer())
}

const head = (root: FileSystemDirectoryHandle) => async (path: string, bytes: int): Promise<Uint8Array> => {
    const segments = path.split("/")
    const folder = await segments.slice(0, -1)
        .reduce((parent, segment) => parent.then(handle => handle.getDirectoryHandle(segment)), Promise.resolve(root))
    const file = await (await folder.getFileHandle(segments[segments.length - 1])).getFile()
    return new Uint8Array(await file.slice(0, bytes).arrayBuffer())
}

Communicator.executor(Messenger.for(self as unknown as Parameters<typeof Messenger.for>[0]).channel("storage"), new class implements StorageInspectorProtocol {
    async scan(walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report> {
        const root = await navigator.storage.getDirectory()
        return StorageScan.scan(await StorageWalk.walk(root, walkProgress), read(root), scanProgress)
    }

    async scanSampleFormats(progress: Procedure<unitValue>): Promise<SampleFormats.Report> {
        const root = await navigator.storage.getDirectory()
        const {files} = await StorageWalk.walk(root, EmptyProcedure)
        return SampleFormats.scan(files, head(root), read(root), progress)
    }
})

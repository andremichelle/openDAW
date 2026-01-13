import {FooterLabel} from "@/service/FooterLabel"
import {asDefined, Exec, isDefined} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {StudioService} from "@/service/StudioService"
import {Commit, FilePickerAcceptTypes, SyncLogReader, SyncLogWriter} from "@moises-ai/studio-core"

export namespace SyncLogService {
    export const start = async (service: StudioService) => {
        if (!isDefined(window.showSaveFilePicker)) {return}
        const {
            status,
            value: handle
        } = await Promises.tryCatch(window.showSaveFilePicker({
            suggestedName: "New.odsl",
            ...FilePickerAcceptTypes.ProjectSyncLog
        }))
        if (status === "rejected") {return}
        await service.newProject()
        const label: FooterLabel = asDefined(service.factoryFooterLabel().unwrap()())
        label.setTitle("SyncLog")
        let count = 0 | 0
        SyncLogWriter.attach(service.project, wrapBlockWriter(handle, () => label.setValue(`${++count} commits`)))
    }

    export const append = async (service: StudioService) => {
        const openResult = await Promises.tryCatch(window.showOpenFilePicker(FilePickerAcceptTypes.ProjectSyncLog))
        if (openResult.status === "rejected") {return}
        const handle = asDefined(openResult.value[0], "No handle")
        const queryPermissionResult = await Promises.tryCatch(handle.queryPermission({mode: "readwrite"}))
        if (queryPermissionResult.status === "rejected") {
            console.warn(queryPermissionResult.error)
            // do not return
        } else {
            console.debug("queryPermission", queryPermissionResult.value)
        }
        const requestPermissionResult = await Promises.tryCatch(handle.requestPermission({mode: "readwrite"}))
        if (requestPermissionResult.status === "rejected") {
            console.warn("permission-status", requestPermissionResult.error)
            return
        }
        if (requestPermissionResult.value !== "granted") {
            console.warn("permission-value", requestPermissionResult.value)
            return
        }
        const arrayBufferResult = await Promises.tryCatch(handle.getFile().then(x => x.arrayBuffer()))
        if (arrayBufferResult.status === "rejected") {
            console.warn("arrayBuffer", arrayBufferResult.error)
            return
        }
        const {project, lastCommit, numCommits} = await SyncLogReader.unwrap(service, arrayBufferResult.value)
        service.projectProfileService.setProject(project, "SyncLog")
        const label: FooterLabel = asDefined(service.factoryFooterLabel().unwrap()())
        label.setTitle("SyncLog")
        let count = numCommits
        SyncLogWriter.attach(service.project, wrapBlockWriter(handle, () => label.setValue(`${++count} commits`)), lastCommit)
    }

    const wrapBlockWriter = (handle: FileSystemFileHandle, callback: Exec) => {
        let blocks: Array<Commit> = []
        let lastPromise: Promise<void> = Promise.resolve()
        return (commit: Commit): void => {
            blocks.push(commit)
            callback()
            lastPromise = lastPromise.then(async () => {
                const writable: FileSystemWritableFileStream = await handle.createWritable({keepExistingData: true})
                const file = await handle.getFile()
                await writable.seek(file.size)
                const buffers = blocks.map(block => block.serialize())
                blocks = []
                await writable.write(appendArrayBuffers(buffers))
                await writable.close()
            })
        }
    }

    const appendArrayBuffers = (buffers: ReadonlyArray<ArrayBuffer>): ArrayBuffer => {
        const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)
        const result = new Uint8Array(totalLength)
        buffers.reduce((offset, buffer) => {
            result.set(new Uint8Array(buffer), offset)
            return offset + buffer.byteLength
        }, 0)
        return result.buffer
    }
}
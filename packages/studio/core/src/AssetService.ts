import {
    Class,
    DefaultObservableValue,
    Errors,
    isInstanceOf,
    isNotUndefined,
    panic,
    Procedure,
    Progress,
    RuntimeNotifier,
    UUID
} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {BoxGraph} from "@opendaw/lib-box"
import {Sample, Soundfont} from "@opendaw/studio-adapters"
import {AudioFileBox, SoundfontFileBox} from "@opendaw/studio-boxes"

export namespace AssetService {
    export type ImportArgs = {
        uuid?: UUID.Bytes
        name?: string,
        arrayBuffer: ArrayBuffer,
        progressHandler?: Progress.Handler
    }
}

export abstract class AssetService<T extends Sample | Soundfont> {
    protected abstract readonly nameSingular: string
    protected abstract readonly namePlural: string
    protected abstract readonly boxType: Class<AudioFileBox | SoundfontFileBox>
    protected abstract readonly filePickerOptions: FilePickerOptions

    protected constructor(protected readonly onUpdate: Procedure<T>) {}

    async browse(multiple: boolean): Promise<ReadonlyArray<T>> {
        return this.browseFiles(multiple, this.filePickerOptions)
    }

    abstract importFile(args: AssetService.ImportArgs): Promise<T>

    async replaceMissingFiles(boxGraph: BoxGraph, manager: { invalidate: (uuid: UUID.Bytes) => void }): Promise<void> {
        const available = await this.collectAllFiles()
        const boxes = boxGraph.boxes().filter(box => isInstanceOf(box, this.boxType))
        if (boxes.length === 0) {return}
        for (const box of boxes) {
            const uuid = box.address.uuid
            const uuidAsString = UUID.toString(uuid)
            if (isNotUndefined(available.find(({uuid}) => uuid === uuidAsString))) {continue}
            const approved = await RuntimeNotifier.approve({
                headline: "Missing Asset",
                message: `Could not find ${this.nameSingular} '${box.fileName.getValue()}'`,
                cancelText: "Ignore",
                approveText: "Browse"
            })
            if (!approved) {continue}
            const {error, status, value: files} =
                await Promises.tryCatch(Files.open({...this.filePickerOptions, multiple: false}))
            if (status === "rejected") {
                if (Errors.isAbort(error) || Errors.isNotAllowed(error)) {return} else {return panic(String(error)) }
            }
            if (files.length === 0) {return}
            const readResult = await Promises.tryCatch(files[0].arrayBuffer())
            if (readResult.status === "rejected") {
                await RuntimeNotifier.info({
                    headline: "File Read Error",
                    message: `'${files[0].name}' could not be read. The file may be on an inaccessible location.`
                })
                continue
            }
            const asset = await this.importFile({uuid, arrayBuffer: readResult.value, progressHandler: Progress.Empty})
            await RuntimeNotifier.info({
                headline: "Replaced Asset",
                message: `${asset.name} has been replaced`
            })
            manager.invalidate(uuid)
        }
    }

    protected async browseFiles(multiple: boolean, filePickerSettings: FilePickerOptions): Promise<ReadonlyArray<T>> {
        const {error, status, value: files} =
            await Promises.tryCatch(Files.open({...filePickerSettings, multiple}))
        if (status === "rejected") {
            if (Errors.isAbort(error) || Errors.isNotAllowed(error)) {return []} else {return panic(String(error)) }
        }
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: `Importing ${files.length === 1 ? this.nameSingular : this.namePlural}...`, progress
        })
        const progressHandler = Progress.split(value => progress.setValue(value), files.length)
        const rejected: Array<string> = []
        const imported: Array<T> = []
        for (const [index, file] of files.entries()) {
            const readResult = await Promises.tryCatch(file.arrayBuffer())
            if (readResult.status === "rejected") {
                rejected.push(`'${file.name}' could not be read`)
                continue
            }
            const {status, value, error} = await Promises.tryCatch(this.importFile({
                name: file.name,
                arrayBuffer: readResult.value,
                progressHandler: progressHandler[index]
            }))
            if (status === "rejected") {rejected.push(String(error))} else {imported.push(value)}
        }
        dialog.terminate()
        if (rejected.length > 0) {
            await RuntimeNotifier.info({
                headline: `${this.nameSingular} Import Issues`,
                message: `${rejected.join(", ")} could not be imported.`
            })
        }
        return imported
    }

    protected abstract collectAllFiles(): Promise<ReadonlyArray<T>>
}
import {Arrays, Class, Errors, Option, panic, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {Wait} from "@opendaw/lib-runtime"
import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {Soundfont, SoundfontMetaData} from "@opendaw/studio-adapters"
import {SoundfontStorage} from "./SoundfontStorage"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {FactoryCatalog} from "../FactoryCatalog"
import {AssetService} from "../AssetService"
import {ExternalLib} from "../ExternalLib"

export class SoundfontService extends AssetService<Soundfont, void> {
    protected readonly namePlural: string = "Soundfonts"
    protected readonly nameSingular: string = "Soundfont"
    protected readonly boxType: Class<Box> = SoundfontFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.SoundfontFiles

    #local: Option<Array<Soundfont>> = Option.None
    #remote: Option<ReadonlyArray<Soundfont>> = Option.None

    acceptsFile(file: File): boolean {return ["sf2", "sf3", "dls"].includes(AssetService.extensionOf(file))}

    constructor() {
        super()
        Promise.all([
            SoundfontStorage.get().list(),
            FactoryCatalog.get().soundfonts()
        ]).then(([local, remote]) => {
            this.#local = Option.wrap(Arrays.subtract(local, remote, (a, b) => a.uuid === b.uuid))
            this.#remote = Option.wrap(remote)
        }, error => console.warn("Failed to load soundfont index:", error))
    }

    get local(): Option<ReadonlyArray<Soundfont>> {return this.#local}
    get remote(): Option<ReadonlyArray<Soundfont>> {return this.#remote}

    async importFile({uuid, name, arrayBuffer}: AssetService.ImportArgs): Promise<Soundfont> {
        if (this.#local.isEmpty()) {
            return panic("Local soundfont storage has not been read.")
        }
        if (arrayBuffer.byteLength > (1 << 24)) {
            const approved = await RuntimeNotifier.approve({
                headline: "Soundfont Import",
                message: `The soundfont you are trying to import is ${(arrayBuffer.byteLength >> 20)}mb. This may cause memory issues. Do you really want to continue?`,
                approveText: "Import",
                cancelText: "Cancel"
            })
            if (!approved) {throw Errors.AbortError}
        }
        const updater = RuntimeNotifier.progress({headline: `Import ${this.nameSingular}`})
        // try/finally (no catch) guarantees the modal progress dialog is
        // terminated on every exit, including failure paths like invalid
        // soundfont files (the reader throws synchronously), OPFS write errors,
        // or SHA-256 computation errors. The error itself still propagates
        // to the caller's tryCatch in AssetService.browseFiles.
        try {
            await Wait.frame()
            console.debug(`importSoundfont (${arrayBuffer.byteLength >> 10}kb)`)
            console.time("UUID.sha256")
            uuid ??= await UUID.sha256(arrayBuffer)
            console.timeEnd("UUID.sha256")
            const {status, value: read, error} = await ExternalLib.Soundfont()
            if (status === "rejected") {return panic(error)}
            const bank = read(arrayBuffer)
            const meta: SoundfontMetaData = {
                name: bank.metaData.name.trim().length > 0 ? bank.metaData.name : (name ?? "Soundfont").replace(/\.[A-Za-z0-9]+$/, ""),
                size: arrayBuffer.byteLength,
                url: "unknown",
                license: bank.metaData.copyright ?? "No license provided",
                origin: "import"
            }
            await SoundfontStorage.get().save({uuid, file: arrayBuffer, meta})
            const soundfont = {uuid: UUID.toString(uuid), ...meta}
            const list = this.#local.unwrap("local")
            if (!list.some(other => other.uuid === soundfont.uuid)) {
                list.push(soundfont)
            }
            this.notifier.notify([soundfont, undefined])
            return soundfont
        } finally {
            updater.terminate()
        }
    }

    protected async collectAllFiles(): Promise<ReadonlyArray<Soundfont>> {
        console.debug("[ProjectLoad] soundfont catalogue requested")
        const stock = await FactoryCatalog.get().soundfonts()
        console.debug(`[ProjectLoad] soundfont catalogue received (${stock.length})`)
        const local = await SoundfontStorage.get().list()
        console.debug(`[ProjectLoad] local soundfonts listed (${local.length})`)
        return Arrays.merge(stock, local, (a, b) => a.uuid === b.uuid)
    }
}
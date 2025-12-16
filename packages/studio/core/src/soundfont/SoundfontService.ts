import {Arrays, Class, Option, panic, Procedure, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {Wait} from "@opendaw/lib-runtime"
import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {Soundfont, SoundfontMetaData} from "@opendaw/studio-adapters"
import {SoundfontStorage} from "./SoundfontStorage"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {OpenSoundfontAPI} from "./OpenSoundfontAPI"
import {AssetService} from "../AssetService"
import {ExternalLib} from "../ExternalLib"

export class SoundfontService extends AssetService<Soundfont> {
    protected readonly namePlural: string = "Soundfonts"
    protected readonly nameSingular: string = "Soundfont"
    protected readonly boxType: Class<Box> = SoundfontFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.SoundfontFiles

    #local: Option<Array<Soundfont>> = Option.None
    #remote: Option<ReadonlyArray<Soundfont>> = Option.None

    constructor(onUpdate: Procedure<Soundfont>) {
        super(onUpdate)

        Promise.all([
            SoundfontStorage.get().list(),
            OpenSoundfontAPI.get().all()
        ]).then(([local, remote]) => {
            this.#local = Option.wrap(Arrays.subtract(local, remote, (a, b) => a.uuid === b.uuid))
            this.#remote = Option.wrap(remote)
        })
    }

    get local(): Option<ReadonlyArray<Soundfont>> {return this.#local}
    get remote(): Option<ReadonlyArray<Soundfont>> {return this.#remote}

    async importFile({uuid, arrayBuffer}: AssetService.ImportArgs): Promise<Soundfont> {
        if (this.#local.isEmpty()) {
            return panic("Local soundfont storage has not been read.")
        }
        if (arrayBuffer.byteLength > (1 << 24)) {
            await RuntimeNotifier.approve({
                headline: "Soundfont Import",
                message: `The soundfont you are trying to import is ${(arrayBuffer.byteLength >> 20)}mb. This may cause memory issues. Do you really want to continue?`,
                approveText: "Import",
                cancelText: "Cancel"
            })
        }
        const updater = RuntimeNotifier.progress({headline: `Import ${this.nameSingular}`})
        await Wait.frame()
        console.debug(`importSoundfont (${arrayBuffer.byteLength >> 10}kb)`)
        console.time("UUID.sha256")
        uuid ??= await UUID.sha256(arrayBuffer)
        console.timeEnd("UUID.sha256")
        console.time("SoundFont2")
        const {status, value: SoundFont2, error} = await ExternalLib.SoundFont2()
        console.timeEnd("SoundFont2")
        if (status === "rejected") {
            updater.terminate()
            return panic(error)
        }
        const soundFont2 = new SoundFont2(new Uint8Array(arrayBuffer))
        const meta: SoundfontMetaData = {
            name: soundFont2.metaData.name,
            size: arrayBuffer.byteLength,
            url: "unknown",
            license: soundFont2.metaData.copyright ?? "No license provided",
            origin: "import"
        }
        await SoundfontStorage.get().save({uuid, file: arrayBuffer, meta})
        const soundfont = {uuid: UUID.toString(uuid), ...meta}
        const list = this.#local.unwrap()
        if (!list.some(other => other.uuid === soundfont.uuid)) {
            list.push(soundfont)
        }
        this.onUpdate(soundfont)
        updater.terminate()
        return soundfont
    }

    protected async collectAllFiles(): Promise<ReadonlyArray<Soundfont>> {
        const stock = await OpenSoundfontAPI.get().all()
        const local = await SoundfontStorage.get().list()
        return Arrays.merge(stock, local, (a, b) => a.uuid === b.uuid)
    }
}
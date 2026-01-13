import {asDefined, isAbsent, RuntimeNotifier, UUID} from "@moises-ai/lib-std"
import {InstrumentFactories, Soundfont} from "@moises-ai/studio-adapters"
import {OpenSoundfontAPI, ProjectStorage, SoundfontStorage} from "@moises-ai/studio-core"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "../components/dialogs"
import {SoundfontFileBox} from "@moises-ai/studio-boxes"

export class SoundfontSelection {
    readonly #service: StudioService
    readonly #selection: HTMLSelection

    constructor(service: StudioService, selection: HTMLSelection) {
        this.#service = service
        this.#selection = selection
    }

    requestDevice(): void {
        if (!this.#service.hasProfile) {return}
        const project = this.#service.project
        const [soundfont] = this.#selected()
        if (isAbsent(soundfont)) {return}
        const {uuid, name} = soundfont
        const {api, editing} = project
        editing.modify(() => api.createInstrument(InstrumentFactories.Soundfont, {attachment: {uuid, name}}))
    }

    async deleteSelected() {return this.deleteSoundfonts(...this.#selected())}

    async deleteSoundfonts(...soundfonts: ReadonlyArray<Soundfont>) {
        const dialog = RuntimeNotifier.progress({headline: "Checking Soundfont Usages"})
        const used = await ProjectStorage.listUsedAssets(SoundfontFileBox)
        const online = new Set<string>((await OpenSoundfontAPI.get().all()).map(({uuid}) => uuid))
        dialog.terminate()
        const approved = await Dialogs.approve({
            headline: "Remove Soundfont(s)?",
            message: "This cannot be undone!",
            approveText: "Remove"
        })
        if (!approved) {return}
        for (const {uuid, name} of soundfonts) {
            const isUsed = used.has(uuid)
            const isOnline = online.has(uuid)
            if (isUsed && !isOnline) {
                await Dialogs.info({headline: "Cannot Delete Soundfont", message: `${name} is used by a project.`})
            } else {
                await SoundfontStorage.get().deleteItem(UUID.parse(uuid))
            }
        }
    }

    #selected(): ReadonlyArray<Soundfont> {
        const selected = this.#selection.getSelected()
        return selected.map(element => JSON.parse(asDefined(element.getAttribute("data-selection"))) as Soundfont)
    }
}
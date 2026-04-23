import {asDefined, isAbsent, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, Soundfont} from "@opendaw/studio-adapters"
import {OpenSoundfontAPI, PresetStorage, ProjectStorage, SoundfontStorage} from "@opendaw/studio-core"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "../components/dialogs"
import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {ResourceSelection} from "@/ui/browse/ResourceSelection"

export class SoundfontSelection implements ResourceSelection {
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
        const [usedByProjects, usedByPresets, onlineList] = await Promise.all([
            ProjectStorage.listUsedAssets(SoundfontFileBox),
            PresetStorage.listUsedAssets(SoundfontFileBox),
            OpenSoundfontAPI.get().all()
        ])
        const online = new Set<string>(onlineList.map(({uuid}) => uuid))
        dialog.terminate()
        const approved = await Dialogs.approve({
            headline: "Remove Soundfont(s)?",
            message: "This cannot be undone!",
            approveText: "Remove"
        })
        if (!approved) {return}
        for (const {uuid, name} of soundfonts) {
            const isOnline = online.has(uuid)
            if (isOnline) {
                await SoundfontStorage.get().deleteItem(UUID.parse(uuid))
                continue
            }
            if (usedByProjects.has(uuid)) {
                await Dialogs.info({headline: "Cannot Delete Soundfont", message: `${name} is used by a project.`})
            } else if (usedByPresets.has(uuid)) {
                await Dialogs.info({headline: "Cannot Delete Soundfont", message: `${name} is used by a preset.`})
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
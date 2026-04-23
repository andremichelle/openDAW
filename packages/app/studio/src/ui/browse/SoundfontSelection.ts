import {asDefined, isAbsent, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, Soundfont} from "@opendaw/studio-adapters"
import {OpenSoundfontAPI, PresetStorage, ProjectStorage, SoundfontStorage} from "@opendaw/studio-core"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "../components/dialogs"
import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {ResourceSelection, truncateList} from "@/ui/browse/ResourceSelection"

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
        this.#service.projectProfileService.getValue().ifSome(profile => {
            const projectName = profile.meta.name
            for (const box of this.#service.project.boxGraph.boxes()) {
                if (!(box instanceof SoundfontFileBox)) {continue}
                const key = UUID.toString(box.address.uuid)
                const list = usedByProjects.get(key) ?? []
                if (!list.includes(projectName)) {list.push(projectName)}
                usedByProjects.set(key, list)
            }
        })
        const online = new Set<string>(onlineList.map(({uuid}) => uuid))
        dialog.terminate()
        const deletable: Array<Soundfont> = []
        for (const soundfont of soundfonts) {
            const isOnline = online.has(soundfont.uuid)
            const projectRefs = usedByProjects.get(soundfont.uuid) ?? []
            const presetRefs = usedByPresets.get(soundfont.uuid) ?? []
            if (!isOnline && (projectRefs.length > 0 || presetRefs.length > 0)) {
                const lines: Array<string> = []
                if (projectRefs.length > 0) {
                    lines.push(`Used by project(s): ${truncateList(projectRefs)}`)
                }
                if (presetRefs.length > 0) {
                    lines.push(`Used by preset(s): ${truncateList(presetRefs)}`)
                }
                await Dialogs.info({
                    headline: "Cannot Delete Soundfont",
                    message: `${soundfont.name}\n${lines.join("\n")}`
                })
            } else {
                deletable.push(soundfont)
            }
        }
        if (deletable.length === 0) {return}
        const approved = await Dialogs.approve({
            headline: "Remove Soundfont(s)?",
            message: "This cannot be undone!",
            approveText: "Remove"
        })
        if (!approved) {return}
        for (const {uuid} of deletable) {
            await SoundfontStorage.get().deleteItem(UUID.parse(uuid))
        }
    }

    #selected(): ReadonlyArray<Soundfont> {
        const selected = this.#selection.getSelected()
        return selected.map(element =>
            JSON.parse(asDefined(element.getAttribute("data-selection"))) as Soundfont)
    }
}
import {asDefined, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, Sample} from "@opendaw/studio-adapters"
import {AudioContentFactory, OpenSampleAPI, PresetStorage, ProjectStorage, SampleStorage} from "@opendaw/studio-core"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "../components/dialogs"
import {ResourceSelection, truncateList} from "@/ui/browse/ResourceSelection"

export class SampleSelection implements ResourceSelection {
    readonly #service: StudioService
    readonly #selection: HTMLSelection

    constructor(service: StudioService, selection: HTMLSelection) {
        this.#service = service
        this.#selection = selection
    }

    requestDevice(): void {
        if (!this.#service.hasProfile) {return}
        const project = this.#service.project
        const {editing, boxGraph} = project

        editing.modify(() => {
            const samples = this.#selected()
            samples.forEach(sample => {
                const {uuid: uuidAsString, name, duration: durationInSeconds, bpm} = sample
                const uuid = UUID.parse(uuidAsString)
                const {trackBox, instrumentBox} = project.api.createInstrument(InstrumentFactories.Tape)
                instrumentBox.label.setValue(name)
                const audioFileBox = boxGraph.findBox<AudioFileBox>(uuid)
                    .unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                        box.fileName.setValue(name)
                        box.startInSeconds.setValue(0)
                        box.endInSeconds.setValue(durationInSeconds)
                    }))
                if (bpm === 0) {
                    AudioContentFactory.createNotStretchedRegion({
                        boxGraph,
                        sample,
                        audioFileBox,
                        position: 0,
                        targetTrack: trackBox
                    })
                } else {
                    AudioContentFactory.createPitchStretchedRegion({
                        boxGraph,
                        sample,
                        audioFileBox,
                        position: 0,
                        targetTrack: trackBox
                    })
                }
            })
        })
    }

    async deleteSelected() {return this.deleteSamples(...this.#selected())}

    async deleteSamples(...samples: ReadonlyArray<Sample>) {
        const dialog = RuntimeNotifier.progress({headline: "Checking Sample Usages"})
        const [usedByProjects, usedByPresets, onlineList] = await Promise.all([
            ProjectStorage.listUsedAssets(AudioFileBox),
            PresetStorage.listUsedAssets(AudioFileBox),
            OpenSampleAPI.get().all()
        ])
        this.#service.projectProfileService.getValue().ifSome(profile => {
            const projectName = profile.meta.name
            for (const box of this.#service.project.boxGraph.boxes()) {
                if (!(box instanceof AudioFileBox)) {continue}
                const key = UUID.toString(box.address.uuid)
                const list = usedByProjects.get(key) ?? []
                if (!list.includes(projectName)) {list.push(projectName)}
                usedByProjects.set(key, list)
            }
        })
        const online = new Set<string>(onlineList.map(({uuid}) => uuid))
        dialog.terminate()
        const deletable: Array<Sample> = []
        for (const sample of samples) {
            const isOnline = online.has(sample.uuid)
            const projectRefs = usedByProjects.get(sample.uuid) ?? []
            const presetRefs = usedByPresets.get(sample.uuid) ?? []
            if (!isOnline && (projectRefs.length > 0 || presetRefs.length > 0)) {
                const lines: Array<string> = []
                if (projectRefs.length > 0) {
                    lines.push(`Used by project(s): ${truncateList(projectRefs)}`)
                }
                if (presetRefs.length > 0) {
                    lines.push(`Used by preset(s): ${truncateList(presetRefs)}`)
                }
                await Dialogs.info({
                    headline: "Cannot Delete Sample",
                    message: `${sample.name}\n${lines.join("\n")}`
                })
            } else {
                deletable.push(sample)
            }
        }
        if (deletable.length === 0) {return}
        const approved = await Dialogs.approve({
            headline: "Remove Sample(s)?",
            message: "This cannot be undone!",
            approveText: "Remove"
        })
        if (!approved) {return}
        for (const {uuid} of deletable) {
            await SampleStorage.get().deleteItem(UUID.parse(uuid))
        }
    }

    #selected(): ReadonlyArray<Sample> {
        const selected = this.#selection.getSelected()
        return selected.map(element => JSON.parse(asDefined(element.getAttribute("data-selection"))) as Sample)
    }
}
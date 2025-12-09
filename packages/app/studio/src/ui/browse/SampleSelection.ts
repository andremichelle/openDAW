import {asDefined, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, Sample} from "@opendaw/studio-adapters"
import {AudioContentFactory, OpenSampleAPI, ProjectStorage, SampleStorage} from "@opendaw/studio-core"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "../components/dialogs"

export class SampleSelection {
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
        const used = await ProjectStorage.listUsedAssets(AudioFileBox)
        const online = new Set<string>((await OpenSampleAPI.get().all()).map(({uuid}) => uuid))
        dialog.terminate()
        const approved = await Dialogs.approve({
            headline: "Remove Sample(s)?",
            message: "This cannot be undone!",
            approveText: "Remove"
        })
        if (!approved) {return}
        for (const {uuid, name} of samples) {
            const isUsed = used.has(uuid)
            const isOnline = online.has(uuid)
            if (isUsed && !isOnline) {
                await Dialogs.info({headline: "Cannot Delete Sample", message: `${name} is used by a project.`})
            } else {
                await SampleStorage.get().deleteItem(UUID.parse(uuid))
            }
        }
    }

    #selected(): ReadonlyArray<Sample> {
        const selected = this.#selection.getSelected()
        return selected.map(element => JSON.parse(asDefined(element.getAttribute("data-selection"))) as Sample)
    }
}
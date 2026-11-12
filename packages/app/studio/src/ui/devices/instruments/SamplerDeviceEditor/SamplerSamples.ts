import {Arrays, DefaultObservableValue, isDefined, Optional, Procedure, Provider, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {SamplerGroupBox, SamplerZoneBox} from "@opendaw/studio-boxes"
import {Sample, SamplerDeviceBoxAdapter, SamplerZones} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"
import {AnyDragData} from "@/ui/AnyDragData"
import {DragAndDrop} from "@/ui/DragAndDrop"

// Samples on their way into a Sampler: from files, from the sample browser, dropped or chosen.
export namespace SamplerSamples {
    // `project` is the one the Sampler lives in: it may be closed or replaced while the files decode
    export const importFiles = async (service: StudioService, project: Project,
                                      files: ReadonlyArray<File>): Promise<ReadonlyArray<Sample>> => {
        const imported: Array<Sample> = []
        const failed: Array<string> = []
        const progress = new DefaultObservableValue(0.0)
        const dialog = Dialogs.progress({headline: "Importing Samples", message: "", progress})
        for (const [index, file] of files.entries()) {
            progress.setValue(index / files.length)
            dialog.message = file.name
            // a tempo of 0 is "none": no detection, these are notes and hits, not loops
            const {status, value} = await Promises.tryCatch(file.arrayBuffer()
                .then(arrayBuffer => service.sampleService.importFile({name: file.name, arrayBuffer, bpm: 0})))
            if (status === "resolved") {imported.push(value)} else {failed.push(file.name)}
        }
        dialog.terminate()
        imported.forEach(sample => project.trackUserCreatedSample(UUID.parse(sample.uuid)))
        if (failed.length > 0) {
            await RuntimeNotifier.info({
                headline: "Samples Not Imported",
                message: failed.length === 1
                    ? `'${failed[0]}' could not be read as audio.`
                    : `${failed.length} of ${files.length} files could not be read as audio.`
            })
        }
        return imported
    }

    export const add = (project: Project, adapter: SamplerDeviceBoxAdapter, group: Optional<SamplerGroupBox>,
                        samples: ReadonlyArray<Sample>): ReadonlyArray<SamplerZoneBox> => {
        const {editing, boxGraph} = project
        if (samples.length === 0 || !adapter.box.isAttached()) {return Arrays.empty()}
        return editing.modify(() => SamplerZones.addSamples(boxGraph, adapter.box,
            isDefined(group) && group.isAttached() ? group : undefined, samples)).unwrapOrElse(Arrays.empty())
    }

    // `highlight` shows that the drop is welcome, `group` is where the zones go, `added` hears about them
    export const installDrop = (target: HTMLElement, highlight: HTMLElement, service: StudioService,
                                adapter: SamplerDeviceBoxAdapter, group: Provider<Optional<SamplerGroupBox>>,
                                added: Procedure<ReadonlyArray<SamplerZoneBox>>): Terminable => {
        const {project} = service
        return DragAndDrop.installTarget(target, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => data.type === "sample" || data.type === "file",
            drop: async (_event: DragEvent, data: AnyDragData): Promise<void> => {
                if (data.type === "sample") {
                    added(add(project, adapter, group(), [data.sample]))
                } else if (data.type === "file") {
                    added(add(project, adapter, group(), await importFiles(service, project, data.files)))
                }
            },
            enter: (allowDrop: boolean) => highlight.classList.toggle("accept", allowDrop),
            leave: () => highlight.classList.remove("accept")
        })
    }
}

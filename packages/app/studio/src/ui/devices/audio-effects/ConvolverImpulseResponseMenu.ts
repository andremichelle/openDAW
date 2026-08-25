import {Nullable, UUID} from "@opendaw/lib-std"
import {PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {OpenSampleAPI} from "@/opendaw-api/OpenSampleAPI"
import {SampleIndex, SampleIndexEntry, SampleIndexFolder} from "@/opendaw-api/SampleIndex"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {StudioService} from "@/service/StudioService"

export namespace ConvolverImpulseResponseMenu {
    const PATH: ReadonlyArray<string> = ["openDAW", "Impulse Responses"]
    const cache: { folder: Nullable<SampleIndexFolder>, failed: boolean } = {folder: null, failed: false}

    const resolve = (): void => {
        if (cache.folder !== null) {return}
        OpenSampleAPI.get().tree()
            .then(index => {
                const folder = PATH.reduce<Nullable<SampleIndexFolder>>((parent, name) => parent === null
                    ? null
                    : parent.folders?.find(sub => sub.name === name) ?? null, {name: "", folders: index.folders})
                cache.folder = folder
                cache.failed = folder === null
            }, () => cache.failed = true)
    }

    export const populate = (parent: MenuItem, service: StudioService,
                             file: PointerField<Pointers.AudioFile>): void => {
        resolve()
        parent.addMenuItem(MenuItem.default({label: "Impulse Responses", separatorBefore: true})
            .setRuntimeChildrenProcedure(submenu => {
                const folder = cache.folder
                if (folder === null) {
                    submenu.addMenuItem(MenuItem.default(
                        {label: cache.failed ? "Not available" : "Loading...", selectable: false}))
                    return
                }
                populateFolder(submenu, folder, service, file)
            }))
    }

    const populateFolder = (parent: MenuItem, folder: SampleIndexFolder, service: StudioService,
                            file: PointerField<Pointers.AudioFile>): void => {
        const current = file.targetVertex.mapOr(vertex => UUID.toString(vertex.box.address.uuid), "")
        folder.folders?.forEach(sub => parent.addMenuItem(MenuItem.default({label: sub.name})
            .setRuntimeChildrenProcedure(menu => populateFolder(menu, sub, service, file))))
        folder.samples?.forEach(entry => parent.addMenuItem(MenuItem.default(
            {label: entry.name, checked: entry.uuid === current})
            .setTriggerProcedure(() => load(service, file, entry))))
    }

    const load = (service: StudioService, file: PointerField<Pointers.AudioFile>,
                  entry: SampleIndexEntry): void =>
        new SampleSelector(service, SampleSelectStrategy.forDeviceFile(file))
            .newSample(SampleIndex.asSample(entry))
}
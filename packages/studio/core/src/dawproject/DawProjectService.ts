import {Errors, isDefined, Option, panic, RuntimeNotifier} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {Files} from "@moises-ai/lib-dom"
import {Xml} from "@moises-ai/lib-xml"
import {MetaDataSchema} from "@moises-ai/lib-dawproject"
import {ProjectSkeleton} from "@moises-ai/studio-adapters"
import {DawProject} from "./DawProject"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {DawProjectImport} from "./DawProjectImporter"
import {ProjectProfile} from "../project"
import {SampleService} from "../samples"

export class DawProjectService {
    static async importDawproject(sampleService: SampleService): Promise<Option<ProjectSkeleton>> {
        const {status, value, error} =
            await Promises.tryCatch(Files.open({types: [FilePickerAcceptTypes.DawprojectFileType]}))
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return Option.None}
            return panic(String(error))
        }
        const file = value.at(0)
        if (!isDefined(file)) {return Option.None}
        const arrayBuffer = await file.arrayBuffer()
        const {project: projectSchema, resources} = await DawProject.decode(arrayBuffer)
        const importResult = await Promises.tryCatch(DawProjectImport.read(projectSchema, resources))
        if (importResult.status === "rejected") {
            await RuntimeNotifier.info({headline: "Import Error", message: String(importResult.error)})
            return Option.None
        }
        const {skeleton, audioIds} = importResult.value
        await Promise.all(audioIds
            .map(uuid => resources.fromUUID(uuid))
            .map(resource => sampleService.importFile({
                uuid: resource.uuid,
                name: resource.name,
                arrayBuffer: resource.buffer
            })))
        return Option.wrap(skeleton)
    }

    static async exportDawproject(profile: ProjectProfile): Promise<void> {
        const dialog = RuntimeNotifier.progress({headline: "Exporting DawProject..."})
        const {project, meta} = profile
        const {status, error, value: zip} = await Promises.tryCatch(
            DawProject.encode(project.skeleton, project.sampleManager, Xml.element({
                title: meta.name,
                year: new Date().getFullYear().toString(),
                website: "https://opendaw.studio"
            }, MetaDataSchema)))
        dialog.terminate()
        if (status === "rejected") {
            return RuntimeNotifier.info({headline: "Export Error", message: String(error)})
        } else {
            const approved = await RuntimeNotifier.approve({
                headline: "Save DawProject?",
                message: "",
                approveText: "Save"
            })
            if (!approved) {return}
            const {status, error} = await Promises.tryCatch(Files.save(zip,
                {types: [FilePickerAcceptTypes.DawprojectFileType]}))
            if (status === "rejected" && !Errors.isAbort(error)) {
                throw error
            } else {
                return
            }
        }
    }
}
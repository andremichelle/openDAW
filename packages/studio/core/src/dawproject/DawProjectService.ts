import {Errors, isDefined, Option, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {Xml} from "@opendaw/lib-xml"
import {MetaDataSchema} from "@opendaw/lib-dawproject"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {DawProjectImport} from "./DawProjectImporter"
import {DawProjectExporter} from "./DawProjectExporter"
import {ProjectProfile} from "../project"
import {SampleService, SampleStorage} from "../samples"

export class DawProjectService {
    static readonly MaxListedIssues = 12

    static reportIssues(headline: string, issues: ReadonlyArray<string>): Promise<void> {
        if (issues.length === 0) {return Promise.resolve()}
        const listed = issues.slice(0, DawProjectService.MaxListedIssues).map(issue => `• ${issue}`)
        const more = issues.length - listed.length
        return RuntimeNotifier.info({
            headline,
            message: [...listed, ...(more > 0 ? [`… and ${more} more.`] : [])].join("\n")
        })
    }

    static async importDawproject(sampleService: SampleService,
                                  options: DawProjectImport.Options = {}): Promise<Option<ProjectSkeleton>> {
        const {status, value, error} =
            await Promises.tryCatch(Files.open({types: [FilePickerAcceptTypes.DawprojectFileType]}))
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return Option.None}
            return panic(String(error))
        }
        const file = value.at(0)
        if (!isDefined(file)) {return Option.None}
        const arrayBuffer = await file.arrayBuffer()
        const decoded = await Promises.tryCatch(DawProject.decode(arrayBuffer))
        if (decoded.status === "rejected") {
            console.warn(decoded.error)
            await RuntimeNotifier.info({headline: "Import Error", message: `The file could not be read: ${decoded.error}`})
            return Option.None
        }
        const {project: projectSchema, resources, issues: readIssues} = decoded.value
        const importResult = await Promises.tryCatch(DawProjectImport.read(projectSchema, resources, options))
        if (importResult.status === "rejected") {
            console.warn(importResult.error)
            await RuntimeNotifier.info({headline: "Import Error", message: `The project could not be imported: ${importResult.error}`})
            return Option.None
        }
        const {skeleton, audioIds, issues} = importResult.value
        // a sample that is already in the library stays as it is
        await Promise.all(audioIds.map(async uuid => {
            if (await SampleStorage.get().exists(uuid)) {return}
            const resource = resources.fromUUID(uuid)
            await sampleService.importFile({uuid: resource.uuid, name: resource.name, arrayBuffer: resource.buffer})
        }))
        await DawProjectService.reportIssues("Imported with changes", [...readIssues, ...issues])
        return Option.wrap(skeleton)
    }

    static async exportDawproject(profile: ProjectProfile, options: DawProjectExporter.Options = {}): Promise<void> {
        const dialog = RuntimeNotifier.progress({headline: "Exporting DawProject..."})
        const {project, meta} = profile
        const {status, error, value} = await Promises.tryCatch(
            DawProject.encodeWithReport(project.skeleton, project.sampleManager, Xml.element({
                title: meta.name,
                year: new Date().getFullYear().toString(),
                website: "https://opendaw.studio"
            }, MetaDataSchema), options))
        dialog.terminate()
        if (status === "rejected") {
            return RuntimeNotifier.info({headline: "Export Error", message: String(error)})
        }
        const saveResult = await Promises.tryCatch(Files.save(value.buffer,
            {types: [FilePickerAcceptTypes.DawprojectFileType]}))
        if (saveResult.status === "rejected") {
            if (Errors.isAbort(saveResult.error)) {return}
            throw saveResult.error
        }
        await DawProjectService.reportIssues("Exported with changes", value.issues)
    }
}
import {asDefined, isDefined, panic, RuntimeNotifier, tryCatch, UUID} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {FileReferenceSchema, MetaDataSchema, ProjectSchema} from "@opendaw/lib-dawproject"
import {ProjectSkeleton, SampleLoader, SampleLoaderManager} from "@opendaw/studio-adapters"
import {DawProjectExporter} from "./DawProjectExporter"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Promises} from "@opendaw/lib-runtime"
import {ExternalLib} from "../ExternalLib"

export namespace DawProject {
    export type Resource = { uuid: UUID.Bytes, path: string, name: string, buffer: ArrayBuffer }

    export interface ResourceProvider {
        fromPath(path: string): Resource
        fromUUID(uuid: UUID.Bytes): Resource
    }

    // samples/<uuid>/<name>.wav keeps the sample's identity, any other file is identified by its content
    const SamplePath = /^samples\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//

    const uuidOf = async (path: string, buffer: ArrayBuffer): Promise<UUID.Bytes> => {
        const match = SamplePath.exec(path)
        const parsed = isDefined(match) ? tryCatch(() => UUID.parse(match[1])) : undefined
        return parsed?.status === "success" ? parsed.value : UUID.sha256(new Uint8Array(buffer).buffer)
    }

    export const decode = async (buffer: ArrayBuffer | Buffer<ArrayBuffer>): Promise<{
        metaData: MetaDataSchema,
        project: ProjectSchema,
        resources: ResourceProvider,
        issues: ReadonlyArray<string>
    }> => {
        const {status, value: JSZip, error} = await ExternalLib.JSZip()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(error)
        }
        const zip = await JSZip.loadAsync(buffer)
        const metaDataXml = await zip.file("metadata.xml")?.async("string")
        const metaData = isDefined(metaDataXml) ? Xml.parse(metaDataXml, MetaDataSchema) : Xml.element({}, MetaDataSchema)
        const projectXml = asDefined(await zip.file("project.xml")?.async("string"), "No project.xml found")
        const {value: project, issues} = Xml.read(projectXml, ProjectSchema)
        const resourceFiles = Object.entries(zip.files).filter(([_, file]) =>
            !file.dir && !file.name.endsWith(".xml"))
        const resources: ReadonlyArray<Resource> =
            await Promise.all(resourceFiles.map(async ([path, file]) => {
                const name = path.substring(path.lastIndexOf("/") + 1)
                const buffer = await file.async("arraybuffer")
                const uuid = await uuidOf(path, buffer)
                return {uuid, path, name, buffer}
            }))
        return {
            metaData, project, issues: issues.map(issue => `Skipped ${issue}`), resources: {
                fromPath: (path: string): Resource => resources
                    .find(resource => resource.path === path) ?? panic("Resource not found"),
                fromUUID: (uuid: UUID.Bytes): Resource => resources
                    .find(resource => UUID.equals(resource.uuid, uuid)) ?? panic("Resource not found")
            }
        }
    }

    export const encode = async (skeleton: ProjectSkeleton,
                                 sampleManager: SampleLoaderManager,
                                 metaData: MetaDataSchema): Promise<ArrayBuffer> =>
        (await encodeWithReport(skeleton, sampleManager, metaData)).buffer

    export const encodeWithReport = async (skeleton: ProjectSkeleton,
                                           sampleManager: SampleLoaderManager,
                                           metaData: MetaDataSchema,
                                           options: DawProjectExporter.Options = {}): Promise<{
        buffer: ArrayBuffer,
        issues: ReadonlyArray<string>
    }> => {
        const {status, value: JSZip, error} = await ExternalLib.JSZip()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(error)
        }
        const zip = new JSZip()
        // loaded samples are leased while the exporter reads them, the exporter reports the others
        const leases = await Promise.all(skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioFileBox)
            .map(box => sampleManager.getOrCreate(box.address.uuid))
            .filter(loader => loader.state.type === "loaded")
            .map(loader => Promises.tryCatch(SampleLoader.acquire(loader))))
        const written = tryCatch(() => DawProjectExporter.writeWithReport(skeleton, sampleManager, {
            write: (path: string, buffer: ArrayBufferLike): FileReferenceSchema => {
                zip.file(path, buffer as ArrayBuffer)
                return Xml.element({path, external: false}, FileReferenceSchema)
            }
        }, options))
        leases.forEach(lease => {if (lease.status === "resolved") {lease.value.terminate()}})
        if (written.status === "failure") {return Promise.reject(written.error)}
        zip.file("metadata.xml", Xml.write(metaData))
        zip.file("project.xml", Xml.write(written.value.project))
        return {buffer: await zip.generateAsync({type: "arraybuffer"}), issues: written.value.issues}
    }
}
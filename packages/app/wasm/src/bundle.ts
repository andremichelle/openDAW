// Decode an openDAW project BUNDLE (.odb) — a JSZip archive holding the project box graph plus its sample (and
// soundfont) assets. Mirrors the studio `ProjectBundle` format: `version` = "1", `uuid` (the project id, binary),
// `project.od` (the box graph), `meta.json`, and `samples/<uuid>/audio.wav` (+ peaks/meta, which the engine
// ignores). This is a PURE decode (no OPFS / no engine) so it is node-testable; the BundlePlayer page writes the
// returned samples into `SampleStorage` and boots the engine on the returned box graph.
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {BoxGraph} from "@opendaw/lib-box"

export type Bundle = {
    version: string
    uuid: UUID.Bytes | null // the project id, or null if the archive omits it
    boxGraph: BoxGraph
    project: ArrayBuffer // the raw `project.od` bytes (a decoded ProjectSkeleton), for re-feeding to an engine
    meta: unknown
    samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}> // extracted audio, keyed by sample uuid
}

const PROJECT_FILE = "project.od" // ProjectPaths.ProjectFile
const META_FILE = "meta.json"    // ProjectPaths.ProjectMetaFile

export const decodeBundle = async (arrayBuffer: ArrayBuffer): Promise<Bundle> => {
    const {default: JSZip} = await import("jszip")
    const zip = await JSZip.loadAsync(arrayBuffer)
    const version = (await zip.file("version")?.async("text")) ?? "0"
    if (version !== "1") {return Promise.reject(new Error(`Unknown bundle version '${version}'`))}
    const uuidFile = zip.file("uuid")
    const uuid = uuidFile === null ? null : UUID.validateBytes(await uuidFile.async("uint8array") as UUID.Bytes)
    const projectFile = zip.file(PROJECT_FILE)
    if (projectFile === null) {return Promise.reject(new Error(`Bundle has no ${PROJECT_FILE}`))}
    const project = await projectFile.async("arraybuffer") as ArrayBuffer
    const {boxGraph} = ProjectSkeleton.decode(project)
    const metaFile = zip.file(META_FILE)
    const meta = metaFile === null ? {} : JSON.parse(await metaFile.async("text"))
    // Extract each `samples/<uuid>/audio.wav`. JSZip's folder().forEach gives paths relative to the folder.
    const samples: Array<{uuid: UUID.Bytes, wav: ArrayBuffer}> = []
    const pending: Array<Promise<void>> = []
    const samplesFolder = zip.folder("samples")
    if (samplesFolder !== null) {
        samplesFolder.forEach((relativePath, file) => {
            if (file.dir || !relativePath.endsWith("/audio.wav")) {return}
            const sampleUuid = UUID.parse(relativePath.slice(0, relativePath.indexOf("/"))) as UUID.Bytes
            pending.push(file.async("arraybuffer").then(wav => {samples.push({uuid: sampleUuid, wav: wav as ArrayBuffer})}))
        })
    }
    await Promise.all(pending)
    return {version, uuid, boxGraph, project, meta, samples}
}

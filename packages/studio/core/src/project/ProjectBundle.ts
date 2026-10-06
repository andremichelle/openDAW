import {asDefined, Exec, isDefined, Option, panic, Progress, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioFileBox, SoundfontFileBox, WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {SampleLoader, SoundfontLoader} from "@opendaw/studio-adapters"
import {Project} from "./Project"
import {ProjectEnv} from "./ProjectEnv"
import {ProjectPaths} from "./ProjectPaths"
import {ProjectProfile} from "./ProjectProfile"
import {Workers} from "../Workers"
import {SampleStorage} from "../samples"
import type JSZip from "jszip"
import {SoundfontStorage} from "../soundfont"
import {ExternalLib} from "../ExternalLib"
import {WclapStorage} from "../wclap/WclapStorage"

export namespace ProjectBundle {
    export const encode = async ({uuid, project, meta, cover}: ProjectProfile,
                                 progress: Progress.Handler): Promise<ArrayBuffer> => {
        const {status, value: JSZip, error} = await ExternalLib.JSZip()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(error)
        }
        const zip = new JSZip()
        zip.file("version", "1")
        zip.file("uuid", uuid, {binary: true})
        zip.file(ProjectPaths.ProjectFile, project.toArrayBuffer() as ArrayBuffer, {binary: true})
        zip.file(ProjectPaths.ProjectMetaFile, JSON.stringify(meta, null, 2))
        cover.ifSome(buffer => zip.file(ProjectPaths.ProjectCoverFile, buffer, {binary: true}))
        const samples = asDefined(zip.folder("samples"), "Could not create folder samples")
        const soundfonts = asDefined(zip.folder("soundfonts"), "Could not create folder soundfonts")
        const audioFileBoxes = project.boxGraph.boxes().filter(box => box instanceof AudioFileBox)
        const soundfontFileBoxes = project.boxGraph.boxes().filter(box => box instanceof SoundfontFileBox)
        const wclaps = asDefined(zip.folder(WclapStorage.Folder), "Could not create folder wclap")
        // locally imported WebCLAP bundles (`opfs:` urls) travel with the project, public urls are re-fetched
        const wclapIds = Array.from(new Set(project.boxGraph.boxes()
            .filter(box => box instanceof WclapDeviceBox || box instanceof WclapInstrumentBox)
            .map(box => box.url.getValue())
            .filter(WclapStorage.isLocal)
            .map(WclapStorage.idOf)))
        const blob = await Promise.all([
            ...wclapIds.map(async id => {
                const folder = asDefined(wclaps.folder(id), "Could not create folder for wclap bundle")
                folder.file(WclapStorage.FileName, await WclapStorage.load(WclapStorage.urlOf(id)), {binary: true})
            }),
            ...audioFileBoxes
                .map(async ({address: {uuid}}, index) => {
                    const loader: SampleLoader = project.sampleManager.getOrCreate(uuid)
                    const folder = asDefined(samples.folder(UUID.toString(uuid)),
                        "Could not create folder for sample")
                    return pipeSampleLoaderInto(loader, folder)
                        .then(() => progress(index / audioFileBoxes.length * 0.75))
                }),
            ...soundfontFileBoxes
                .map(async ({address: {uuid}}, index) => {
                    const loader: SoundfontLoader = project.soundfontManager.getOrCreate(uuid)
                    const folder = asDefined(soundfonts.folder(UUID.toString(uuid)),
                        "Could not create folder for soundfont")
                    return pipeSoundfontLoaderInto(loader, folder)
                        .then(() => progress(index / soundfontFileBoxes.length * 0.75))
                })
        ]).then(() => zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: {level: 6}
        }))
        progress(1.0)
        return blob.arrayBuffer()
    }

    export const decode = async (env: ProjectEnv,
                                 arrayBuffer: ArrayBuffer,
                                 openProfileUUID?: UUID.Bytes): Promise<ProjectProfile> => {
        const {status, value: JSZip, error} = await ExternalLib.JSZip()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(error)
        }
        const zip = await JSZip.loadAsync(arrayBuffer)
        if (await asDefined(zip.file("version")).async("text") !== "1") {
            return panic("Unknown bundle version")
        }
        const bundleUUID = UUID.validateBytes(await asDefined(zip.file("uuid")).async("uint8array"))
        console.debug(UUID.toString(bundleUUID), openProfileUUID ? UUID.toString(openProfileUUID) : "none")
        if (isDefined(openProfileUUID) && UUID.equals(openProfileUUID, bundleUUID)) {
            return panic("Project is already open")
        }
        console.debug("loading samples...")
        const promises: Array<Promise<void>> = []
        const samples = zip.folder("samples")
        if (isDefined(samples)) {
            samples.forEach((path, file) => {
                if (file.dir) {return}
                promises.push(file.async("arraybuffer")
                    .then(arrayBuffer => Workers.Opfs
                        .write(`${SampleStorage.Folder}/${path}`, new Uint8Array(arrayBuffer))))
            })
        }
        const soundfonts = zip.folder("soundfonts")
        if (isDefined(soundfonts)) {
            soundfonts.forEach((path, file) => {
                if (file.dir) {return}
                promises.push(file.async("arraybuffer")
                    .then(arrayBuffer => Workers.Opfs
                        .write(`${SoundfontStorage.Folder}/${path}`, new Uint8Array(arrayBuffer))))
            })
        }
        const wclaps = zip.folder(WclapStorage.Folder)
        if (isDefined(wclaps)) {
            wclaps.forEach((path, file) => {
                if (file.dir) {return}
                promises.push(file.async("arraybuffer")
                    .then(arrayBuffer => Workers.Opfs
                        .write(`${WclapStorage.Folder}/${path}`, new Uint8Array(arrayBuffer))))
            })
        }
        await Promise.all(promises)
        const projectData = await asDefined(zip.file(ProjectPaths.ProjectFile)).async("arraybuffer")
        const project = await Project.loadAnyVersion(env, projectData)
        const meta = JSON.parse(await asDefined(zip.file(ProjectPaths.ProjectMetaFile)).async("text"))
        const coverFile = zip.file(ProjectPaths.ProjectCoverFile)
        const cover: Option<ArrayBuffer> = Option.wrap(await coverFile?.async("arraybuffer"))
        return new ProjectProfile(bundleUUID, project, meta, cover)
    }

    const pipeSampleLoaderInto = async (loader: SampleLoader, zip: JSZip): Promise<void> => {
        const exec: Exec = async () => {
            const path = `${SampleStorage.Folder}/${UUID.toString(loader.uuid)}`
            zip.file("audio.wav", await Workers.Opfs.read(`${path}/audio.wav`), {binary: true})
            zip.file("peaks.bin", await Workers.Opfs.read(`${path}/peaks.bin`), {binary: true})
            zip.file("meta.json", await Workers.Opfs.read(`${path}/meta.json`))
        }
        if (loader.state.type === "loaded") {
            return exec()
        } else {
            return new Promise<void>((resolve, reject) => {
                const subscription = loader.subscribe(state => {
                    if (state.type === "loaded") {
                        resolve()
                        subscription.terminate()
                    } else if (state.type === "error") {
                        reject(new Error(state.reason))
                        subscription.terminate()
                    }
                })
            }).then(() => exec())
        }
    }

    const pipeSoundfontLoaderInto = async (loader: SoundfontLoader, zip: JSZip): Promise<void> => {
        const exec: Exec = async () => {
            const path = `${SoundfontStorage.Folder}/${UUID.toString(loader.uuid)}`
            zip.file("soundfont.sf2", await Workers.Opfs.read(`${path}/soundfont.sf2`), {binary: true})
            zip.file("meta.json", await Workers.Opfs.read(`${path}/meta.json`))
        }
        if (loader.state.type === "loaded") {
            return exec()
        } else {
            return new Promise<void>((resolve, reject) => {
                const subscription = loader.subscribe(state => {
                    if (state.type === "loaded") {
                        resolve()
                        subscription.terminate()
                    } else if (state.type === "error") {
                        reject(new Error(state.reason))
                        subscription.terminate()
                    }
                })
            }).then(() => exec())
        }
    }
}
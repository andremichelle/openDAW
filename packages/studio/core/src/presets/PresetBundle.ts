import {asDefined, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {ExternalLib} from "../ExternalLib"
import {CATEGORIES, PresetMeta} from "./PresetMeta"

export namespace PresetBundle {
    const VERSION = "1"
    const META_PATH = "meta.json"
    const PRESET_PATH = "preset.odp"

    export const encode = async (meta: PresetMeta, data: ArrayBufferLike): Promise<ArrayBuffer> => {
        const {status, value: JSZip, error} = await ExternalLib.JSZip()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(error)
        }
        const zip = new JSZip()
        zip.file("version", VERSION)
        zip.file(META_PATH, JSON.stringify(meta, null, 2))
        zip.file(PRESET_PATH, data as ArrayBuffer, {binary: true})
        const blob = await zip.generateAsync({type: "blob", compression: "DEFLATE", compressionOptions: {level: 6}})
        return blob.arrayBuffer()
    }

    export const decode = async (arrayBuffer: ArrayBuffer): Promise<{ meta: PresetMeta, data: ArrayBuffer }> => {
        const {status, value: JSZip, error} = await ExternalLib.JSZip()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(error)
        }
        const zip = await JSZip.loadAsync(arrayBuffer)
        const version = await asDefined(zip.file("version"), "Not a preset bundle").async("text")
        if (version !== VERSION) {return panic("Unknown bundle version")}
        const meta = JSON.parse(await asDefined(zip.file(META_PATH), "Missing meta.json").async("text")) as PresetMeta
        if (!CATEGORIES.includes(meta.category)) {return panic("Unknown preset category")}
        const data = await asDefined(zip.file(PRESET_PATH), "Missing preset.odp").async("arraybuffer")
        return {meta, data}
    }
}

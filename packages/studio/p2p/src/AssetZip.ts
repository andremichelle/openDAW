import JSZip from "jszip"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleMetaData, SoundfontMetaData} from "@opendaw/studio-adapters"

export type WavDecoder = (buffer: ArrayBuffer) => AudioData

export namespace AssetZip {
    export const packSample = async (wavBytes: ArrayBuffer, meta: SampleMetaData): Promise<ArrayBuffer> => {
        const zip = new JSZip()
        zip.file("audio.wav", wavBytes)
        zip.file("meta.json", JSON.stringify(meta))
        return zip.generateAsync({type: "arraybuffer"})
    }

    export const unpackSample = async (zipBytes: ArrayBuffer, decodeWav: WavDecoder): Promise<[AudioData, SampleMetaData]> => {
        const zip = await JSZip.loadAsync(zipBytes)
        const wavBytes = await zip.file("audio.wav")!.async("arraybuffer")
        const metaJson = await zip.file("meta.json")!.async("string")
        const audioData = decodeWav(wavBytes)
        const meta = SampleMetaData.parse(JSON.parse(metaJson))
        return [audioData, meta]
    }

    export const packSoundfont = async (sf2Bytes: ArrayBuffer, meta: SoundfontMetaData): Promise<ArrayBuffer> => {
        const zip = new JSZip()
        zip.file("soundfont.sf2", sf2Bytes)
        zip.file("meta.json", JSON.stringify(meta))
        return zip.generateAsync({type: "arraybuffer"})
    }

    export const unpackSoundfont = async (zipBytes: ArrayBuffer): Promise<[ArrayBuffer, SoundfontMetaData]> => {
        const zip = await JSZip.loadAsync(zipBytes)
        const sf2Bytes = await zip.file("soundfont.sf2")!.async("arraybuffer")
        const metaJson = await zip.file("meta.json")!.async("string")
        const meta = SoundfontMetaData.parse(JSON.parse(metaJson))
        return [sf2Bytes, meta]
    }
}

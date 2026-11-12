import {Arrays, WeakRefSet} from "@opendaw/lib-std"

export type AudioInfo = {
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
}

export namespace AudioInfo {
    export const of = ({sampleRate, numberOfFrames, numberOfChannels}: AudioInfo): AudioInfo =>
        ({sampleRate, numberOfFrames, numberOfChannels})
}

export type AudioData = AudioInfo & {
    frames: ReadonlyArray<Float32Array<SharedArrayBuffer>>
}

export namespace AudioData {
    const samples = new WeakRefSet<SharedArrayBuffer>()

    export const count = (): number => samples.count()

    export const create = (
        sampleRate: number,
        numberOfFrames: number,
        numberOfChannels: number
    ): AudioData => {
        const bytesPerChannel = numberOfFrames * Float32Array.BYTES_PER_ELEMENT
        const totalBytes = bytesPerChannel * numberOfChannels
        const buffer = new SharedArrayBuffer(totalBytes)
        const frames = Arrays.create(i => new Float32Array(buffer, i * bytesPerChannel, numberOfFrames), numberOfChannels)
        samples.add(buffer)
        return {sampleRate, numberOfFrames, numberOfChannels, frames}
    }
}
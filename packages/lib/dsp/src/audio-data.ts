import {Arrays, WeakRefSet} from "@moises-ai/lib-std"

export type AudioData = {
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
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
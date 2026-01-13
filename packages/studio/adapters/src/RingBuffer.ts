import {Arrays, assert, int, panic, Procedure} from "@moises-ai/lib-std"

declare let document: any

export namespace RingBuffer {
    export interface Config {
        sab: SharedArrayBuffer
        numChunks: int
        numberOfChannels: int
        bufferSize: int
    }

    export interface Writer {write(channels: ReadonlyArray<Float32Array>): void}

    export interface Reader {stop(): void}

    export const reader = ({
                               sab,
                               numChunks,
                               numberOfChannels,
                               bufferSize
                           }: Config, append: Procedure<Array<Float32Array>>): Reader => {
        let running = true
        const pointers = new Int32Array(sab, 0, 2)
        const audio = new Float32Array(sab, 8)
        const planarChunk = new Float32Array(numberOfChannels * bufferSize)
        const canBlock = typeof document === "undefined" // for usage in workers
        const step = () => {
            if (!running) {return}
            let readPtr = Atomics.load(pointers, 1)
            let writePtr = Atomics.load(pointers, 0)
            if (readPtr === writePtr) {
                if (canBlock) {
                    Atomics.wait(pointers, 0, writePtr)
                } else {
                    setTimeout(step, 1)   // non‑blocking poll fallback
                    return
                }
                writePtr = Atomics.load(pointers, 0)
            }
            while (readPtr !== writePtr) {
                const offset = readPtr * numberOfChannels * bufferSize
                planarChunk.set(audio.subarray(offset, offset + numberOfChannels * bufferSize))
                const channels: Array<Float32Array> = []
                for (let channel = 0; channel < numberOfChannels; channel++) {
                    const start = channel * bufferSize
                    const end = start + bufferSize
                    channels.push(planarChunk.slice(start, end))
                }
                readPtr = (readPtr + 1) % numChunks
                Atomics.store(pointers, 1, readPtr)
                if (!running) {return}
                append(channels)
            }
            step()
        }
        step()
        return {stop: () => running = false}
    }

    export const writer = ({sab, numChunks, numberOfChannels, bufferSize}: Config): Writer => {
        const pointers = new Int32Array(sab, 0, 2)
        const audio = new Float32Array(sab, 8)
        return Object.freeze({
            write: (channels: ReadonlyArray<Float32Array>): void => {
                if (channels.length !== numberOfChannels) {
                    // We ignore this. This can happen in the worklet setup phase.
                    return
                }
                for (const channel of channels) {
                    if (channel.length !== bufferSize) {
                        return panic("Each channel buffer must contain 'bufferSize' samples")
                    }
                }
                const writePtr = Atomics.load(pointers, 0)
                const offset = writePtr * numberOfChannels * bufferSize
                channels.forEach((channel, index) => audio.set(channel, offset + index * bufferSize))
                Atomics.store(pointers, 0, (writePtr + 1) % numChunks)
                Atomics.notify(pointers, 0)
            }
        })
    }
}

export const mergeChunkPlanes = (chunks: ReadonlyArray<ReadonlyArray<Float32Array>>,
                                 bufferSize: int,
                                 maxFrames: int = Number.MAX_SAFE_INTEGER): ReadonlyArray<Float32Array> => {
    if (chunks.length === 0) {return Arrays.empty()}
    const numChannels = chunks[0].length
    const numFrames = Math.min(bufferSize * chunks.length, maxFrames)
    return Arrays.create(channelIndex => {
        const outChannel = new Float32Array(numFrames)
        chunks.forEach((recordedChannels, chunkIndex) => {
            if (recordedChannels.length !== numChannels) {return panic()}
            const recordedChannel = recordedChannels[channelIndex]
            assert(recordedChannel.length === bufferSize, "Invalid length")
            const remaining = numFrames - chunkIndex * bufferSize
            assert(remaining > 0, "Invalid remaining")
            outChannel.set(remaining < bufferSize
                ? recordedChannel.slice(0, remaining)
                : recordedChannel, chunkIndex * bufferSize)
        })
        return outChannel
    }, numChannels)
}